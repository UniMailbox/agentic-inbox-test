// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Admin endpoints for per-mailbox provider override (FOLLOWUP-011).
 *
 * The mailbox creation endpoint (`POST /api/v1/mailboxes`) and the
 * mailbox settings endpoint (`PUT /api/v1/mailboxes/:id`) both apply a
 * strict zod schema that excludes the `provider` field. The dedicated
 * endpoints below are the only way to change which provider a single
 * mailbox routes through. The change is audited to
 * `config/mailbox-audit.jsonl` so operators can review who overrode
 * what.
 *
 *   GET    /api/v1/admin/mailboxes/:mailboxId/provider
 *          Returns `{ provider: { type: "brevo" } } | null`.
 *
 *   PATCH  /api/v1/admin/mailboxes/:mailboxId/provider
 *          Body: `{ type: "brevo" | "cloudflare" | null }`.
 *          Setting `type: null` clears the override; the next send
 *          falls back to PROVIDER_CONFIG + DEFAULT_PROVIDER.
 *
 *   DELETE /api/v1/admin/mailboxes/:mailboxId/provider
 *          Convenience for "clear override".
 *
 *   GET    /api/v1/admin/mailboxes/provider-audit?limit=N
 *          Returns the most recent audit log entries (newest first).
 *
 * All routes require the admin role. Mount with `requireAdmin`
 * middleware in `workers/index.ts`.
 */
import type { Context } from "hono";
import { z } from "zod";
import {
	PROVIDERS,
	mailboxProviderOverride,
} from "../providers/registry";
import type { MailboxContext } from "../lib/context";
import type { Env } from "../types";

type AppContext = Context<MailboxContext>;

const MAILBOX_AUDIT_KEY = "config/mailbox-audit.jsonl";

export interface MailboxAuditEntry {
	timestamp: string;
	actor: string;
	action: "set" | "clear";
	mailboxId: string;
	previousType: string | null;
	nextType: string | null;
}

const PatchBody = z.object({
	/** Pass `null` to clear the override. */
	type: z.string().nullable(),
});

/** Read the mailbox's settings JSON. Returns `null` if no record. */
async function readMailbox(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown> | null> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return null;
	try {
		const parsed = (await obj.json()) as Record<string, unknown>;
		return parsed ?? null;
	} catch {
		return null;
	}
}

async function writeMailbox(
	env: Env,
	mailboxId: string,
	settings: Record<string, unknown>,
): Promise<void> {
	await env.BUCKET.put(
		`mailboxes/${mailboxId}.json`,
		JSON.stringify(settings),
	);
}

export async function appendMailboxAuditEntry(
	env: Env,
	entry: MailboxAuditEntry,
): Promise<void> {
	let existing = "";
	try {
		const obj = await env.BUCKET.get(MAILBOX_AUDIT_KEY);
		if (obj) existing = await obj.text();
	} catch (e) {
		console.warn("[providers] mailbox audit read failed:", (e as Error).message);
	}
	const line = JSON.stringify(entry) + "\n";
	await env.BUCKET.put(MAILBOX_AUDIT_KEY, existing + line, {
		httpMetadata: { contentType: "application/x-ndjson" },
	});
}

export async function readMailboxAuditLog(
	env: Env,
	limit = 50,
): Promise<MailboxAuditEntry[]> {
	let text = "";
	try {
		const obj = await env.BUCKET.get(MAILBOX_AUDIT_KEY);
		if (obj) text = await obj.text();
	} catch {
		return [];
	}
	const lines = text.split("\n").filter(Boolean);
	const slice = lines.slice(-limit).reverse();
	const out: MailboxAuditEntry[] = [];
	for (const line of slice) {
		try {
			out.push(JSON.parse(line));
		} catch {
			// skip malformed
		}
	}
	return out;
}

/** GET /api/v1/admin/mailboxes/:mailboxId/provider */
export async function handleMailboxProviderGet(
	c: AppContext,
): Promise<Response> {
	const env = c.env;
	const mailboxId = decodeURIComponent(c.req.param("mailboxId") ?? "");
	if (!mailboxId) return c.json({ error: "mailboxId required" }, 400);
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		return c.json({ error: "Not found" }, 404);
	}
	const settings = await readMailbox(env, mailboxId);
	const type = mailboxProviderOverride(settings as never);
	return c.json({ ok: true, provider: type ? { type } : null });
}

/** PATCH /api/v1/admin/mailboxes/:mailboxId/provider */
export async function handleMailboxProviderPatch(
	c: AppContext,
): Promise<Response> {
	const env = c.env;
	const mailboxId = decodeURIComponent(c.req.param("mailboxId") ?? "");
	if (!mailboxId) return c.json({ error: "mailboxId required" }, 400);

	const body = PatchBody.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) {
		return c.json({ error: "Invalid body", issues: body.error.issues }, 400);
	}

	// Verify the mailbox exists and the requested type is a known provider.
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		return c.json({ error: "Not found" }, 404);
	}
	const nextType = body.data.type;
	if (nextType !== null && !(nextType in PROVIDERS)) {
		return c.json(
			{
				error: `Unknown provider type "${nextType}". Registered: ${Object.keys(PROVIDERS).join(", ")}`,
			},
			400,
		);
	}

	const settings = (await readMailbox(env, mailboxId)) ?? {};
	const previousType = mailboxProviderOverride(settings as never);

	if (nextType === null) {
		// Clear override — remove the `provider` key entirely.
		if (settings.provider) delete settings.provider;
	} else {
		settings.provider = { type: nextType.toLowerCase() };
	}
	await writeMailbox(env, mailboxId, settings);

	const actor = c.var.user?.id ?? "unknown";
	await appendMailboxAuditEntry(env, {
		timestamp: new Date().toISOString(),
		actor,
		action: nextType === null ? "clear" : "set",
		mailboxId,
		previousType,
		nextType: nextType ? nextType.toLowerCase() : null,
	});

	return c.json({
		ok: true,
		provider: nextType ? { type: nextType.toLowerCase() } : null,
	});
}

/** DELETE /api/v1/admin/mailboxes/:mailboxId/provider — alias for clear */
export async function handleMailboxProviderDelete(
	c: AppContext,
): Promise<Response> {
	// Re-use the patch handler with type: null.
	const env = c.env;
	const mailboxId = decodeURIComponent(c.req.param("mailboxId") ?? "");
	if (!mailboxId) return c.json({ error: "mailboxId required" }, 400);
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		return c.json({ error: "Not found" }, 404);
	}

	const settings = (await readMailbox(env, mailboxId)) ?? {};
	const previousType = mailboxProviderOverride(settings as never);
	if (settings.provider) delete settings.provider;
	await writeMailbox(env, mailboxId, settings);

	const actor = c.var.user?.id ?? "unknown";
	await appendMailboxAuditEntry(env, {
		timestamp: new Date().toISOString(),
		actor,
		action: "clear",
		mailboxId,
		previousType,
		nextType: null,
	});

	return c.json({ ok: true, provider: null });
}

/** GET /api/v1/admin/mailboxes/provider-audit?limit=N */
export async function handleMailboxProviderAudit(
	c: AppContext,
): Promise<Response> {
	const env = c.env;
	const url = new URL(c.req.url);
	const limitRaw = url.searchParams.get("limit");
	const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50;
	const entries = await readMailboxAuditLog(env, limit);
	return c.json({ ok: true, entries });
}
