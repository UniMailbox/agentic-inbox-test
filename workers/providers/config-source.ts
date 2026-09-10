// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Config source abstraction for `PROVIDER_CONFIG` (FOLLOWUP-012).
 *
 * The current implementation reads R2 first, then falls back to the env
 * var. Phase 4 introduces a typed `ProviderConfigSource` interface so
 * the registry can swap sources (env / R2 / KV / DO) without changing
 * the resolution logic.
 *
 * The composition chain is:
 *
 *   R2ConfigSource → EnvConfigSource → "default"
 *
 * `CompositeConfigSource` chains an explicit "preferred" source with a
 * fallback; this preserves the v1.1 behavior where R2 wins over env when
 * both are set. If the preferred source throws (e.g. R2 is down), we
 * fall through to the next source rather than breaking sends.
 */
import type { Env } from "../types";

/** Where the active raw config string came from. */
export type ConfigSource = "r2" | "env" | "default";

export interface ConfigLoadResult {
	/** Raw JSON string. `undefined` means no config; treat as `{}`. */
	raw: string | undefined;
	source: ConfigSource;
}

/**
 * Interface every config source implements. `load()` returns either a
 * raw config string with its source label, or `null` when the source
 * has nothing to contribute (the chain moves on to the next source).
 *
 * Implementations MUST NOT throw for a "not found" condition — return
 * null instead. Network / read errors SHOULD be caught and logged
 * inside the implementation so the chain can continue.
 */
export interface ProviderConfigSource {
	readonly name: ConfigSource;
	load(env: Env): Promise<{ raw: string; source: ConfigSource } | null>;
}

/** R2-backed source: reads `config/providers.json`. */
export class R2ConfigSource implements ProviderConfigSource {
	readonly name = "r2" as const;

	constructor(private readonly r2Key: string = "config/providers.json") {}

	async load(env: Env): Promise<{ raw: string; source: "r2" } | null> {
		try {
			const obj = await env.BUCKET.get(this.r2Key);
			if (!obj) return null;
			const text = await obj.text();
			if (text.trim().length === 0) return null;
			return { raw: text, source: "r2" };
		} catch (e) {
			console.warn("[providers] R2 config read failed:", (e as Error).message);
			return null;
		}
	}
}

/** Env-var source: reads `PROVIDER_CONFIG` from the env. */
export class EnvConfigSource implements ProviderConfigSource {
	readonly name = "env" as const;

	async load(env: Env): Promise<{ raw: string; source: "env" } | null> {
		const raw = env.PROVIDER_CONFIG as string | undefined;
		if (!raw || raw.trim().length === 0) return null;
		return { raw, source: "env" };
	}
}

/**
 * Composite: try each source in order, return the first non-null result.
 * If every source returns null, return `default` (no config).
 */
export class CompositeConfigSource implements ProviderConfigSource {
	readonly name: ConfigSource;
	constructor(private readonly sources: ProviderConfigSource[]) {
		// Composite's "name" reports the source that actually answered.
		// We pick the first one for the label; runtime usage reads
		// `.source` from the resolved value, not this label.
		this.name = sources[0]?.name ?? "default";
	}

	async load(
		env: Env,
	): Promise<{ raw: string; source: ConfigSource } | null> {
		for (const s of this.sources) {
			const result = await s.load(env);
			if (result) return result;
		}
		return null;
	}
}

/**
 * Default chain: R2 first, then env. This is the v1.1 behavior and
 * remains the default unless the operator explicitly configures
 * `CONFIG_SOURCE` to swap order.
 */
export const DEFAULT_CONFIG_SOURCES: ProviderConfigSource[] = [
	new R2ConfigSource(),
	new EnvConfigSource(),
];

/**
 * Build a config-source chain from the `CONFIG_SOURCE` env var. Valid
 * values:
 *
 *   - `"r2,env"` (default) — R2 first, then env
 *   - `"env,r2"`           — env first, then R2
 *   - `"env"`              — env only
 *   - `"r2"`               — R2 only
 *
 * Unknown values fall back to the default and log once.
 */
export function buildConfigSourceChain(
	configSourceEnv: string | undefined,
): ProviderConfigSource[] {
	const raw = (configSourceEnv ?? "r2,env").toLowerCase().trim();
	const order = raw.split(",").map((s) => s.trim()).filter(Boolean);
	const valid: ConfigSource[] = ["r2", "env"];
	const unknown = order.filter((o) => !valid.includes(o as ConfigSource));
	if (unknown.length > 0) {
		console.warn(
			`[providers] CONFIG_SOURCE has unknown value(s) [${unknown.join(
				",",
			)}]; falling back to default order r2,env`,
		);
		return DEFAULT_CONFIG_SOURCES;
	}
	if (order.length === 0) return DEFAULT_CONFIG_SOURCES;
	// De-duplicate while preserving order.
	const seen = new Set<string>();
	const deduped = order.filter((o) => {
		if (seen.has(o)) return false;
		seen.add(o);
		return true;
	});
	const sources: ProviderConfigSource[] = [];
	for (const name of deduped) {
		if (name === "r2") sources.push(new R2ConfigSource());
		else if (name === "env") sources.push(new EnvConfigSource());
	}
	return sources;
}

/**
 * Load the current provider config raw string + source, walking the
 * configured source chain. Cheap (one R2 GET or one env var read); the
 * result feeds into `parseProviderConfig()`.
 *
 * Future (FOLLOWUP-012 follow-ups): add `KVConfigSource` and
 * `DOConfigSource` once we need operator UIs that outlive R2 retention.
 */
export async function loadProviderConfigRaw(env: Env): Promise<ConfigLoadResult> {
	const chain = buildConfigSourceChain(env.CONFIG_SOURCE);
	const composite = new CompositeConfigSource(chain);
	const result = await composite.load(env);
	if (result) return result;
	return { raw: undefined, source: "default" };
}

/** R2 key used to store the operator override. Exported for the admin endpoint. */
export function getR2ConfigKey(): string {
	return "config/providers.json";
}

/** Write the R2 config override. Caller is responsible for validation. */
export async function writeR2Config(
	env: Env,
	jsonText: string,
): Promise<void> {
	await env.BUCKET.put(getR2ConfigKey(), jsonText, {
		httpMetadata: { contentType: "application/json" },
	});
}

/** Delete the R2 config override; subsequent reads fall back to env. */
export async function deleteR2Config(env: Env): Promise<void> {
	await env.BUCKET.delete(getR2ConfigKey());
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
