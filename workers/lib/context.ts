// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono context types shared across workers. Keeping these in one file lets
 * route handlers depend on a single, predictable set of `c.var.*` keys.
 */
import type { Env } from "../types";
import type { AccessPayload, User, Role } from "./auth";

// Re-export the auth shapes so consumers can import everything from here.
export type { AccessPayload, User, Role };

/**
 * Outer app context (set by `workers/app.ts`). Stores the verified Access
 * JWT payload; no domain-specific Variables here.
 */
export type AccessContext = {
	Bindings: Env;
	Variables: {
		accessPayload: AccessPayload;
	};
};

/**
 * Authenticated user context. Installed by the `requireUser` middleware
 * once a verified Access payload (or dev `X-Dev-User` header) is present.
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
