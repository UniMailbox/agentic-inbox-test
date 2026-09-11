// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Plan D5: one-shot grants backfill.
 *
 * Pre-D3 the user id was `dev:{email}` (because Plan C's dev-mode default
 * payload used `dev:` prefix). Plan D changed the stable user id to the
 * bare email. This endpoint rewrites R2 grants JSON files in place:
 *
 *   { "dev:foo@bar.com": { ... } } → { "foo@bar.com": { ... } }
 *
 * Admin-only. Default mode is dry-run; pass `{"apply": true}` to commit.
 * Returns counts so a script can verify completion.
 */
import type { Context } from "hono";
import type { MailboxContext } from "../lib/context";
import type { Grant, Grants } from "../lib/grants";

const GRANTS_PREFIX = "grants/";

interface BackfillResult {
	mode: "apply" | "dry-run";
	filesScanned: number;
	filesMigrated: number;
	keysScanned: number;
	keysMigrated: number;
	migrations: Array<{ mailboxId: string; from: string; to: string }>;
}

export async function handleGrantsBackfill(c: Context<MailboxContext>): Promise<Response> {
	const apply = c.req.query("apply") === "true";
	const result: BackfillResult = {
		mode: apply ? "apply" : "dry-run",
		filesScanned: 0,
		filesMigrated: 0,
		keysScanned: 0,
		keysMigrated: 0,
		migrations: [],
	};

	let cursor: string | undefined;
	do {
		const page = await c.env.BUCKET.list({ prefix: GRANTS_PREFIX, cursor });
		for (const obj of page.objects) {
			if (!obj.key.endsWith(".json")) continue;
			result.filesScanned++;
			const data = await c.env.BUCKET.get(obj.key);
			if (!data) continue;
			let parsed: Grants;
			try {
				parsed = (await data.json()) as Grants;
			} catch {
				continue; // Skip malformed; don't fail the whole run.
			}
			if (!parsed?.grants) continue;

			const rewritten: Record<string, Grant> = {};
			let changed = false;
			for (const [key, grant] of Object.entries(parsed.grants)) {
				result.keysScanned++;
				if (key.startsWith("dev:")) {
					const stripped = key.slice(4);
					rewritten[stripped] = grant;
					result.keysMigrated++;
					changed = true;
					result.migrations.push({ mailboxId: parsed.mailboxId, from: key, to: stripped });
				} else {
					rewritten[key] = grant;
				}
			}
			if (changed) {
				result.filesMigrated++;
				if (apply) {
					const newFile: Grants = { ...parsed, grants: rewritten };
					await c.env.BUCKET.put(obj.key, JSON.stringify(newFile));
				}
			}
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return c.json(result);
}