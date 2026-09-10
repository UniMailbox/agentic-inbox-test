// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare Email Service provider.
 *
 * Wraps the `send_email` Worker binding. Identical wire format and limits
 * to the original `workers/email-sender.ts` implementation — extracted so
 * the registry can route by domain.
 *
 * Limits reflect Cloudflare Email Service documented caps:
 *   - 5 MiB total payload
 *   - 50 total recipients (to + cc + bcc)
 *   - 20 custom headers
 *
 * @see https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

import {
	EmailProviderError,
	EmailProviderConfigError,
	type EmailMessage,
	type EmailProvider,
	type ProviderLimits,
	type SendResult,
	type ValidationResult,
} from "./types";

/** CF binding surface we use. Minimal subset of the generated SendEmail type. */
export interface CloudflareEmailBinding {
	send(message: Record<string, unknown>): Promise<{ messageId: string }>;
}

/**
 * Hard-coded Cloudflare Email Service limits. Sourced from the public docs;
 * if Cloudflare raises these limits the values here should be updated in lockstep.
 *
 * FUTURE FOLLOWUP-003: threading/transform belongs in a separate method when
 * the registry adds failover.
 */
const CF_LIMITS: ProviderLimits = {
	maxSize: 5 * 1024 * 1024, // 5 MiB
	maxRecipients: 50,
	maxCustomHeaders: 20,
};

export class CloudflareEmailProvider implements EmailProvider {
	static readonly name = "cloudflare";

	readonly name = CloudflareEmailProvider.name;

	constructor(private readonly binding: unknown) {
		if (
			!binding ||
			typeof (binding as CloudflareEmailBinding).send !== "function"
		) {
			throw new EmailProviderConfigError(
				CloudflareEmailProvider.name,
				"Cloudflare Email Service binding is missing or invalid (expected env.EMAIL.send())",
				"EMAIL.send",
			);
		}
	}

	getLimits(): ProviderLimits {
		return CF_LIMITS;
	}

	validateMessage(msg: EmailMessage): ValidationResult {
		const recipients = countRecipients(msg);
		if (recipients > CF_LIMITS.maxRecipients) {
			return {
				ok: false,
				reason: `Recipient count ${recipients} exceeds Cloudflare limit of ${CF_LIMITS.maxRecipients}`,
			};
		}

		const customHeaders = msg.headers ? Object.keys(msg.headers).length : 0;
		if (customHeaders > CF_LIMITS.maxCustomHeaders) {
			return {
				ok: false,
				reason: `Custom header count ${customHeaders} exceeds Cloudflare limit of ${CF_LIMITS.maxCustomHeaders}`,
			};
		}

		const size = estimateSize(msg);
		if (size > CF_LIMITS.maxSize) {
			return {
				ok: false,
				reason: `Estimated payload size ${size} bytes exceeds Cloudflare limit of ${CF_LIMITS.maxSize} bytes`,
			};
		}

		if (!msg.html && !msg.text) {
			return { ok: false, reason: "Email must include either html or text body" };
		}

		return { ok: true };
	}

	async send(msg: EmailMessage): Promise<SendResult> {
		const wire: Record<string, unknown> = {
			to: msg.to,
			from: msg.from,
			subject: msg.subject,
		};
		if (msg.html) wire.html = msg.html;
		if (msg.text) wire.text = msg.text;
		if (msg.cc) wire.cc = msg.cc;
		if (msg.bcc) wire.bcc = msg.bcc;
		if (msg.replyTo) wire.replyTo = msg.replyTo;
		if (msg.headers && Object.keys(msg.headers).length > 0) {
			wire.headers = msg.headers;
		}
		if (msg.attachments && msg.attachments.length > 0) {
			wire.attachments = msg.attachments.map((a) => ({
				content: a.content,
				filename: a.filename,
				type: a.type,
				disposition: a.disposition,
				...(a.contentId ? { contentId: a.contentId } : {}),
			}));
		}

		try {
			const binding = this.binding as CloudflareEmailBinding;
			const result = await binding.send(wire);
			return {
				messageId: result?.messageId ?? "",
				providerName: this.name,
			};
		} catch (e) {
			// FOLLOWUP-010: never include request body, response body, or secrets
			// in error messages. CF binding errors expose a numeric status on
			// the .status field; we surface that plus the error name only.
			const cause = e as { status?: number; name?: string; message?: string };
			const status = typeof cause.status === "number" ? cause.status : undefined;
			const code = status ? `HTTP_${status}` : "send_failed";
			throw new EmailProviderError(
				this.name,
				`Cloudflare send failed (${code})`,
				{ code, cause: e },
			);
		}
	}

	/** Liveness probe for the binding — non-I/O check only. */
	async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
		try {
			if (
				this.binding &&
				typeof (this.binding as CloudflareEmailBinding).send === "function"
			) {
				return { ok: true };
			}
			return { ok: false, reason: "binding.send is not a function" };
		} catch (e) {
			return { ok: false, reason: (e as Error).message };
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function countRecipients(msg: EmailMessage): number {
	const n = (v: string | string[] | undefined): number =>
		v == null ? 0 : Array.isArray(v) ? v.length : 1;
	return n(msg.to) + n(msg.cc) + n(msg.bcc);
}

/**
 * Rough size estimate. We don't decode base64 attachments (cheap-but-slow);
 * approximate by treating them as 4/3 the encoded length. Good enough for
 * preflight — providers report exact limits on rejection.
 */
function estimateSize(msg: EmailMessage): number {
	let size = 0;
	size += (msg.subject ?? "").length;
	size += (msg.html ?? "").length;
	size += (msg.text ?? "").length;
	const count = (v: string | string[] | undefined): number =>
		v == null ? 0 : Array.isArray(v) ? v.length : 1;
	size += count(msg.to) * 30; // typical address ~30 bytes
	size += count(msg.cc) * 30;
	size += count(msg.bcc) * 30;
	if (msg.attachments) {
		for (const att of msg.attachments) {
			// base64 → 3/4 ratio
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