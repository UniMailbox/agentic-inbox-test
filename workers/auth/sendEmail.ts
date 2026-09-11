// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resend-backed transactional email for better-auth hooks
 * (email verification + password reset).
 *
 * In dev, when RESEND_API_KEY is missing or set to "dev", we console.log
 * the message instead of sending it; the URL is printed so the developer
 * can click it. Otherwise we POST to https://api.resend.com/emails.
 *
 * Callers MUST wrap the invocation in `c.executionCtx.waitUntil(...)`
 * (better-auth itself does not) — we return a Promise for that reason.
 */
import type { ExecutionContext } from "@cloudflare/workers-types";

export interface SendEmailArgs {
	to: string;
	subject: string;
	/** Plain-text body. Resend will render alongside the html if both are sent. */
	text: string;
	/** Optional HTML body. */
	html?: string;
}

export interface SendEmailEnv {
	RESEND_API_KEY?: string;
	EMAIL_FROM?: string;
}

export async function sendEmail(
	env: SendEmailEnv,
	execCtx: ExecutionContext | undefined,
	args: SendEmailArgs,
): Promise<void> {
	const from = env.EMAIL_FROM ?? "no-reply@example.com";
	const apiKey = env.RESEND_API_KEY;

	if (!apiKey || apiKey === "dev") {
		// Dev fallback: print to logs so the developer can find the verification
		// URL in `wrangler dev` output. Mirrors the import.meta.env.DEV pattern
		// the rest of the codebase uses.
		console.log(
			`[sendEmail dev] to=${args.to}\n  subject=${args.subject}\n  body=\n${args.text}`,
		);
		return;
	}

	const payload = {
		from,
		to: [args.to],
		subject: args.subject,
		text: args.text,
		html: args.html,
	};

	const send = async () => {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
		}
	};

	// Either run now (no execCtx — e.g. tests) or hand off to the runtime so
	// the response isn't delayed by the network round-trip.
	if (execCtx?.waitUntil) {
		execCtx.waitUntil(send().catch((e) => console.error("[sendEmail]", e)));
	} else {
		await send();
	}
}
