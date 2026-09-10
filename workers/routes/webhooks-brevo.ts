// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Brevo transactional webhook handler (FOLLOWUP-004).
 *
 * Brevo sends POST requests to a configured URL when the recipient
 * delivery state changes for a message we sent. Events:
 *
 *   - `request`   (accepted by Brevo) — initial state
 *   - `delivered` (recipient MTA accepted)
 *   - `hard_bounce` / `soft_bounce` / `blocked`
 *   - `spam` / `invalid_email` / `error`
 *   - `deferred` (temporary failure, will retry)
 *   - `opened` / `click` (engagement events)
 *
 * Payload (relevant subset):
 *   {
 *     "event": "delivered" | "hard_bounce" | ...,
 *     "email": "alice@example.com",
 *     "messageId": "<our-outgoing-message-id>",
 *     "reason": "...",
 *     "subject": "...",
 *     "date": "2026-01-01T00:00:00Z",
 *     "tag": "...",
 *     "sender": "me@mydomain.com"
 *   }
 *
 * Webhook authentication: Brevo supports two modes:
 *   1. Shared-secret in the request body (`key` field)
 *   2. HMAC-SHA256 of the body signed with a webhook secret — Brevo
 *      sends the signature in `X-Brevo-Signature` (hex).
 *
 * We implement (2) and verify timing-safely. The secret lives in the
 * env var `BREVO_WEBHOOK_SECRET`. Reject requests missing/invalid
 * signatures with 401.
 *
 * The DO lookup is keyed by `sender` (the from address == mailbox id);
 * we update the email row matching `messageId` with the new delivery
 * status. If no row matches we still return 200 so Brevo doesn't
 * retry — the message is from a different mailbox or already deleted.
 */
import type { Context } from "hono";
import { getMailboxStub } from "../lib/email-helpers";
import type { MailboxContext } from "../lib/context";
import type { Env } from "../types";
import {
	deliveryEventToUpdate,
	type DeliveryStatus,
} from "../webhooks/types";

type AppContext = Context<MailboxContext>;

/**
 * Delivery-status values we store on the email row. The values match
 * the `DeliveryStatus` enum in workers/webhooks/types.ts (FOLLOWUP-013)
 * — this map is the Brevo-specific translation into that schema.
 */
const DELIVERY_STATUS_MAP: Record<string, DeliveryStatus> = {
	request: "accepted",
	delivered: "delivered",
	hard_bounce: "bounced",
	soft_bounce: "bounced",
	blocked: "bounced",
	spam: "spam",
	invalid_email: "bounced",
	error: "failed",
	deferred: "deferred",
	opened: "opened",
	click: "clicked",
};

/** Compute HMAC-SHA256 of `data` with `secret`, hex-encoded. */
export async function hmacSha256Hex(
	secret: string,
	data: string,
): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Constant-time equality check on hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

interface BrevoEvent {
	event?: string;
	email?: string;
	messageId?: string;
	reason?: string;
	date?: string;
	sender?: string;
	[key: string]: unknown;
}

/**
 * Verify Brevo's webhook signature. Reads the raw body, computes
 * HMAC-SHA256 with `BREVO_WEBHOOK_SECRET`, and compares to the
 * `X-Brevo-Signature` header (case-insensitive) timing-safely.
 */
export async function verifyBrevoSignature(
	env: Env,
	rawBody: string,
	signatureHeader: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const secret = env.BREVO_WEBHOOK_SECRET;
	if (!secret) {
		return { ok: false, reason: "BREVO_WEBHOOK_SECRET not configured" };
	}
	if (!signatureHeader) {
		return { ok: false, reason: "missing X-Brevo-Signature" };
	}
	const expected = await hmacSha256Hex(secret, rawBody);
	if (!timingSafeEqualHex(expected, signatureHeader.toLowerCase())) {
		return { ok: false, reason: "signature mismatch" };
	}
	return { ok: true };
}

/** POST /api/v1/webhooks/brevo */
export async function handleBrevoWebhook(c: AppContext): Promise<Response> {
	const env = c.env as Env;

	const rawBody = await c.req.text();
	const sigHeader =
		c.req.header("X-Brevo-Signature") ??
		c.req.header("x-brevo-signature") ??
		null;
	const verified = await verifyBrevoSignature(env, rawBody, sigHeader);
	if (!verified.ok) {
		console.warn("[brevo-webhook] rejected:", verified.reason);
		return c.json({ error: verified.reason }, 401);
	}

	let event: BrevoEvent;
	try {
		event = JSON.parse(rawBody) as BrevoEvent;
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	const status = DELIVERY_STATUS_MAP[event.event ?? ""];
	if (!status) {
		// Unknown event type — accept and noop (return 200 so Brevo doesn't
		// retry, but don't write anything).
		return c.json({ ok: true, ignored: true, event: event.event ?? null });
	}

	const messageId = (event.messageId ?? "").replace(/[<>]/g, "");
	if (!messageId) {
		return c.json({ ok: true, ignored: true, reason: "no messageId" });
	}

	const sender = event.sender;
	if (!sender) {
		// Brevo typically sends sender; without it we can't locate the DO.
		return c.json({ ok: true, ignored: true, reason: "no sender" });
	}

	// FOLLOWUP-013: build a canonical DeliveryEvent, translate to DB
	// update via the shared helper. Future providers (SES, Resend,
	// Postmark) will go through the same shape.
	const update = deliveryEventToUpdate({
		provider: "brevo",
		messageId,
		status,
		timestamp: event.date,
		recipient: event.email,
		reason: event.reason,
		rawEvent: event.event,
	});

	const stub = getMailboxStub(env, sender.toLowerCase());
	const changes = await stub.setDeliveryStatus(messageId, update);

	return c.json({ ok: true, applied: changes > 0, status });
}
