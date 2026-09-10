// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for `CloudflareEmailProvider.validateMessage` — limit rejection
 * per the Cloudflare Email Service documented caps.
 */
import { describe, expect, it, vi } from "vitest";
import { CloudflareEmailProvider } from "../../workers/providers/cloudflare";

function makeBinding(sendImpl: (msg: unknown) => Promise<unknown>) {
	return { send: vi.fn(sendImpl) };
}

const baseMsg = {
	to: "alice@example.com",
	from: "me@foo.com",
	subject: "Hello",
	html: "<p>hi</p>",
};

describe("CloudflareEmailProvider.validateMessage", () => {
	const binding = makeBinding(async () => ({ messageId: "ok" }));
	const provider = new CloudflareEmailProvider(binding);

	it("rejects when neither html nor text is present", () => {
		expect(
			provider.validateMessage({ to: "a@b.com", from: "c@d.com", subject: "x" }),
		).toEqual({ ok: false, reason: expect.stringContaining("html or text") });
	});

	it("rejects when recipient count exceeds 50", () => {
		const many: string[] = [];
		for (let i = 0; i < 60; i++) many.push(`r${i}@example.com`);
		expect(
			provider.validateMessage({
				to: many,
				from: "me@foo.com",
				subject: "x",
				html: "<p>x</p>",
			}),
		).toEqual({ ok: false, reason: expect.stringContaining("Recipient") });
	});

	it("rejects when custom header count exceeds 20", () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i < 25; i++) headers[`X-Custom-${i}`] = "v";
		expect(
			provider.validateMessage({
				to: "a@b.com",
				from: "me@foo.com",
				subject: "x",
				html: "<p>x</p>",
				headers,
			}),
		).toEqual({ ok: false, reason: expect.stringContaining("header") });
	});

	it("rejects when estimated payload exceeds 5 MiB", () => {
		const huge = "x".repeat(6 * 1024 * 1024);
		expect(
			provider.validateMessage({
				to: "a@b.com",
				from: "me@foo.com",
				subject: "x",
				html: huge,
			}),
		).toEqual({ ok: false, reason: expect.stringContaining("payload size") });
	});

	it("accepts a normal message", () => {
		expect(provider.validateMessage(baseMsg)).toEqual({ ok: true });
	});
});

describe("CloudflareEmailProvider constructor", () => {
	it("throws when binding is missing", () => {
		expect(() => new CloudflareEmailProvider(undefined as unknown as never)).toThrow();
	});

	it("throws when binding has no send method", () => {
		expect(
			() => new CloudflareEmailProvider({} as unknown as never),
		).toThrow();
	});
});

describe("CloudflareEmailProvider.send", () => {
	it("maps EmailMessage to CF wire format and returns the messageId", async () => {
		const send = vi.fn(async () => ({ messageId: "cf-1" }));
		const provider = new CloudflareEmailProvider({ send });

		const result = await provider.send({
			...baseMsg,
			cc: "carol@example.com",
			replyTo: "reply@foo.com",
			headers: { "In-Reply-To": "<abc>" },
		});

		expect(result).toEqual({ messageId: "cf-1", providerName: "cloudflare" });
		expect(send).toHaveBeenCalledOnce();

		const [wire] = send.mock.calls[0];
		expect(wire).toMatchObject({
			to: "alice@example.com",
			from: "me@foo.com",
			subject: "Hello",
			html: "<p>hi</p>",
			cc: "carol@example.com",
			replyTo: "reply@foo.com",
			headers: { "In-Reply-To": "<abc>" },
		});
	});

	it("wraps binding errors in EmailProviderError without leaking the message body", async () => {
		const send = vi.fn(async () => {
			throw Object.assign(new Error("internal"), { status: 500 });
		});
		const provider = new CloudflareEmailProvider({ send });

		try {
			await provider.send({
				...baseMsg,
				html: "<p>SECRET CONTENT</p>",
			});
			expect.fail("expected throw");
		} catch (e) {
			const err = e as Error & { providerName?: string; code?: string };
			expect(err.providerName).toBe("cloudflare");
			expect(err.code).toBe("HTTP_500");
			expect(err.message).not.toContain("SECRET CONTENT");
		}
	});
});