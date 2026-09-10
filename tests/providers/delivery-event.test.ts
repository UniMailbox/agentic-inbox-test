// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the canonical DeliveryEvent schema (FOLLOWUP-013).
 */
import { describe, expect, it } from "vitest";
import {
	deliveryEventToUpdate,
	serializeDeliveryEventMeta,
	type DeliveryEvent,
} from "../../workers/webhooks/types";

const baseEvent: DeliveryEvent = {
	provider: "brevo",
	messageId: "abc@example.com",
	status: "delivered",
	timestamp: "2026-01-01T00:00:00Z",
	recipient: "alice@example.com",
	rawEvent: "delivered",
};

describe("serializeDeliveryEventMeta", () => {
	it("encodes all relevant fields as JSON", () => {
		const json = serializeDeliveryEventMeta(baseEvent);
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(parsed.event).toBe("delivered");
		expect(parsed.recipient).toBe("alice@example.com");
		expect(parsed.date).toBe("2026-01-01T00:00:00Z");
		expect(parsed.reason).toBeNull();
	});

	it("falls back to status when rawEvent is absent", () => {
		const e: DeliveryEvent = { ...baseEvent, rawEvent: undefined };
		const json = serializeDeliveryEventMeta(e);
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(parsed.event).toBe("delivered");
	});

	it("preserves a reason when provided", () => {
		const json = serializeDeliveryEventMeta({
			...baseEvent,
			status: "bounced",
			rawEvent: "hard_bounce",
			reason: "Mailbox does not exist",
		});
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(parsed.reason).toBe("Mailbox does not exist");
	});
});

describe("deliveryEventToUpdate", () => {
	it("returns provider_name, provider_meta, delivery_status", () => {
		const update = deliveryEventToUpdate(baseEvent);
		expect(update.provider_name).toBe("brevo");
		expect(update.delivery_status).toBe("delivered");
		expect(JSON.parse(update.provider_meta)).toMatchObject({
			event: "delivered",
		});
	});

	it("can be passed straight to MailboxDO.setDeliveryStatus", () => {
		const update = deliveryEventToUpdate(baseEvent);
		// Smoke-check the shape matches what setDeliveryStatus accepts.
		expect(Object.keys(update).sort()).toEqual(
			["delivery_status", "provider_meta", "provider_name"].sort(),
		);
	});

	it.each([
		"accepted",
		"sent",
		"delivered",
		"bounced",
		"spam",
		"deferred",
		"failed",
		"opened",
		"clicked",
	])("accepts status '%s'", (s) => {
		const update = deliveryEventToUpdate({ ...baseEvent, status: s as never });
		expect(update.delivery_status).toBe(s);
	});
});
