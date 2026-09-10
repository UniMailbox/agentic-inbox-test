// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Admin endpoints for hot-reloading the email-sending provider routing
 * config without redeploying (FOLLOWUP-006).
 *
 *   PUT  /api/v1/admin/providers
 *        Body: `{ config: <PROVIDER_CONFIG JSON string> }`
 *        Validates against `ProviderConfigSchema`, then writes R2
 *        `config/providers.json`. Returns the parsed config + validation
 *        report. Appends an audit log entry.
 *
 *   GET  /api/v1/admin/providers
 *        Returns the active raw config (from R2 if present, otherwise the
 *        env var), its source, and the validation report.
 *
 *   DELETE /api/v1/admin/providers
 *        Removes the R2 override; subsequent reads fall back to env var.
 *
 *   GET  /api/v1/admin/providers/audit
 *        Returns the most recent N audit log entries (newest first).
 *
 * All routes require the admin role. Mount with `requireAdmin` middleware
 * in `workers/index.ts`.
 */
import type { Context } from "hono";
import { z } from "zod";
import {
	ProviderConfigSchema,
} from "../providers/schema";
import {
	loadProviderConfigRaw,
	writeR2Config,
	deleteR2Config,
	appendAuditEntry,
	readAuditLog,
	getR2ConfigKey,
} from "../providers/config-source";
import { validateConfig } from "../providers/registry";
import type { MailboxContext } from "../lib/context";

type AppContext = Context<MailboxContext>;

const PutBody = z.object({
	/** Raw JSON string (the value of `PROVIDER_CONFIG`). */
	config: z.string(),
});

/** PUT /api/v1/admin/providers — write R2 override, append audit log. */
export async function handleProvidersPut(c: AppContext): Promise<Response> {
	const env = c.env;
	const body = PutBody.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) {
		return c.json(
			{ error: "Invalid body", issues: body.error.issues },
			400,
		);
	}
	const raw = body.data.config;

	// Validate the JSON-shape first, then schema. We echo all issues so
	// the operator can see every problem at once.
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return c.json(
			{
				ok: false,
				error: "Config is not valid JSON",
				detail: (e as Error).message,
			},
			400,
		);
	}
	const schema = ProviderConfigSchema.safeParse(parsed);
	if (!schema.success) {
		return c.json(
			{
				ok: false,
				error: "Config failed schema validation",
				issues: schema.error.issues.map((i) => ({
					path: i.path.join("."),
					message: i.message,
				})),
			},
			400,
		);
	}

	// Capture the previous raw so the audit log records before/after.
	const { raw: previousRaw } = await loadProviderConfigRaw(env);

	await writeR2Config(env, raw);

	const actor = c.var.user.id;
	await appendAuditEntry(env, {
		timestamp: new Date().toISOString(),
		actor,
		action: "write",
		previousRaw,
		nextRaw: raw,
	});

	const report = await validateConfig(env);
	return c.json({
		ok: true,
		source: "r2",
		key: getR2ConfigKey(),
		validation: report,
	});
}

/** GET /api/v1/admin/providers — show active config + validation report. */
export async function handleProvidersGet(c: AppContext): Promise<Response> {
	const env = c.env;
	const { raw, source } = await loadProviderConfigRaw(env);
	const report = await validateConfig(env);
	return c.json({
		ok: true,
		source,
		raw: raw ?? "",
		validation: report,
	});
}

/** DELETE /api/v1/admin/providers — drop the R2 override. */
export async function handleProvidersDelete(c: AppContext): Promise<Response> {
	const env = c.env;
	const { raw: previousRaw } = await loadProviderConfigRaw(env);
	await deleteR2Config(env);
	const actor = c.var.user.id;
	await appendAuditEntry(env, {
		timestamp: new Date().toISOString(),
		actor,
		action: "delete",
		previousRaw,
	});
	return c.json({ ok: true, source: "env" });
}

/** GET /api/v1/admin/providers/audit?limit=N — recent audit entries. */
export async function handleProvidersAudit(c: AppContext): Promise<Response> {
	const env = c.env;
	const url = new URL(c.req.url);
	const limitRaw = url.searchParams.get("limit");
	const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50;
	const entries = await readAuditLog(env, limit);
	return c.json({ ok: true, entries });
}
