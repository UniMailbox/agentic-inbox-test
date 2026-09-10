// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Authentication primitives.
 *
 * Phase A (Plan A): extract user identity from the Access JWT, derive the
 * `admin` role from the `ADMIN_EMAILS` wrangler var, expose a Hono middleware
 * that populates `c.var.user`. No persistence yet — Plan B will register
 * users into R2.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";
import type { UserContext } from "./context";
import { ensureUser } from "./users";

export type Role = "admin" | "user";

export interface User {
	/** Stable subject identifier from the Access JWT (used as primary key). */
	id: string;
	email: string;
	name: string;
	role: Role;
}

/** Shape of the relevant fields from a verified Cloudflare Access JWT. */
export interface AccessPayload {
	sub?: string;
	email?: string;
	name?: string;
	[key: string]: unknown;
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

/** Build a User record from an Access payload + env. */
export function userFromPayload(
	payload: AccessPayload | undefined,
	env: Pick<Env, "ADMIN_EMAILS">,
): User | null {
	if (!payload?.sub) return null;
	const email = (payload.email as string | undefined)?.toLowerCase() ?? "";
	const name = (payload.name as string | undefined) ?? email;
	const role: Role = isAdminEmail(email, env) ? "admin" : "user";
	return { id: payload.sub, email, name, role };
}

/** Read the current user from Hono context (set by requireUser). */
export function getUser(c: Context<UserContext>): User {
	return c.var.user;
}

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Hono middleware that requires an authenticated user. Must be installed
 * AFTER the Access JWT middleware that verifies the token and stores the
 * payload at `c.var.accessPayload` (see `workers/app.ts`).
 *
 * In dev mode (`import.meta.env.DEV`), this middleware will also accept an
 * `X-Dev-User` request header so a developer can impersonate a user without
 * running a full Cloudflare Access setup. The header value may be either a
 * plain email ("alice@example.com") or a JSON object string
 * (`{"sub":"...","email":"alice@example.com","name":"Alice"}`).
 */
export const requireUser: MiddlewareHandler<UserContext> = async (c, next) => {
	let payload: AccessPayload | undefined = c.var.accessPayload;

	// Dev fallback: synthesize a payload from X-Dev-User.
	if (!payload && import.meta.env.DEV) {
		const devHeader = c.req.header("x-dev-user");
		if (devHeader) {
			const parsed = parseDevUserHeader(devHeader);
			if (parsed) {
				payload = parsed;
				c.set("accessPayload", payload);
			}
		}
	}

	if (!payload?.sub) {
		return c.text("Unauthenticated", 401);
	}

	const user = userFromPayload(payload, c.env);
	if (!user) return c.text("Invalid user identity", 401);
	c.set("user", user);

	// Persist a UserRecord so admins can see this identity in the registry.
	// Deactivated users are still authenticated but get a 403 below so any
	// later authorization middleware sees an inactive user.
	try {
		const record = await ensureUser(c.env.BUCKET, user);
		if (!record.active) {
			return c.text("Account deactivated", 403);
		}
	} catch (e) {
		// Don't block the request on R2 errors — log and continue.
		console.error("ensureUser failed:", (e as Error).message);
	}

	await next();
};

/** Hono middleware that requires admin role. Builds on requireUser. */
export const requireAdmin: MiddlewareHandler<UserContext> = async (c, next) => {
	if (!c.var.user) return c.text("Unauthenticated", 401);
	if (c.var.user.role !== "admin") return c.text("Forbidden", 403);
	await next();
};

// ── Dev helper ─────────────────────────────────────────────────────

function parseDevUserHeader(header: string): AccessPayload | null {
	const trimmed = header.trim();
	// Try JSON first.
	if (trimmed.startsWith("{")) {
		try {
			const obj = JSON.parse(trimmed);
			if (typeof obj === "object" && obj) return obj as AccessPayload;
		} catch {
			return null;
		}
	}
	// Otherwise treat as a bare email and synthesize a stable sub.
	const email = trimmed.toLowerCase();
	if (!email.includes("@")) return null;
	return {
		sub: `dev:${email}`,
		email,
		name: email.split("@")[0],
	};
}
