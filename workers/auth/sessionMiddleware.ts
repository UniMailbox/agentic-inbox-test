// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Better-auth session middleware (Plan D).
 *
 * Replaces the Cloudflare Access JWT middleware that used to live in
 * `workers/app.ts`. Reads the better-auth session cookie via
 * `auth.api.getSession`, then derives the `User` (id/email/name/role/active)
 * from it and stores it at `c.var.user` for downstream middleware.
 *
 * Anonymous requests are valid (e.g. `/api/auth/sign-in/email`); in that case
 * `c.var.session` is `null` and `c.var.user` is unset. `requireUser` (in
 * `workers/lib/auth.ts`) is what enforces 401 for protected routes.
 *
 * The stable user id (used as the grants key and `X-User-Id` MCP header) is
 * the user's *email*, not the better-auth random user id. This keeps the
 * grants JSON human-readable and stable across password changes.
 */
import type { MiddlewareHandler } from "hono";

import { createAuth } from "./betterAuth";
import type { Role, User } from "../lib/auth";
import type { AccessContext } from "../lib/context";

export const sessionMiddleware: MiddlewareHandler<AccessContext> = async (
	c,
	next,
) => {
	const auth = createAuth(c.env);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });

	if (session?.user) {
		const u = session.user as {
			id: string;
			email: string;
			name: string;
			role?: string;
			active?: boolean;
		};
		// Use email as the stable identifier so admin tooling and grants
		// are human-readable. better-auth's random id is only useful inside
		// the auth tables; nothing outside should see it.
		const user: User = {
			id: u.email.toLowerCase(),
			email: u.email.toLowerCase(),
			name: u.name,
			role: (u.role === "admin" ? "admin" : "user") satisfies Role,
			active: u.active ?? true,
		};
		c.set("user", user);
	}

	c.set("session", session ?? null);
	await next();
};