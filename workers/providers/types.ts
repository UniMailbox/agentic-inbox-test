// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pluggable email-sending provider abstraction.
 *
 * v1 contract:
 *   - `EmailProvider` is the per-vendor adapter interface (e.g. Cloudflare,
 *     Brevo, Resend). Adapters live in `workers/providers/<name>.ts`.
 *   - `sendEmail(env, msg, mailboxSettings?)` in `registry.ts` resolves which
 *     adapter to use for the sender's domain and routes the message there.
 *   - Call sites that previously did `sendEmail(env.EMAIL, msg)` simply change
 *     to `sendEmail(env, msg)` — domain is derived from `msg.from` internally.
 *
 * FUTURE FOLLOWUP items (tracked in plan, not implemented yet):
 *   - FOLLOWUP-003: Threading header abstraction (`provider.transformOutgoing`)
 *   - FOLLOWUP-004: `DeliveryEvent` schema for webhooks
 *   - FOLLOWUP-006: Provider-config source abstraction (R2 / KV)
 *   - FOLLOWUP-013: Unified `DeliveryEvent` for cross-provider webhooks
 *   - FOLLOWUP-016: Provider-name compatibility SLA
 */

// ── Public message shape (the contract callers use) ───────────────

/**
 * RFC 5322-style address: bare address, or `{email, name}` for display.
 * All adapters accept both shapes and serialize per their wire format.
 */
export interface EmailAddress {
	email: string;
	name?: string;
}

/** Outgoing attachment. `content` is base64-encoded. */
export interface EmailAttachment {
	content: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

/**
 * Canonical outgoing message. Adapters map this to their wire format.
 *
 * - `from` MUST match the mailbox email address (enforced upstream via
 *   `validateSender`); adapters may additionally verify against a verified
 *   sender list when applicable (Brevo, SES).
 * - `headers` is a free-form string→string map. Callers should pass standard
 *   RFC 5322 headers here. Threading helpers (`In-Reply-To`, `References`)
 *   belong in `headers` (each adapter handles its own quirks — future work:
 *   - `to`/`cc`/`bcc` accept a single string or array.
 *   - Either `html` or `text` (or both) must be present.
 */
export interface EmailMessage {
	to: string | string[];
	from: string | EmailAddress;
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | EmailAddress;
	attachments?: EmailAttachment[];
	headers?: Record<string, string>;
}

/** Back-compat alias — preserved so legacy imports keep working. */
export type SendEmailParams = EmailMessage;

// ── Result / limits ────────────────────────────────────────────────

/**
 * Per-adapter send result.
 *   - `messageId` is the vendor-assigned ID when available (Brevo `messageId`,
 *     CF binding's `messageId`). Empty string if the vendor doesn't return one.
 *   - `providerName` lets call sites log which adapter served the message.
 *   - `providerMeta` carries any vendor-specific extras (e.g. Brevo request
 *     ID for support). MUST NOT contain secrets, API keys, or message bodies.
 */
export interface SendResult {
	messageId: string;
	providerName: string;
	providerMeta?: Record<string, unknown>;
}

/**
 * Limits enforced via preflight before calling `send`. Each provider declares
 * its own values; the registry calls `validateMessage(msg)` before sending so
 * failure surfaces synchronously to the caller rather than after SENT was
 * already written.
 *
 * FUTURE (FOLLOWUP-003): may also need a `maxCustomHeaders` limit because
 * SES rejects messages with too many `X-SES-*` headers.
 */
export interface ProviderLimits {
	/** Maximum payload size in bytes (after base64 decoding for attachments). */
	maxSize: number;
	/** Maximum number of recipients across to + cc + bcc. */
	maxRecipients: number;
	/** Maximum number of custom headers (anything beyond standard RFC 5322). */
	maxCustomHeaders: number;
}

export interface ValidationResult {
	ok: boolean;
	/** Short, safe-to-log reason — NEVER include the message body. */
	reason?: string;
}

// ── Provider interface ────────────────────────────────────────────

/**
 * Pluggable email-sending adapter.
 *
 * Implementations MUST:
 *   - Set `static readonly name` to a stable, kebab-safe identifier.
 *   - Validate their credentials in the constructor and throw
 *     `EmailProviderConfigError` if configuration is missing or unusable.
 *   - Wrap every internal error in `EmailProviderError` so callers can
 *     distinguish transport errors from config errors.
 *   - Never include request bodies, response bodies, or credentials in error
 *     messages (see FOLLOWUP-010). Status codes and provider error codes are OK.
 *   - Implement `getLimits()` so `validateMessage()` can reject over-limit
 *     messages synchronously (FOLLOWUP-002).
 *
 * Implementations MAY:
 *   - Implement `healthCheck()` to surface vendor-side issues; callers can
 *     call it from a future admin endpoint (FOLLOWUP-004).
 *   - Cache expensive construction state across isolates (BREVO_API_KEY
 *     parsing, etc.).
 */
export interface EmailProvider {
	/** Stable vendor identifier (e.g. `"cloudflare"`, `"brevo"`). Public API. */
	readonly name: string;

	/** Send one message. Resolves with a `SendResult`. */
	send(msg: EmailMessage): Promise<SendResult>;

	/**
	 * Preflight validation. Called by the registry before `send()` to surface
	 * over-limit messages synchronously. MUST NOT perform any network IO.
	 * MUST be safe to call repeatedly with the same input.
	 */
	validateMessage(msg: EmailMessage): ValidationResult;

	/** Return this adapter's send limits for preflight. */
	getLimits(): ProviderLimits;

	/**
	 * Liveness probe. Default impl returns `{ ok: true }` for providers that
	 * cannot introspect their backend. Brevo's adapter overrides this with
	 * `GET /v3/account`; Cloudflare's adapter returns the binding type check.
	 */
	healthCheck?(): Promise<{ ok: boolean; reason?: string }>;
}

// ── Error hierarchy ────────────────────────────────────────────────

/**
 * Runtime error from a provider. Caller should surface it to the user and
 * NOT mark the message as sent (SENT folder write must be reverted or the
 * error returned before SENT is written).
 */
export class EmailProviderError extends Error {
	readonly providerName: string;
	/** Optional vendor-supplied error code (e.g. `"HTTP_401"`, `"invalid_from"`). */
	readonly code?: string;

	constructor(
		providerName: string,
		message: string,
		opts: { code?: string; cause?: unknown } = {},
	) {
		super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = "EmailProviderError";
		this.providerName = providerName;
		this.code = opts.code;
	}
}

/**
 * Configuration / setup error. Thrown by provider constructors when
 * credentials are missing, and by `getProviderForDomain` when the config
 * references an unknown provider type.
 */
export class EmailProviderConfigError extends Error {
	readonly providerName: string;
	/** What was missing or wrong (e.g. `"BREVO_API_KEY"`, `"unknown type"`). */
	readonly missing?: string;

	constructor(providerName: string, message: string, missing?: string) {
		super(message);
		this.name = "EmailProviderConfigError";
		this.providerName = providerName;
		this.missing = missing;
	}
}

// ── Domain normalization (FOLLOWUP-001) ───────────────────────────

/**
 * Normalize a sender domain for provider lookup.
 *
 *  - Lowercases ASCII characters.
 *  - Converts IDN (Unicode) labels to punycode (ACE) so `例え.com` and
 *    `xn--r8jz45g.com` resolve to the same provider.
 *  - Trims surrounding whitespace.
 *  - Returns `null` for:
 *      * empty / whitespace-only input
 *      * IP literals (e.g. `[10.0.0.1]`, `10.0.0.1`) — not valid as a sender
 *        domain for mail purposes and would never appear in `PROVIDER_CONFIG`
 *      * inputs containing characters not allowed in a domain name
 *        (e.g. `example.com<` from a malformed RFC 5322 display name)
 *
 * Designed to match RFC 5891 / RFC 3490 IDN processing. Uses `URL` to
 * leverage the runtime's built-in IDNA; falls back to a manual algorithm if
 * the URL constructor throws on the input.
 */
export function normalizeDomain(rawDomain: string | null | undefined): string | null {
	if (rawDomain == null) return null;
	let s = String(rawDomain).trim().toLowerCase();
	if (!s) return null;

	// Strip a trailing dot (FQDN canonical form) but remember it
	let trailingDot = false;
	if (s.endsWith(".")) {
		s = s.slice(0, -1);
		trailingDot = true;
		if (!s) return null;
	}

	// Reject IP literals (v4 `[10.0.0.1]` or bare, v6 `[::1]`).
	if (s.startsWith("[") && s.endsWith("]")) return null;
	if (/^[0-9.]+$/.test(s) || /^[0-9a-f:]+$/i.test(s)) return null;

	// Reject anything with characters that can never appear in a domain.
	// Allowed: a-z 0-9 - . and (after IDN) punycode xn-- prefix.
	if (!/^[a-z0-9.\-]+$/.test(s)) {
		// Try IDN conversion — Unicode domains contain non-ASCII.
		try {
			const u = new URL(`http://${s}`);
			s = u.hostname.toLowerCase();
		} catch {
			return null;
		}
	}

	// If still has non-ASCII (true IDN), convert to ACE.
	if (/[^\x20-\x7e]/.test(s)) {
		try {
			// Use URL again — browsers/Workerd convert IDN to ACE.
			const u = new URL(`http://${s}`);
			s = u.hostname.toLowerCase();
		} catch {
			return null;
		}
		if (!/^[a-z0-9.\-]+$/.test(s)) return null;
	}

	// Reject bare-hostname / no-dot / starts-or-ends-with-hyphen / empty labels.
	const labels = s.split(".");
	if (labels.length < 2) return null;
	for (const lbl of labels) {
		if (!lbl) return null;
		if (lbl.startsWith("-") || lbl.endsWith("-")) return null;
		if (lbl.length > 63) return null;
	}
	if (s.length > 253) return null;

	return trailingDot ? s + "." : s;
}

/**
 * Extract the sender email from an `EmailMessage.from` field that may be a
 * string or `{ email, name? }`. Returns the lowercased bare email or `null`
 * if missing.
 */
export function fromEmailString(from: string | EmailAddress | undefined | null): string | null {
	if (!from) return null;
	const email = typeof from === "string" ? from : from.email;
	return email ? email.toLowerCase() : null;
}

/** Extract + normalize the domain from a sender address. */
export function domainFromFrom(from: string | EmailAddress | undefined | null): string | null {
	return normalizeDomain(fromEmailString(from)?.split("@")[1] ?? null);
}