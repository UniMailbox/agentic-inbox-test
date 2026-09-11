// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono context types shared across workers. Keeping these in one file lets
 * route handlers depend on a single, predictable set of `c.var.*` keys.
 */
import type { Env } from "../types";
import type { User, Role } from "./auth";

// Re-export the auth shapes so consumers can import everything from here.
export type { User, Role };

/**
 * Session shape as returned by better-auth's `api.getSession`. We use a
 * narrow structural type here (not the full generic `Auth`) so consumers
 * don't pull in better-auth's zod path through their transitive deps.
 */
export interface AppSession {
	session: {
		id: string;
		userId: string;
		expiresAt: Date;
		token: string;
		ipAddress?: string | null;
		userAgent?: string | null;
	};
	user: {
		id: string;
		email: string;
		name: string;
		role?: string;
		active?: boolean;
		emailVerified?: boolean;
		image?: string | null;
		createdAt?: Date;
		updatedAt?: Date;
	};
}

/**
 * Outer app context (set by `workers/app.ts`). Stores the verified
 * better-auth session (if any) and the derived authenticated `User`.
 * Downstream middlewares (`requireUser`, `/mcp` forwarding) read these.
 */
export type AccessContext = {
	Bindings: Env;
	Variables: {
		session: AppSession | null;
		user?: User;
	};
};

/**
 * Authenticated user context. Installed by the `requireUser` middleware
 * after `sessionMiddleware` has populated `c.var.user`.
 */
export type UserContext = AccessContext & {
	Variables: AccessContext["Variables"] & {
		user: User;
	};
};

/**
 * Mailbox-scoped context. Built on top of `UserContext` by `requireMailbox`,
 * which validates that the mailbox exists and (in Plan C) that the current
 * user has the requested permission.
 */
export type MailboxContext = UserContext & {
	Variables: UserContext["Variables"] & {
		mailboxStub: DurableObjectStub<import("../durableObject").MailboxDO>;
	};
};

/** Permission bits checked against grants in Plan C. */
export type Permission = "read" | "write" | "delete" | "manage";