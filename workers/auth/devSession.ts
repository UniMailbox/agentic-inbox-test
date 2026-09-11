// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dev-mode session synthesizer (Plan D).
 *
 * Bypasses better-auth's sign-in flow when running under `wrangler dev`
 * (or any env where `import.meta.env.DEV === true`). Reads the
 * `X-Dev-User` header and:
 *
 *   - if absent, uses a stable default identity `dev@local`
 *   - if a plain email, looks up (or creates) that user in D1
 *   - if JSON, parses `{"email": "...", "name": "...", "role": "..."}`
 *
 * The synthesized session populates `c.var.session` and `c.var.user` so
 * downstream middleware (`requireUser`, `/mcp` forwarding) sees the same
 * shape it would after a real sign-in. Admin role is derived from
 * `ADMIN_EMAILS` (same path as the production bootstrap).
 *
 * The user row is upserted so first-curl is identical to first-sign-up.
 * This is dev-only — there's no production code path that skips better-auth.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { MiddlewareHandler } from "hono";

import { schema } from "./d1Schema";
import { adminEmailSet } from "../lib/auth";
import type { Role, User } from "../lib/auth";
import type { AccessContext, AppSession } from "../lib/context";

const DEV_DEFAULT_EMAIL = "dev@local";
const FAR_FUTURE = new Date(Date.now() + 365 * 24 * 3600 * 1000);

interface DevUserSpec {
	email: string;
	name?: string;
	role?: Role;
}

function parseDevHeader(header: string | undefined): DevUserSpec {
	if (!header) return { email: DEV_DEFAULT_EMAIL };
	const trimmed = header.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as DevUserSpec;
			if (typeof parsed.email === "string" && parsed.email.includes("@")) {
				return { email: parsed.email.toLowerCase(), name: parsed.name, role: parsed.role };
			}
		} catch {
			/* fall through */
		}
	}
	if (trimmed.includes("@")) return { email: trimmed.toLowerCase() };
	return { email: DEV_DEFAULT_EMAIL };
}

async function ensureDevUser(env: AccessContext["Bindings"], spec: DevUserSpec): Promise<User> {
	const email = spec.email.toLowerCase();
	const db = drizzle(env.DB, { schema, casing: "snake_case" });
	const admins = adminEmailSet(env);
	const role: Role = spec.role ?? (admins.has(email) ? "admin" : "user");
	const now = new Date();
	const name = spec.name ?? email.split("@")[0];

	const existing = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, email))
		.get();
	if (existing) {
		return {
			id: email,
			email,
			name,
			role,
			active: true,
		};
	}

	const id = email; // Stable id (matches production convention).
	await db
		.insert(schema.user)
		.values({
			id,
			email,
			emailVerified: true,
			name,
			role,
			active: true,
			twoFactorEnabled: false,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	return { id: email, email, name, role, active: true };
}

function synthesizeSession(email: string, user: User): AppSession {
	return {
		session: {
			id: `dev-${email}`,
			userId: email,
			expiresAt: FAR_FUTURE,
			token: `dev-${email}`,
		},
		user: {
			id: email,
			email,
			name: user.name,
			role: user.role,
			active: true,
			emailVerified: true,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
	};
}

/**
 * Hono middleware that runs ONLY when `import.meta.env.DEV` is true.
 * Mount BEFORE `sessionMiddleware` so it can short-circuit the better-auth
 * roundtrip. Production builds strip this branch entirely.
 */
export const devSessionMiddleware: MiddlewareHandler<AccessContext> = async (
	c,
	next,
) => {
	if (!import.meta.env.DEV) return next();

	const spec = parseDevHeader(c.req.header("x-dev-user"));
	const user = await ensureDevUser(c.env, spec);
	c.set("session", synthesizeSession(spec.email, user));
	c.set("user", user);
	await next();
};