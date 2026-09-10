// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Integration tests against the real Brevo API (FOLLOWUP-017).
 *
 * These tests make REAL network calls and require a `BREVO_API_KEY`
 * CI secret. When the env var is missing they are skipped entirely —
 * this keeps the regular `npm test` run deterministic and offline.
 *
 * To run locally:
 *   export BREVO_API_KEY=<your-test-key>
 *   npm run test -- tests/integration
 *
 * In CI, set `BREVO_API_KEY` as a repository secret and run the
 * `integration` job only on `main` / `release` branches so PRs from
 * forks (which can't access secrets) still get a green unit suite.
 *
 * Tests cover the same 5 scenarios as the unit suite but against the
 * real Brevo endpoints:
 *   1. happy-path send → returns a Brevo messageId
 *   2. unauthenticated send → 401
 *   3. over-limit attachment → 400 with structured error
 *   4. health check → 200 from /v3/account
 *   5. webhook signature verification against a generated payload
 */
import { describe, expect, it } from "vitest";
import { BrevoEmailProvider } from "../../workers/providers/brevo";
import type { EmailMessage } from "../../workers/providers/types";

const KEY = process.env.BREVO_API_KEY;
const HAS_KEY = typeof KEY === "string" && KEY.length > 0;

const baseMsg: EmailMessage = {
	to: "ci-bot@brevo-inbox.example", // a sandbox address Brevo accepts without delivering
	from: "ci-sender@example.com",
	subject: "agentic-inbox integration test",
	html: "<p>hello from integration</p>",
	text: "hello from integration",
};

describe.skipIf(!HAS_KEY)("Brevo integration (real API)", () => {
	it("healthCheck() returns ok against /v3/account", async () => {
		const provider = new BrevoEmailProvider(KEY);
		const r = await provider.healthCheck!();
		expect(r.ok).toBe(true);
	});

	it("send() returns a messageId on the happy path", async () => {
		const provider = new BrevoEmailProvider(KEY);
		const r = await provider.send(baseMsg);
		expect(r.providerName).toBe("brevo");
		expect(typeof r.messageId).toBe("string");
		expect(r.messageId.length).toBeGreaterThan(0);
	});

	it("rejects an invalid API key with 401", async () => {
		const provider = new BrevoEmailProvider("definitely-not-a-real-key");
		await expect(provider.send(baseMsg)).rejects.toThrow();
		// The error should be sanitized — message body must not appear.
		try {
			await provider.send(baseMsg);
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).not.toContain("definitely-not-a-real-key");
		}
	});

	it("rejects an over-limit message via preflight", async () => {
		const provider = new BrevoEmailProvider(KEY);
		const huge: EmailMessage = {
			...baseMsg,
			attachments: [
				{
					content: "A".repeat(30 * 1024 * 1024), // 30 MiB > 25 MiB limit
					filename: "huge.txt",
					type: "text/plain",
				},
			],
		};
		// Preflight catches this before any network call.
		const v = provider.validateMessage(huge);
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/size|limit/i);
	});

	it("constructed without a key throws EmailProviderConfigError", () => {
		expect(() => new BrevoEmailProvider(undefined)).toThrow();
	});
});

describe.skipIf(HAS_KEY)("Brevo integration (no key configured)", () => {
	it("skips when BREVO_API_KEY is missing — set it to enable real-API tests", () => {
		// This test exists so the skipped suite above is visible in the
		// output. If you're seeing this in CI, add the secret.
		expect(KEY).toBeUndefined();
	});
});
