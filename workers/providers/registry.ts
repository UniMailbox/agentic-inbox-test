// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Provider registry + factory + top-level `sendEmail`.
 *
 * Resolution precedence (highest wins):
 *   1. `mailboxSettings.provider?.type` — per-mailbox override
 *   2. `PROVIDER_CONFIG.domains[domain]` — operator-defined routing
 *   3. `PROVIDER_CONFIG.default` — operator-defined fallback
 *   4. `DEFAULT_PROVIDER` env var — env-defined fallback
 *   5. `"cloudflare"` — hard-coded last-resort (binding is always declared)
 *
 * Caching:
 *   - `instanceCache` is keyed by provider name (a few entries max).
 *   - `domainCache` is keyed by `${providerName}::${domain}` and stores
 *     the resolved provider so we don't re-do precedence on every send.
 *   - Both are module-level; Workers isolates are reused but reset on
 *     deploy. To force a rebuild during dev, call `_resetProviderCaches()`.
 *
 * FUTURE:
 *   - FOLLOWUP-006: admin endpoint to read R2 config source
 *   - FOLLOWUP-007: cache invalidation when env var string changes
 *   - FOLLOWUP-009: eager module-load validation
 */

import {
	EmailProviderConfigError,
	EmailProviderError,
	domainFromFrom,
	type EmailMessage,
	type EmailProvider,
	type SendResult,
} from "./types";
import type { Env } from "../types";
import { CloudflareEmailProvider } from "./cloudflare";
import { BrevoEmailProvider } from "./brevo";

// ── Registry map ───────────────────────────────────────────────────

interface ProviderEntry {
	name: string;
	create(env: Env): EmailProvider;
}

/**
 * v1 registry. To add a new provider:
 *   1. Create `workers/providers/<name>.ts` with `class XProvider implements EmailProvider`.
 *   2. Add one entry below.
 *   3. Add a secret via `wrangler secret put <NAME>_API_KEY` (or equivalent).
 *   4. Re-run `wrangler types` to expose the secret on `Env`.
 */
export const PROVIDERS: Record<string, ProviderEntry> = {
	[CloudflareEmailProvider.name]: {
		name: CloudflareEmailProvider.name,
		create: (env) => new CloudflareEmailProvider(env.EMAIL),
	},
	[BrevoEmailProvider.name]: {
		name: BrevoEmailProvider.name,
		create: (env) => new BrevoEmailProvider(env.BREVO_API_KEY as string | undefined),
	},
};

// ── Per-isolate caches ─────────────────────────────────────────────

/** Lazy-built provider instances. Key = provider name (lowercase). */
const instanceCache = new Map<string, EmailProvider>();

/**
 * Cached `domain → instance`. Key = `${providerName}::${normalizedDomain}`.
 * Stores the resolved provider so we skip both precedence + lookup on repeat.
 */
const domainCache = new Map<string, EmailProvider>();

/** Test-only escape hatch — clears both caches. */
export function _resetProviderCaches(): void {
	instanceCache.clear();
	domainCache.clear();
}

// ── Config parsing ─────────────────────────────────────────────────

/** Parsed shape of `PROVIDER_CONFIG` env var. */
export interface ProviderConfig {
	/** Per-domain routing. Lowercased keys. */
	domains?: Record<string, string>;
	/** Default fallback when domain lookup misses. */
	default?: string;
}

/**
 * Parse the `PROVIDER_CONFIG` env var (JSON). Lowercases all keys.
 * Returns `{}` on missing or malformed input (with a one-time `console.warn`).
 *
 * Malformed handling: surfaces a warning rather than throwing so a single
 * bad config line doesn't break every send. The first time we see the raw
 * string we log; subsequent identical inputs are silent. (The dedup key is
 * the raw string itself — cheap and correct.)
 */
const warnedRawStrings = new Set<string>();
export function parseProviderConfig(raw: string | undefined): ProviderConfig {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		if (!warnedRawStrings.has(raw)) {
			console.warn(
				"[providers] PROVIDER_CONFIG is not valid JSON; ignoring. Raw value:",
				raw.slice(0, 120),
			);
			warnedRawStrings.add(raw);
		}
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const cfg = parsed as ProviderConfig;
	const out: ProviderConfig = {};
	if (cfg.domains && typeof cfg.domains === "object") {
		out.domains = {};
		for (const [k, v] of Object.entries(cfg.domains)) {
			if (typeof v === "string") {
				out.domains[k.toLowerCase()] = v.toLowerCase();
			}
		}
	}
	if (typeof cfg.default === "string") {
		out.default = cfg.default.toLowerCase();
	}
	return out;
}

// ── Mailbox settings ───────────────────────────────────────────────

/**
 * Optional per-mailbox override shape. Read from
 * `mailboxes/{email}.json` → `settings.provider.type`.
 *
 * Restricted by FUTURE FOLLOWUP-011: `POST /api/v1/mailboxes` will reject
 * `provider` inside `settings`; only the dedicated `PATCH` admin endpoint
 * may set it. The lookup here is read-only.
 */
export interface MailboxProviderSettings {
	provider?: { type?: string };
}

/** Return the provider type from a mailbox's settings, or null if unset. */
export function mailboxProviderOverride(
	settings: MailboxProviderSettings | null | undefined,
): string | null {
	const t = settings?.provider?.type;
	return typeof t === "string" && t.length > 0 ? t.toLowerCase() : null;
}

// ── Provider resolution ────────────────────────────────────────────

/**
 * Resolve the provider to use for a given sender domain.
 *
 * Precedence (first match wins):
 *   1. mailbox override (mailboxSettings.provider?.type)
 *   2. PROVIDER_CONFIG.domains[domain]
 *   3. PROVIDER_CONFIG.default
 *   4. DEFAULT_PROVIDER env var
 *   5. "cloudflare" (hard-coded last-resort)
 *
 * Throws `EmailProviderConfigError` if the resolved type isn't registered.
 * Throws `EmailProviderConfigError` if the provider's constructor fails
 * (e.g. missing secret) — that bubbles up to the caller.
 */
export function getProviderForDomain(
	env: Env,
	domain: string,
	mailboxSettings?: MailboxProviderSettings | null,
): EmailProvider {
	const cacheKey = `${domain}`;
	const cached = domainCache.get(cacheKey);
	if (cached) return cached;

	const cfg = parseProviderConfig(env.PROVIDER_CONFIG as string | undefined);

	const mailboxType = mailboxProviderOverride(mailboxSettings);
	const domainType = cfg.domains?.[domain];
	const cfgDefault = cfg.default;
	const envDefault = (env.DEFAULT_PROVIDER as string | undefined)?.toLowerCase();

	const resolvedType =
		mailboxType ?? domainType ?? cfgDefault ?? envDefault ?? "cloudflare";

	if (!resolvedType) {
		// Unreachable in practice — the `??` chain falls back to "cloudflare".
		throw new EmailProviderConfigError(
			"(unknown)",
			"No provider type resolved",
			"DEFAULT_PROVIDER",
		);
	}

	const entry = PROVIDERS[resolvedType];
	if (!entry) {
		throw new EmailProviderConfigError(
			resolvedType,
			`Unknown provider type "${resolvedType}". Registered: ${Object.keys(PROVIDERS).join(", ")}`,
			resolvedType,
		);
	}

	let provider = instanceCache.get(resolvedType);
	if (!provider) {
		provider = entry.create(env);
		instanceCache.set(resolvedType, provider);
	}

	domainCache.set(cacheKey, provider);
	return provider;
}

// ── Top-level sendEmail ────────────────────────────────────────────

/**
 * Send an email through the configured provider for the sender's domain.
 *
 * New signature (Phase 1): `sendEmail(env, msg, mailboxSettings?)`.
 * The previous signature was `sendEmail(env.EMAIL, msg)`; call sites have
 * been updated to pass the whole env and the domain is derived from
 * `msg.from` here.
 *
 * Steps:
 *   1. Normalize + extract the sender domain from `msg.from`.
 *   2. Resolve the provider via `getProviderForDomain`.
 *   3. Run `provider.validateMessage(msg)` — surface over-limit messages
 *      synchronously (FOLLOWUP-002).
 *   4. Call `provider.send(msg)`.
 *
 * Throws `EmailProviderConfigError` or `EmailProviderError`.
 */
export async function sendEmail(
	env: Env,
	msg: EmailMessage,
	mailboxSettings?: MailboxProviderSettings | null,
): Promise<SendResult> {
	const domain = domainFromFrom(msg.from);
	if (!domain) {
		throw new EmailProviderConfigError(
			"(unknown)",
			"Could not derive sender domain from msg.from",
			"from",
		);
	}

	const provider = getProviderForDomain(env, domain, mailboxSettings);

	// Preflight (FOLLOWUP-002). Failure here is an EmailProviderError so
	// call sites can distinguish from config errors.
	const validation = provider.validateMessage(msg);
	if (!validation.ok) {
		throw new EmailProviderError(
			provider.name,
			`Preflight failed for provider "${provider.name}": ${validation.reason ?? "invalid message"}`,
			{ code: "preflight_failed" },
		);
	}

	return provider.send(msg);
}