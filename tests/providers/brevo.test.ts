// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for `BrevoEmailProvider` using a mock fetch implementation.
 * Covers the 4 documented branches (2xx, 4xx, 5xx, network error).
 */
import { describe, expect, it, vi } from "vitest";
import { BrevoEmailProvider } from "../../workers/providers/brevo";
import {
	EmailProviderError,
	EmailProviderConfigError,
} from "../../workers/providers/types";

function makeResponse(status: number, body: unknown = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const baseMsg = {
	to: "alice@example.com",
	from: "me@foo.com",
	subject: "Hello",
	html: "<p>hi</p>",
};

describe("BrevoEmailProvider constructor", () => {
	it("throws EmailProviderConfigError when apiKey is missing", () => {
		expect(() => new BrevoEmailProvider(undefined)).toThrow(EmailProviderConfigError);
		expect(() => new BrevoEmailProvider("")).toThrow(EmailProviderConfigError);
		expect(() => new BrevoEmailProvider("   ")).not.toThrow(); // empty-trim not enforced here
	});
});

describe("BrevoEmailProvider.send", () => {
	it("returns the messageId on 2xx", async () => {
		const fetchImpl = vi.fn(async () => makeResponse(200, { messageId: "brevo-123" }));
		const provider = new BrevoEmailProvider("key", { fetchImpl });

		const result = await provider.send(baseMsg);
		expect(result).toEqual({
			messageId: "brevo-123",
			providerName: "brevo",
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("sends the api-key header and the expected payload shape", async () => {
		const fetchImpl = vi.fn(async () => makeResponse(200, { messageId: "ok" }));
		const provider = new BrevoEmailProvider("secret-key", { fetchImpl });

		await provider.send({
			...baseMsg,
			cc: "carol@example.com",
			bcc: ["dan@example.com"],
			replyTo: { email: "reply@foo.com", name: "Reply" },
			headers: { "In-Reply-To": "<abc>" },
			attachments: [
				{ content: "BASE64", filename: "a.pdf", type: "application/pdf", disposition: "attachment" },
			],
		});

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.brevo.com/v3/smtp/email");
		expect(init.method).toBe("POST");
		expect(init.headers["api-key"]).toBe("secret-key");
		expect(init.headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			sender: { email: "me@foo.com" },
			to: [{ email: "alice@example.com" }],
			cc: [{ email: "carol@example.com" }],
			bcc: [{ email: "dan@example.com" }],
			replyTo: { email: "reply@foo.com", name: "Reply" },
			subject: "Hello",
			htmlContent: "<p>hi</p>",
			headers: { "In-Reply-To": "<abc>" },
			attachment: [{ content: "BASE64", name: "a.pdf" }],
		});
	});

	it("throws EmailProviderError on 4xx with code + truncated reason", async () => {
		const long = "x".repeat(500);
		const fetchImpl = vi.fn(async () =>
			makeResponse(401, { code: "unauthorized", message: long }),
		);
		const provider = new BrevoEmailProvider("key", { fetchImpl });

		await expect(provider.send(baseMsg)).rejects.toThrowError(
			EmailProviderError,
		);
		await expect(provider.send(baseMsg)).rejects.toMatchObject({
			providerName: "brevo",
			code: "unauthorized",
		});

		// The error message must NOT include the full 500-char body (FOLLOWUP-010).
		try {
			await provider.send(baseMsg);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg.length).toBeLessThan(long.length);
		}
	});

	it("throws EmailProviderError on 5xx with HTTP_<status> code", async () => {
		const fetchImpl = vi.fn(async () => makeResponse(503, { message: "down" }));
		const provider = new BrevoEmailProvider("key", { fetchImpl });

		await expect(provider.send(baseMsg)).rejects.toMatchObject({
			code: "HTTP_503",
			providerName: "brevo",
		});
	});

	it("throws EmailProviderError on network failure (never reaches Brevo)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("fetch failed: ECONNRESET");
		});
		const provider = new BrevoEmailProvider("key", { fetchImpl });

		await expect(provider.send(baseMsg)).rejects.toMatchObject({
			code: "network_error",
		});
	});

	it("throws when 2xx response is not JSON", async () => {
		const fetchImpl = vi.fn(async () => new Response("plain text", { status: 200 }));
		const provider = new BrevoEmailProvider("key", { fetchImpl });

		await expect(provider.send(baseMsg)).rejects.toMatchObject({
			code: "invalid_response",
		});
	});

	it("never includes the api-key or message body in error messages", async () => {
		const fetchImpl = vi.fn(async () =>
			makeResponse(400, { code: "invalid_parameter", message: "bad sender" }),
		);
		const provider = new BrevoEmailProvider("supersecret-key-value", { fetchImpl });

		try {
			await provider.send({
				...baseMsg,
				html: "<p>SECRET BODY CONTENT</p>",
			});
			expect.fail("expected throw");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).not.toContain("supersecret-key-value");
			expect(msg).not.toContain("SECRET BODY CONTENT");
		}
	});
});

describe("BrevoEmailProvider.validateMessage", () => {
	const provider = new BrevoEmailProvider("key");

	it("rejects when neither html nor text is present", () => {
		expect(
			provider.validateMessage({ to: "a@b.com", from: "c@d.com", subject: "x" }),
		).toEqual({ ok: false, reason: expect.stringContaining("html or text") });
	});

	it("rejects when recipient count exceeds limit", () => {
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

	it("rejects when custom header count exceeds limit", () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i < 40; i++) headers[`X-Custom-${i}`] = "v";
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

	it("accepts a normal message", () => {
		expect(
			provider.validateMessage(baseMsg),
		).toEqual({ ok: true });
	});
});

describe("BrevoEmailProvider.healthCheck", () => {
	it("returns ok:true on 200", async () => {
		const fetchImpl = vi.fn(async () => makeResponse(200, { email: "x@y.com" }));
		const provider = new BrevoEmailProvider("key", { fetchImpl });
		await expect(provider.healthCheck()).resolves.toEqual({ ok: true });
	});

	it("returns ok:false on 401", async () => {
		const fetchImpl = vi.fn(async () => makeResponse(401));
		const provider = new BrevoEmailProvider("bad-key", { fetchImpl });
		const result = await provider.healthCheck();
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("401");
	});

	it("returns ok:false on network error", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("ECONNRESET");
		});
		const provider = new BrevoEmailProvider("key", { fetchImpl });
		const result = await provider.healthCheck();
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("ECONNRESET");
	});
});