// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * User registry (Plan B).
 *
 * Each authenticated user is materialised into R2 the first time they hit
 * a protected route (`ensureUser`). Admin role is bootstrapped from the
 * `ADMIN_EMAILS` env (set via wrangler vars or secrets) and can be
 * overridden by an admin via the API.
 */
import type { Role, User } from "./auth";

export interface UserRecord {
	id: string;
	email: string;
	name: string;
	role: Role;
	active: boolean;
	createdAt: string;
	lastSeenAt: string;
}

const USERS_PREFIX = "users/";

/** Stable R2 key for a given user sub. */
function userKey(sub: string): string {
	return `${USERS_PREFIX}${sub}.json`;
}

/** List all user records (admin-only API call). */
export async function listUsers(bucket: R2Bucket): Promise<UserRecord[]> {
	const out: UserRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: USERS_PREFIX, cursor });
		for (const obj of page.objects) {
			const data = await bucket.get(obj.key);
			if (!data) continue;
			try {
				out.push((await data.json()) as UserRecord);
			} catch {
				// Skip malformed entries rather than failing the whole list.
			}
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	// Newest sign-in first — admins scan recent activity.
	out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
	return out;
}

/** Fetch a single user by sub. Returns null when not found. */
export async function getUser(
	bucket: R2Bucket,
	sub: string,
): Promise<UserRecord | null> {
	const obj = await bucket.get(userKey(sub));
	if (!obj) return null;
	try {
		return (await obj.json()) as UserRecord;
	} catch {
		return null;
	}
}

/**
 * Idempotent upsert keyed by Access JWT `sub`. Creates the record the first
 * time, refreshes `lastSeenAt` (and the display fields + role) on every
 * call so renames and admin status changes propagate quickly.
 */
export async function ensureUser(
	bucket: R2Bucket,
	user: User,
): Promise<UserRecord> {
	const now = new Date().toISOString();
	const existing = await getUser(bucket, user.id);
	const record: UserRecord = existing
		? {
				...existing,
				email: user.email,
				name: user.name,
				role: user.role, // ADMIN_EMAILS wins over persisted role.
				lastSeenAt: now,
			}
		: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
				active: true,
				createdAt: now,
				lastSeenAt: now,
			};
	await bucket.put(userKey(user.id), JSON.stringify(record));
	return record;
}

/**
 * Promote or demote a user. Throws when an admin tries to demote
 * themselves — the bootstrap list (ADMIN_EMAILS or another admin) must
 * always keep at least one admin around.
 */
export async function setUserRole(
	bucket: R2Bucket,
	sub: string,
	role: Role,
	actorSub: string,
): Promise<UserRecord> {
	const existing = await getUser(bucket, sub);
	if (!existing) {
		throw new Error(`User ${sub} not found`);
	}
	if (sub === actorSub && role !== "admin") {
		throw new Error("Admins cannot demote themselves");
	}
	const updated: UserRecord = { ...existing, role };
	await bucket.put(userKey(sub), JSON.stringify(updated));
	return updated;
}

/** Soft-delete a user (sets active=false). Idempotent. */
export async function deactivateUser(
	bucket: R2Bucket,
	sub: string,
	actorSub: string,
): Promise<UserRecord> {
	const existing = await getUser(bucket, sub);
	if (!existing) {
		throw new Error(`User ${sub} not found`);
	}
	if (sub === actorSub) {
		throw new Error("Admins cannot deactivate themselves");
	}
	const updated: UserRecord = { ...existing, active: false };
	await bucket.put(userKey(sub), JSON.stringify(updated));
	return updated;
}
