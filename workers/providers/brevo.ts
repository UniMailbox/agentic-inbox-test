// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Brevo (formerly Sendinblue) transactional email provider.
 *
 * Wraps Brevo's v3 SMTP API. Constructed with an API key from
 * `env.BREVO_API_KEY`. The `fetchImpl` parameter lets tests inject a mock
 * fetch implementation; production code uses the global `fetch`.
 *
 * Limits (from Brevo docs):
 *   - 25 MB attachment size per file (we use this for total payload)
 *   - Recommended ≤ 50 recipients per call (we cap at 50 to be safe)
 *   - Custom headers allowed via the `headers` map
 *
 * @see https://developers.brevo.com/reference/sendtransacemail
 * @see https://developers.brevo.com/reference/getaccount
 */

import {
	EmailProviderError,
	EmailProviderConfigError,
	fromEmailString,
	type EmailAddress,
	type EmailAttachment,
	type EmailMessage,
	type EmailProvider,
	type ProviderLimits,
	type SendResult,
	type ValidationResult,
} from "./types";

const BREVO_API_BASE = "https://api.brevo.com/v3";
const BREVO_SEND_PATH = "/smtp/email";
const BREVO_ACCOUNT_PATH = "/account";

/** Brevo transactional API limits. Conservative values from public docs. */
const BREVO_LIMITS: ProviderLimits = {
	maxSize: 25 * 1024 * 1024, // 25 MiB per attachment / message
	maxRecipients: 50,
	maxCustomHeaders: 30,
};

/** Maximum chars of error response body we keep in error meta. */
const MAX_ERROR_BODY_CHARS = 200;

/** Minimal fetch surface so tests can inject a vi.fn() mock. */
export type BrevoFetch = typeof fetch;

export interface BrevoProviderOptions {
	/** Override for the global fetch (testing). */
	fetchImpl?: BrevoFetch;
	/** Override for the API base (testing). Defaults to https://api.brevo.com/v3. */
	baseUrl?: string;
}

interface BrevoErrorBody {
	code?: string;
	message?: string;
	// Brevo may return other fields — keep them out of error messages.
}

interface BrevoSendSuccess {
	messageId: string;
}

export class BrevoEmailProvider implements EmailProvider {
	static readonly name = "brevo";

	readonly name = BrevoEmailProvider.name;

	private readonly apiKey: string;
	private readonly fetchImpl: BrevoFetch;
	private readonly baseUrl: string;

	constructor(apiKey: string | undefined, opts: BrevoProviderOptions = {}) {
		if (!apiKey || typeof apiKey !== "string" || apiKey.length === 0) {
			throw new EmailProviderConfigError(
				BrevoEmailProvider.name,
				"Brevo API key is missing or empty (expected env.BREVO_API_KEY)",
				"BREVO_API_KEY",
			);
		}
		this.apiKey = apiKey;
		this.fetchImpl =
			opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
		this.baseUrl = opts.baseUrl ?? BREVO_API_BASE;
	}

	getLimits(): ProviderLimits {
		return BREVO_LIMITS;
	}

	validateMessage(msg: EmailMessage): ValidationResult {
		const recipients = countRecipients(msg);
		if (recipients > BREVO_LIMITS.maxRecipients) {
			return {
				ok: false,
				reason: `Recipient count ${recipients} exceeds Brevo limit of ${BREVO_LIMITS.maxRecipients}`,
			};
		}

		const customHeaders = msg.headers ? Object.keys(msg.headers).length : 0;
		if (customHeaders > BREVO_LIMITS.maxCustomHeaders) {
			return {
				ok: false,
				reason: `Custom header count ${customHeaders} exceeds Brevo limit of ${BREVO_LIMITS.maxCustomHeaders}`,
			};
		}

		const size = estimateSize(msg);
		if (size > BREVO_LIMITS.maxSize) {
			return {
				ok: false,
				reason: `Estimated payload size ${size} bytes exceeds Brevo limit of ${BREVO_LIMITS.maxSize} bytes`,
			};
		}

		if (!msg.html && !msg.text) {
			return { ok: false, reason: "Email must include either html or text body" };
		}

		// Brevo requires the `sender` to be on its verified-senders list. We
		// already enforce that `from` matches the mailbox upstream, but a
		// defense-in-depth check is harmless.
		const fromEmail = fromEmailString(msg.from);
		if (!fromEmail || !fromEmail.includes("@")) {
			return { ok: false, reason: "Invalid sender address" };
		}

		return { ok: true };
	}

	async send(msg: EmailMessage): Promise<SendResult> {
		const body = buildBrevoPayload(msg);
		const url = `${this.baseUrl}${BREVO_SEND_PATH}`;

		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"api-key": this.apiKey,
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (e) {
			// Network / DNS / TLS error — the request never reached Brevo.
			throw new EmailProviderError(this.name, "Brevo request failed (network error)", {
				code: "network_error",
				cause: e,
			});
		}

		if (!response.ok) {
			const errorMeta = await readErrorBody(response);
			const code = errorMeta.code ?? `HTTP_${response.status}`;
			// FOLLOWUP-010: never include the original message body or full
			// response — only the vendor's `code` and `message` snippet.
			const reason =
				truncate(errorMeta.message, MAX_ERROR_BODY_CHARS) || `HTTP ${response.status}`;
			throw new EmailProviderError(
				this.name,
				`Brevo send failed (${code}): ${reason}`,
				{ code, cause: undefined },
			);
		}

		let data: BrevoSendSuccess;
		try {
			data = (await response.json()) as BrevoSendSuccess;
		} catch (e) {
			// 2xx but unparseable JSON — likely an API change.
			throw new EmailProviderError(
				this.name,
				"Brevo returned a non-JSON success response",
				{ code: "invalid_response", cause: e },
			);
		}

		return {
			messageId: data?.messageId ?? "",
			providerName: this.name,
		};
	}

	/** Hits Brevo's account endpoint to verify the API key is valid. */
	async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
		const url = `${this.baseUrl}${BREVO_ACCOUNT_PATH}`;
		try {
			const response = await this.fetchImpl(url, {
				method: "GET",
				headers: {
					"api-key": this.apiKey,
					Accept: "application/json",
				},
			});
			if (response.ok) return { ok: true };
			return { ok: false, reason: `HTTP ${response.status}` };
		} catch (e) {
			return { ok: false, reason: (e as Error).message };
		}
	}
}

// ── Payload mapping ────────────────────────────────────────────────

function buildBrevoPayload(msg: EmailMessage): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		sender: toBrevoAddress(msg.from),
		to: toBrevoAddressList(msg.to),
		subject: msg.subject,
	};
	if (msg.html) payload.htmlContent = msg.html;
	if (msg.text) payload.textContent = msg.text;
	if (msg.cc) payload.cc = toBrevoAddressList(msg.cc);
	if (msg.bcc) payload.bcc = toBrevoAddressList(msg.bcc);
	if (msg.replyTo) payload.replyTo = toBrevoAddress(msg.replyTo);
	if (msg.headers && Object.keys(msg.headers).length > 0) {
		payload.headers = msg.headers;
	}
	if (msg.attachments && msg.attachments.length > 0) {
		payload.attachment = msg.attachments.map((a) => toBrevoAttachment(a));
	}
	return payload;
}

function toBrevoAddress(
	v: string | EmailAddress,
): { email: string; name?: string } {
	return typeof v === "string"
		? { email: v.toLowerCase() }
		: v.name
			? { email: v.email.toLowerCase(), name: v.name }
			: { email: v.email.toLowerCase() };
}

function toBrevoAddressList(
	v: string | string[],
): { email: string; name?: string }[] {
	const arr = Array.isArray(v) ? v : [v];
	return arr.map((s) => ({ email: s.toLowerCase() }));
}

function toBrevoAttachment(
	a: EmailAttachment,
): { content: string; name: string } {
	return { content: a.content, name: a.filename };
}

async function readErrorBody(response: Response): Promise<BrevoErrorBody> {
	try {
		const text = await response.text();
		if (!text) return {};
		const parsed = JSON.parse(text) as BrevoErrorBody;
		return { code: parsed.code, message: parsed.message };
	} catch {
		return {};
	}
}

function truncate(s: string | undefined, max: number): string {
	if (!s) return "";
	if (s.length <= max) return s;
	return s.slice(0, max) + "…";
}

function countRecipients(msg: EmailMessage): number {
	const n = (v: string | string[] | undefined): number =>
		v == null ? 0 : Array.isArray(v) ? v.length : 1;
	return n(msg.to) + n(msg.cc) + n(msg.bcc);
}

function estimateSize(msg: EmailMessage): number {
	let size = 0;
	size += (msg.subject ?? "").length;
	size += (msg.html ?? "").length;
	size += (msg.text ?? "").length;
	const count = (v: string | string[] | undefined): number =>
		v == null ? 0 : Array.isArray(v) ? v.length : 1;
	size += count(msg.to) * 30;
	size += count(msg.cc) * 30;
	size += count(msg.bcc) * 30;
	if (msg.attachments) {
		for (const att of msg.attachments) {
			size += Math.ceil((att.content.length * 3) / 4);
		}
	}
	if (msg.headers) {
		for (const [k, v] of Object.entries(msg.headers)) {
			size += k.length + v.length + 4;
		}
	}
	return size;
}

// (No re-exports — see `workers/providers/types.ts` for the canonical
// location of shared utilities like `domainFromFrom`.)