// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Canonical DeliveryEvent shape (FOLLOWUP-013).
 *
 * Every provider webhook (Brevo today; SES SNS, Resend, Postmark later)
 * must translate its native event into this shape before the row is
 * updated. Normalizing at the webhook boundary means:
 *
 *   1. The DB column `delivery_status` stays a small enum rather than a
 *      free-form string. UI / queries can index on it.
 *   2. The provider-specific metadata lives in `provider_meta` as JSON
 *      so future fields don't need schema changes.
 *   3. Frontend can subscribe to a single SSE stream (`/api/v1/events`)
 *      that re-emits DeliveryEvent regardless of source.
 *
 * The mapping table for Brevo is in `workers/routes/webhooks-brevo.ts`
 * (`DELIVERY_STATUS_MAP`). For other providers, add a sibling file
 * (e.g. `webhooks-ses.ts`) that constructs a DeliveryEvent and calls
 * the same `MailboxDO.setDeliveryStatus(messageId, ...)` method.
 */

/** Internal delivery-status enum stored in `emails.delivery_status`. */
export type DeliveryStatus =
	| "accepted"
	| "sent"
	| "delivered"
	| "bounced"
	| "spam"
	| "deferred"
	| "failed"
	| "opened"
	| "clicked";

export interface DeliveryEvent {
	/** Which provider reported the event. */
	provider: string;
	/** Our outgoing `Message-ID` header value (the one we sent). */
	messageId: string;
	/** Normalized delivery status. */
	status: DeliveryStatus;
	/** Provider-reported event timestamp (ISO 8601). */
	timestamp?: string;
	/** Recipient email address, when the provider reports it. */
	recipient?: string;
	/** Human-readable reason (e.g. "Mailbox does not exist"). */
	reason?: string;
	/** Original vendor event name (e.g. "hard_bounce") for debugging. */
	rawEvent?: string;
}

/** Build the DB `provider_meta` JSON payload from a DeliveryEvent. */
export function serializeDeliveryEventMeta(
	event: DeliveryEvent,
): string {
	const meta: Record<string, unknown> = {
		event: event.rawEvent ?? event.status,
		recipient: event.recipient ?? null,
		reason: event.reason ?? null,
		date: event.timestamp ?? null,
	};
	return JSON.stringify(meta);
}

/**
 * Build the DB update object from a DeliveryEvent. Pass to
 * `MailboxDO.setDeliveryStatus(messageId, update)`.
 */
export function deliveryEventToUpdate(event: DeliveryEvent): {
	provider_name: string;
	provider_meta: string;
	delivery_status: DeliveryStatus;
} {
	return {
		provider_name: event.provider,
		provider_meta: serializeDeliveryEventMeta(event),
		delivery_status: event.status,
	};
}
