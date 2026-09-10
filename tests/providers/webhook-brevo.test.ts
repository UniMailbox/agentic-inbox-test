// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the Brevo transactional webhook handler (FOLLOWUP-004).
 *
 * Covers:
 *   - HMAC-SHA256 signature verification (timing-safe).
 *   - Rejects requests with missing/invalid signature → 401.
 *   - Maps Brevo event names to internal delivery_status values.
 *   - Persists via MailboxDO.setDeliveryStatus.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleBrevoWebhook,
	hmacSha256Hex,
	verifyBrevoSignature,
} from "../../workers/routes/webhooks-brevo";
import type { Env } from "../../workers/types";

const SECRET = "test-webhook-secret";

function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		BREVO_WEBHOOK_SECRET: SECRET,
		MAILBOX: {
			idFromName: vi.fn(() => "stub-id"),
			get: vi.fn(() => stub),
		} as unknown as Env["MAILBOX"],
		...overrides,
	} as unknown as Env;
}

const stub = {
	setDeliveryStatus: vi.fn(async () => 1),
} as unknown as DurableObjectStub;

function makeCtx(env: Env, body: string, sig: string | null = null) {
	const headers = new Headers();
	if (sig !== null) headers.set("X-Brevo-Signature", sig);
	return {
		env,
		req: {
			header: (n: string) => headers.get(n) ?? undefined,
			text: async () => body,
		},
		json: (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	} as unknown as Parameters<typeof handleBrevoWebhook>[0];
}

beforeEach(() => {
	(stub.setDeliveryStatus as ReturnType<typeof vi.fn>).mockClear();
});

describe("hmacSha256Hex", () => {
	it("produces a 64-char lowercase hex string", async () => {
		const hex = await hmacSha256Hex("key", "data");
		expect(hex).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces different values for different inputs", async () => {
		const a = await hmacSha256Hex("secret", "one");
		const b = await hmacSha256Hex("secret", "two");
		expect(a).not.toBe(b);
	});

	it("is sensitive to secret", async () => {
		const a = await hmacSha256Hex("secret-a", "msg");
		const b = await hmacSha256Hex("secret-b", "msg");
		expect(a).not.toBe(b);
	});
});

describe("verifyBrevoSignature", () => {
	it("accepts a valid signature", async () => {
		const body = '{"event":"delivered"}';
		const sig = await hmacSha256Hex(SECRET, body);
		const env = makeEnv();
		const r = await verifyBrevoSignature(env, body, sig);
		expect(r.ok).toBe(true);
	});

	it("rejects when secret is not configured", async () => {
		const env = makeEnv({ BREVO_WEBHOOK_SECRET: undefined });
		const r = await verifyBrevoSignature(env, "{}", "abc");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("BREVO_WEBHOOK_SECRET");
	});

	it("rejects missing signature header", async () => {
		const r = await verifyBrevoSignature(makeEnv(), "{}", null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("missing");
	});

	it("rejects mismatched signature", async () => {
		const r = await verifyBrevoSignature(makeEnv(), "{}", "deadbeef".repeat(8));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("mismatch");
	});

	it("rejects signatures of different length", async () => {
		const r = await verifyBrevoSignature(makeEnv(), "{}", "abc");
		expect(r.ok).toBe(false);
	});
});

describe("handleBrevoWebhook", () => {
	it("returns 401 when signature is invalid", async () => {
		const ctx = makeCtx(makeEnv(), '{"event":"delivered","sender":"a@b.com"}', "bad");
		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(401);
		expect(stub.setDeliveryStatus).not.toHaveBeenCalled();
	});

	it("accepts a delivered event and updates the DO", async () => {
		const body = JSON.stringify({
			event: "delivered",
			sender: "Alice@Example.com",
			messageId: "<abc@example.com>",
			email: "bob@example.com",
		});
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);

		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { ok: boolean; applied: boolean; status: string };
		expect(out.ok).toBe(true);
		expect(out.applied).toBe(true);
		expect(out.status).toBe("delivered");

		// Sender is lowercased to match mailbox id.
		expect(stub.setDeliveryStatus).toHaveBeenCalledWith(
			"abc@example.com",
			expect.objectContaining({
				provider_name: "brevo",
				delivery_status: "delivered",
			}),
		);
	});

	it.each([
		["hard_bounce", "bounced"],
		["soft_bounce", "bounced"],
		["spam", "spam"],
		["deferred", "deferred"],
		["invalid_email", "bounced"],
		["error", "failed"],
		["opened", "opened"],
		["click", "clicked"],
		["request", "accepted"],
	])("maps Brevo event '%s' → delivery_status '%s'", async (event, expected) => {
		const body = JSON.stringify({
			event,
			sender: "a@b.com",
			messageId: `<${event}@example.com>`,
		});
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);

		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { status: string };
		expect(out.status).toBe(expected);
	});

	it("ignores unknown event types with 200 (so Brevo doesn't retry)", async () => {
		const body = JSON.stringify({
			event: "future-event-type",
			sender: "a@b.com",
			messageId: "<x@y.com>",
		});
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);

		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { ignored: boolean };
		expect(out.ignored).toBe(true);
		expect(stub.setDeliveryStatus).not.toHaveBeenCalled();
	});

	it("ignores requests without a messageId", async () => {
		const body = JSON.stringify({
			event: "delivered",
			sender: "a@b.com",
		});
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);

		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { ignored: boolean; reason: string };
		expect(out.ignored).toBe(true);
		expect(out.reason).toContain("messageId");
	});

	it("ignores requests without a sender (no mailbox to update)", async () => {
		const body = JSON.stringify({
			event: "delivered",
			messageId: "<x@y.com>",
		});
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);

		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { ignored: boolean; reason: string };
		expect(out.ignored).toBe(true);
		expect(out.reason).toContain("sender");
	});

	it("returns 400 on malformed JSON", async () => {
		const body = "not-json";
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);
		const res = await handleBrevoWebhook(ctx);
		expect(res.status).toBe(400);
	});

	it("includes the Brevo event metadata in provider_meta", async () => {
		const body = JSON.stringify({
			event: "hard_bounce",
			sender: "a@b.com",
			messageId: "<m@x.com>",
			reason: "Mailbox does not exist",
			date: "2026-01-01T00:00:00Z",
			email: "target@x.com",
		});
		const sig = await hmacSha256Hex(SECRET, body);
		const ctx = makeCtx(makeEnv(), body, sig);
		await handleBrevoWebhook(ctx);

		const call = (stub.setDeliveryStatus as ReturnType<typeof vi.fn>).mock
			.calls[0] as unknown as [string, { provider_meta: string }];
		const meta = JSON.parse(call[1].provider_meta) as Record<string, unknown>;
		expect(meta.event).toBe("hard_bounce");
		expect(meta.reason).toBe("Mailbox does not exist");
	});
});
