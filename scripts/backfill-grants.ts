// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One-shot grants backfill (Plan D5).
 *
 * Pre-D3 the user id was `dev:{email}` (Plan C's dev default payload).
 * Plan D changed the stable user id to the bare email. This script
 * migrates existing grants JSON files in R2 by hitting the admin
 * endpoint on a running worker (local dev or production).
 *
 * Usage (with the dev server running, or against production):
 *   npx tsx scripts/backfill-grants.ts                            # dry-run
 *   npx tsx scripts/backfill-grants.ts --apply                    # apply
 *   npx tsx scripts/backfill-grants.ts --apply --base https://inbox.example.com
 *
 * The endpoint is admin-only and idempotent. Default mode is dry-run;
 * pass --apply to commit.
 */
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		apply: { type: "boolean", default: false },
		base: { type: "string", default: "http://localhost:5173" },
	},
	strict: true,
	allowPositionals: false,
});

const apply = args.apply ?? false;
const base = (args.base ?? "http://localhost:5173").replace(/\/$/, "");
const url = `${base}/api/v1/admin/backfill-grants${apply ? "?apply=true" : ""}`;

console.log(`POST ${url}`);
const res = await fetch(url, {
	method: "POST",
	credentials: "include",
	headers: { "Content-Type": "application/json" },
});
const body = (await res.json()) as Record<string, unknown>;
console.log(`status: ${res.status}`);
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);