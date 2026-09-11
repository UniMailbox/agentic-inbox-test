// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Plan D role bootstrap — keeps ADMIN_EMAILS as the source of truth for
 * admin promotion, but only *promotes*, never *demotes*.
 *
 * This is the explicit fix for the Plan C role-clobber bug where `ensureUser`
 * overwrote the persisted role with `ADMIN_EMAILS`-derived role on every
 * request, which made admin role elevation via the API a no-op.
 *
 * Called from two places:
 *  - `databaseHooks.user.create.before` (in workers/auth/betterAuth.ts) at
 *    sign-up — sets initial role from ADMIN_EMAILS.
 *  - `databaseHooks.session.create.after` — re-evaluates on every successful
 *    sign-in. Monotonic, so an admin who is *removed* from ADMIN_EMAILS
 *    keeps admin until an explicit demotion via the admin API.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { schema } from "./d1Schema";
import { adminEmailSet } from "../lib/auth";
import type { Env } from "../types";

export async function ensureAdminRole(
	env: Env,
	email: string | null | undefined,
): Promise<void> {
	if (!email) return;
	const lower = email.toLowerCase();
	if (!adminEmailSet(env).has(lower)) return;

	const db = drizzle(env.DB, { schema, casing: "snake_case" });
	const existing = await db
		.select({ id: schema.user.id, role: schema.user.role })
		.from(schema.user)
		.where(eq(schema.user.email, lower))
		.get();
	if (!existing) return; // Sign-up creates the row; user.create.before set role already.
	if (existing.role === "admin") return; // Monotonic — already admin, do nothing.

	await db
		.update(schema.user)
		.set({ role: "admin", updatedAt: new Date() })
		.where(eq(schema.user.id, existing.id));
}