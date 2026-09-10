// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox grants (Plan C).
 *
 * Each `grants/{mailboxId}.json` file records which users have which
 * permissions for that mailbox. Admins implicitly have every permission
 * for every mailbox and are not stored in the file. The first deploy after
 * enabling this has no grant files — admin must visit `/admin` to assign
 * access; non-admins see an empty mailbox list until they are granted.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Permission, UserContext } from "./context";
import type { User } from "./auth";
import { listMailboxes } from "./email-helpers";

export interface Grant {
	permissions: Permission[];
	grantedBy: string;
	grantedAt: string;
}

export interface Grants {
	mailboxId: string;
	grants: Record<string, Grant>;
}

const GRANTS_PREFIX = "grants/";

/** Stable R2 key for the grants file of a given mailbox. */
function grantsKey(mailboxId: string): string {
	return `${GRANTS_PREFIX}${mailboxId}.json`;
}

/** Fetch the grants for a mailbox. Returns an empty record if none exist. */
export async function getGrants(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<Grants> {
	const obj = await bucket.get(grantsKey(mailboxId));
	if (!obj) {
		return { mailboxId, grants: {} };
	}
	try {
		const parsed = (await obj.json()) as Grants;
		// Defensive: file could be malformed / partial; coerce to a sane shape.
		if (!parsed || typeof parsed !== "object" || !parsed.grants) {
			return { mailboxId, grants: {} };
		}
		return parsed;
	} catch {
		return { mailboxId, grants: {} };
	}
}

/** Replace the full grant set for a mailbox. Actor sub is recorded per grant. */
export async function setGrants(
	bucket: R2Bucket,
	mailboxId: string,
	grants: Record<string, Grant>,
): Promise<Grants> {
	const record: Grants = { mailboxId, grants };
	await bucket.put(grantsKey(mailboxId), JSON.stringify(record));
	return record;
}

/** True when `user` has the given permission on `mailboxId`. Admins always pass. */
export async function hasPermission(
	bucket: R2Bucket,
	user: User,
	mailboxId: string,
	permission: Permission,
): Promise<boolean> {
	if (user.role === "admin") return true;
	const { grants } = await getGrants(bucket, mailboxId);
	const entry = grants[user.id];
	if (!entry) return false;
	// "manage" implies every other bit.
	if (entry.permissions.includes("manage")) return true;
	return entry.permissions.includes(permission);
}

/**
 * List mailbox IDs the user can see. Admin gets all mailboxes; regular
 * users get only those with at least one grant entry for them.
 */
export async function listAccessibleMailboxIds(
	bucket: R2Bucket,
	user: User,
): Promise<string[]> {
	const all = await listMailboxes(bucket);
	if (user.role === "admin") return all.map((m) => m.id);

	const ids: string[] = [];
	for (const m of all) {
		const { grants } = await getGrants(bucket, m.id);
		if (grants[user.id]) ids.push(m.id);
	}
	return ids;
}

/**
 * Hono middleware: ensures the current user has `permission` on the
 * `:mailboxId` route param. 403 otherwise. Skips silently when the param
 * is absent (caller is expected to also run `requireMailbox`).
 */
export const requirePermission = (permission: Permission): MiddlewareHandler<UserContext> =>
	async (c: Context<UserContext>, next) => {
		const rawId = c.req.param("mailboxId");
		if (!rawId) return next();
		const mailboxId = decodeURIComponent(rawId);
		const user = c.var.user;
		const ok = await hasPermission(c.env.BUCKET, user, mailboxId, permission);
		if (!ok) {
			return c.json({ error: "Forbidden" }, 403);
		}
		return next();
	};