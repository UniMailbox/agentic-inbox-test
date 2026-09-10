// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Config source for `PROVIDER_CONFIG`.
 *
 * Lookup order:
 *   1. R2 object `config/providers.json` (operator-managed via admin API)
 *   2. `env.PROVIDER_CONFIG` env var (declarative)
 *   3. None — `raw` is `undefined` and `parseProviderConfig` returns `{}`.
 *
 * The R2 override lets operators change routing without redeploying. The
 * env var remains the canonical source for committed config; R2 is a
 * runtime override layer.
 *
 * @see FOLLOWUP-006
 */
import type { Env } from "../types";

/** Where the active raw config string came from. */
export type ConfigSource = "r2" | "env" | "default";

export interface ConfigLoadResult {
	/** Raw JSON string. `undefined` means no config; treat as `{}`. */
	raw: string | undefined;
	source: ConfigSource;
}

const R2_CONFIG_KEY = "config/providers.json";

/**
 * Load the current provider config raw string + source. Cheap (one R2 GET
 * or one env var read); the result feeds into `parseProviderConfig()`.
 *
 * Future (FOLLOWUP-012): support KV / Durable Object config sources.
 */
export async function loadProviderConfigRaw(env: Env): Promise<ConfigLoadResult> {
	// 1. R2 (operator-managed override)
	try {
		const obj = await env.BUCKET.get(R2_CONFIG_KEY);
		if (obj) {
			const text = await obj.text();
			if (text.trim().length > 0) {
				return { raw: text, source: "r2" };
			}
		}
	} catch (e) {
		// Bucket read failure should not break sending — fall through to env.
		console.warn("[providers] R2 config read failed:", (e as Error).message);
	}

	// 2. Env var
	const envRaw = env.PROVIDER_CONFIG as string | undefined;
	if (envRaw && envRaw.trim().length > 0) {
		return { raw: envRaw, source: "env" };
	}

	return { raw: undefined, source: "default" };
}

/** R2 key used to store the operator override. Exported for the admin endpoint. */
export function getR2ConfigKey(): string {
	return R2_CONFIG_KEY;
}

/** Write the R2 config override. Caller is responsible for validation. */
export async function writeR2Config(
	env: Env,
	jsonText: string,
): Promise<void> {
	await env.BUCKET.put(R2_CONFIG_KEY, jsonText, {
		httpMetadata: { contentType: "application/json" },
	});
}

/** Delete the R2 config override; subsequent reads fall back to env. */
export async function deleteR2Config(env: Env): Promise<void> {
	await env.BUCKET.delete(R2_CONFIG_KEY);
}

// ── Audit log (FOLLOWUP-006) ──────────────────────────────────────

const R2_AUDIT_KEY = "config/audit.jsonl";

export interface ConfigAuditEntry {
	timestamp: string;
	actor: string;
	action: "write" | "delete";
	/** Before/after raw JSON strings, if known. */
	previousRaw?: string;
	nextRaw?: string;
}

/**
 * Append an entry to the audit log. JSONL is append-only; we read the
 * existing blob (if any) and write back with a new line. This is safe for
 * the low-volume admin-action stream; if we ever see contention we'd move
 * to a dedicated DO.
 */
export async function appendAuditEntry(
	env: Env,
	entry: ConfigAuditEntry,
): Promise<void> {
	let existing = "";
	try {
		const obj = await env.BUCKET.get(R2_AUDIT_KEY);
		if (obj) existing = await obj.text();
	} catch (e) {
		console.warn("[providers] Audit log read failed:", (e as Error).message);
	}

	const line = JSON.stringify(entry) + "\n";
	const next = existing + line;
	await env.BUCKET.put(R2_AUDIT_KEY, next, {
		httpMetadata: { contentType: "application/x-ndjson" },
	});
}

/** Read the audit log (for the admin GET endpoint). */
export async function readAuditLog(
	env: Env,
	limit = 50,
): Promise<ConfigAuditEntry[]> {
	let text = "";
	try {
		const obj = await env.BUCKET.get(R2_AUDIT_KEY);
		if (obj) text = await obj.text();
	} catch (e) {
		console.warn("[providers] Audit log read failed:", (e as Error).message);
		return [];
	}
	const lines = text.split("\n").filter(Boolean);
	const slice = lines.slice(-limit).reverse();
	const out: ConfigAuditEntry[] = [];
	for (const line of slice) {
		try {
			out.push(JSON.parse(line));
		} catch {
			// skip malformed
		}
	}
	return out;
}