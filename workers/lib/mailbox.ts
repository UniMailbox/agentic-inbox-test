// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 *
 * Plan C: also enforces that the current user has the requested
 * permission on the mailbox. Defaults to `read` so list/get routes work
 * without extra ceremony. Pass `"write"`, `"delete"`, or `"manage"` to
 * gate mutating routes.
 */
import { createMiddleware } from "hono/factory";
import type { MailboxContext, Permission } from "./context";
import { hasPermission } from "./grants";

export const requireMailbox = (permission: Permission = "read") =>
	createMiddleware<MailboxContext>(async (c, next) => {
		const rawId = c.req.param("mailboxId");
		if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
		const mailboxId = decodeURIComponent(rawId);

		// Verify mailbox exists
		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		// Authorize the caller for this mailbox + permission.
		const ok = await hasPermission(c.env.BUCKET, c.var.user, mailboxId, permission);
		if (!ok) {
			return c.json({ error: "Forbidden" }, 403);
		}

		// Instantiate DO stub
		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

		c.set("mailboxStub", stub);

		await next();
	});