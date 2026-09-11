// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Plan D user registry — backed by Cloudflare D1 (the same store better-auth
 * uses). Replaces the Plan B/C R2 user-record layer in `workers/lib/users.ts`
 * (deleted as part of Plan D).
 *
 * Read/write helpers used by the admin endpoints in `workers/index.ts`.
 * better-auth itself owns sign-up, sign-in, and password reset — admin
 * mutations go through this module.
 *
 * NOTE: identifiers throughout are the user's *email*, matching
 * `c.var.user.id` set by `sessionMiddleware`. The internal better-auth row id
 * (random string) is not exposed to callers.
 */
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { schema } from "./d1Schema";
import type { Role } from "../lib/auth";
import type { Env } from "../types";

export interface AdminUser {
	id: string; // email
	email: string;
	name: string;
	role: Role;
	active: boolean;
	emailVerified: boolean;
	createdAt: string; // ISO
}

function db(env: Env) {
	return drizzle(env.DB, { schema, casing: "snake_case" });
}

function toAdminUser(row: typeof schema.user.$inferSelect): AdminUser {
	return {
		id: row.email.toLowerCase(),
		email: row.email.toLowerCase(),
		name: row.name,
		role: row.role,
		active: row.active,
		emailVerified: row.emailVerified,
		createdAt: row.createdAt.toISOString(),
	};
}

/** List every user in the better-auth `user` table (admin-only API call). */
export async function listUsers(env: Env): Promise<AdminUser[]> {
	const rows = await db(env)
		.select()
		.from(schema.user)
		.orderBy(desc(schema.user.createdAt));
	return rows.map(toAdminUser);
}

/** Fetch a single user by email (the public identifier). Null when absent. */
export async function getUser(env: Env, email: string): Promise<AdminUser | null> {
	const row = await db(env)
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, email.toLowerCase()))
		.get();
	return row ? toAdminUser(row) : null;
}

/**
 * Promote or demote a user. Throws when an admin tries to demote
 * themselves — the bootstrap list (ADMIN_EMAILS or another admin) must
 * always keep at least one admin around.
 *
 * Note: demotion is allowed; `ensureAdminRole` only auto-promotes on
 * sign-in. Removing an email from ADMIN_EMAILS does NOT auto-demote.
 */
export async function setUserRole(
	env: Env,
	email: string,
	role: Role,
	actorEmail: string,
): Promise<AdminUser> {
	if (email.toLowerCase() === actorEmail.toLowerCase() && role !== "admin") {
		throw new Error("Admins cannot demote themselves");
	}
	const updated = await db(env)
		.update(schema.user)
		.set({ role, updatedAt: new Date() })
		.where(eq(schema.user.email, email.toLowerCase()))
		.returning();
	if (!updated.length) {
		throw new Error(`User ${email} not found`);
	}
	return toAdminUser(updated[0]);
}

/** Soft-delete a user (sets active=false). Idempotent. */
export async function deactivateUser(
	env: Env,
	email: string,
	actorEmail: string,
): Promise<AdminUser> {
	if (email.toLowerCase() === actorEmail.toLowerCase()) {
		throw new Error("Admins cannot deactivate themselves");
	}
	const updated = await db(env)
		.update(schema.user)
		.set({ active: false, updatedAt: new Date() })
		.where(eq(schema.user.email, email.toLowerCase()))
		.returning();
	if (!updated.length) {
		throw new Error(`User ${email} not found`);
	}
	return toAdminUser(updated[0]);
}

/** Reactivate a soft-deleted user (sets active=true). */
export async function reactivateUser(
	env: Env,
	email: string,
): Promise<AdminUser> {
	const updated = await db(env)
		.update(schema.user)
		.set({ active: true, updatedAt: new Date() })
		.where(eq(schema.user.email, email.toLowerCase()))
		.returning();
	if (!updated.length) {
		throw new Error(`User ${email} not found`);
	}
	return toAdminUser(updated[0]);
}