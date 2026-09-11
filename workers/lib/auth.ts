// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Authentication primitives (Plan D: better-auth).
 *
 * The outer middleware in `workers/app.ts` (`sessionMiddleware`) loads the
 * better-auth session and populates `c.var.user`. This module owns:
 *  - the `User` shape used across the rest of the codebase
 *  - ADMIN_EMAILS evaluation (still the bootstrap source for admin role)
 *  - the `requireUser` / `requireAdmin` route guards
 *
 * Plan C's JWT decode + R2 user records live in git history; they were
 * replaced by better-auth's D1 schema (`workers/auth/d1Schema.ts`).
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";
import type { UserContext } from "./context";

export type Role = "admin" | "user";

export interface User {
	/**
	 * Stable subject identifier. Plan D: this is the user's email (not the
	 * better-auth random id). Used as the grants key in R2 and as the
	 * `X-User-Id` header for MCP/Agent Durable Objects.
	 */
	id: string;
	email: string;
	name: string;
	role: Role;
	/** Soft-delete flag. Deactivated users get 403 from requireUser. */
	active: boolean;
}

// ── Admin email helpers ────────────────────────────────────────────

/** Parse the `ADMIN_EMAILS` env into a lowercase set. */
export function adminEmailSet(env: Pick<Env, "ADMIN_EMAILS">): Set<string> {
	const raw = (env.ADMIN_EMAILS ?? "") as string | string[];
	if (Array.isArray(raw)) {
		return new Set(raw.map((e) => e.toLowerCase()).filter(Boolean));
	}
	return new Set(
		raw
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
	);
}

/** True when the given email appears in `ADMIN_EMAILS`. */
export function isAdminEmail(
	email: string | undefined,
	env: Pick<Env, "ADMIN_EMAILS">,
): boolean {
	if (!email) return false;
	return adminEmailSet(env).has(email.toLowerCase());
}

/** Read the current user from Hono context (set by requireUser). */
export function getUser(c: Context<UserContext>): User {
	return c.var.user;
}

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Hono middleware that requires an authenticated user. Must be installed
 * AFTER `sessionMiddleware` (see `workers/auth/sessionMiddleware.ts`) which
 * has already loaded the better-auth session and derived `c.var.user`.
 *
 * 401 when there is no session. 403 when the user is deactivated.
 */
export const requireUser: MiddlewareHandler<UserContext> = async (c, next) => {
	const session = c.var.session;
	const user = c.var.user;
	if (!session || !user) {
		return c.text("Unauthenticated", 401);
	}
	if (!user.active) {
		return c.text("Account deactivated", 403);
	}
	await next();
};

/** Hono middleware that requires admin role. Builds on requireUser. */
export const requireAdmin: MiddlewareHandler<UserContext> = async (c, next) => {
	if (!c.var.user) return c.text("Unauthenticated", 401);
	if (c.var.user.role !== "admin") return c.text("Forbidden", 403);
	await next();
};