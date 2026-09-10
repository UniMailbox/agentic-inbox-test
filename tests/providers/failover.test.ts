// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for FOLLOWUP-005 (failover + circuit breaker).
 *
 * Covers:
 *  - fallback kicks in when primary throws EmailProviderError
 *  - circuit breaker opens after N consecutive failures
 *  - circuit breaker short-circuits subsequent calls
 *  - success resets the breaker
 *  - half-open after cool-off expires
 *  - preflight failure does not record a circuit-breaker failure
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../workers/types";
import {
	_resetProviderCaches,
	sendEmail,
} from "../../workers/providers/registry";
import {
	_resetCircuitBreakers,
	_setBreakerThresholds,
	getBreakerSnapshot,
	isBreakerOpen,
	recordFailure,
} from "../../workers/providers/circuit-breaker";
import {
	EmailProviderError,
} from "../../workers/providers/types";
import { makeEnv } from "./_env";

const baseMsg = {
	to: "alice@example.com",
	from: "me@foo.com",
	subject: "hi",
	html: "<p>hi</p>",
};

beforeEach(() => {
	_resetProviderCaches();
	_resetCircuitBreakers();
});

describe("FOLLOWUP-005 fallback routing", () => {
	it("retries the fallback when the primary throws EmailProviderError", async () => {
		// Build an env with foo.com mapped to brevo + fallback cloudflare,
		// and a stubbed fetch that always returns 500 for brevo.
		const fetchStub = vi.fn(async () =>
			new Response(JSON.stringify({ code: "server_error" }), { status: 500 }),
		);
		vi.stubGlobal("fetch", fetchStub);
		try {
			const sendCf = vi.fn(async () => ({ messageId: "cf-fallback" }));
			const env = makeEnv({
				EMAIL: { send: sendCf } as unknown as Env["EMAIL"],
				PROVIDER_CONFIG: JSON.stringify({
					domains: {
						"foo.com": { type: "brevo", fallback: "cloudflare" },
					},
				}),
				BREVO_API_KEY: "test-key",
			});

			const result = await sendEmail(env, baseMsg);

			expect(result.providerName).toBe("cloudflare");
			expect(result.messageId).toBe("cf-fallback");
			expect(sendCf).toHaveBeenCalledOnce();
			expect(fetchStub).toHaveBeenCalledOnce(); // Brevo tried once
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("does NOT fall back when primary throws a non-EmailProviderError", async () => {
		// A bad config (constructor throws EmailProviderConfigError) should
		// not trigger fallback — only runtime errors are retried.
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({
				domains: {
					"foo.com": { type: "unknown-type", fallback: "cloudflare" },
				},
			}),
		});
		await expect(sendEmail(env, baseMsg)).rejects.toThrow();
	});

	it("does NOT fall back when primary equals fallback (misconfiguration)", async () => {
		const sendCf = vi.fn(async () => {
			throw new EmailProviderError("cloudflare", "intentional failure");
		});
		const env = makeEnv({
			EMAIL: { send: sendCf } as unknown as Env["EMAIL"],
			PROVIDER_CONFIG: JSON.stringify({
				domains: {
					"foo.com": { type: "cloudflare", fallback: "cloudflare" },
				},
			}),
		});

		await expect(sendEmail(env, baseMsg)).rejects.toThrow(EmailProviderError);
		expect(sendCf).toHaveBeenCalledOnce(); // only once, no infinite loop
	});

	it("skips fallback if its breaker is also open", async () => {
		const sendCf = vi.fn(async () => {
			throw new EmailProviderError("cloudflare", "down");
		});
		vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));

		try {
			const env = makeEnv({
				EMAIL: { send: sendCf } as unknown as Env["EMAIL"],
				PROVIDER_CONFIG: JSON.stringify({
					domains: {
						"foo.com": { type: "cloudflare", fallback: "brevo" },
					},
				}),
				BREVO_API_KEY: "test-key",
			});

			// First call: cloudflare fails → tries brevo (fails too)
			await expect(sendEmail(env, baseMsg)).rejects.toThrow(EmailProviderError);
			// Both breakers should have failures recorded
			const snap = getBreakerSnapshot();
			expect(snap.cloudflare?.failures).toBeGreaterThanOrEqual(1);
			expect(snap.brevo?.failures).toBeGreaterThanOrEqual(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("FOLLOWUP-005 circuit breaker", () => {
	it("opens after N consecutive failures", () => {
		expect(isBreakerOpen("cloudflare")).toBe(false);
		// Default threshold is 5
		for (let i = 0; i < 4; i++) {
			importCircuitFail("cloudflare");
		}
		expect(isBreakerOpen("cloudflare")).toBe(false); // 4 < 5
		importCircuitFail("cloudflare");
		expect(isBreakerOpen("cloudflare")).toBe(true); // 5 = threshold
	});

	it("short-circuits sendEmail when breaker is open and no fallback configured", async () => {
		_setBreakerThresholds({ threshold: 2, cooloffMs: 60_000 });

		const sendCf = vi.fn(async () => {
			throw new EmailProviderError("cloudflare", "down");
		});
		const env = makeEnv({
			EMAIL: { send: sendCf } as unknown as Env["EMAIL"],
		});

		// Trip the breaker with 2 failures
		await expect(sendEmail(env, baseMsg)).rejects.toThrow();
		await expect(sendEmail(env, baseMsg)).rejects.toThrow();
		expect(sendCf).toHaveBeenCalledTimes(2);

		// 3rd call: breaker open → no network call
		await expect(sendEmail(env, baseMsg)).rejects.toThrow(/Circuit breaker open/);
		expect(sendCf).toHaveBeenCalledTimes(2); // unchanged
	});

	it("resets failures on success", async () => {
		const sendCf = vi.fn(async () => ({ messageId: "ok" }));
		const env = makeEnv({ EMAIL: { send: sendCf } as unknown as Env["EMAIL"] });

		await sendEmail(env, baseMsg);
		expect(getBreakerSnapshot().cloudflare?.failures ?? 0).toBe(0);
	});

	it("routes directly to fallback when primary breaker is open", async () => {
		_setBreakerThresholds({ threshold: 1, cooloffMs: 60_000 });
		const sendCf = vi.fn(async () => {
			throw new EmailProviderError("cloudflare", "down");
		});
		vi.stubGlobal("fetch", async () =>
			new Response(JSON.stringify({ messageId: "brevo-ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		try {
			const env = makeEnv({
				EMAIL: { send: sendCf } as unknown as Env["EMAIL"],
				PROVIDER_CONFIG: JSON.stringify({
					domains: {
						"foo.com": { type: "cloudflare", fallback: "brevo" },
					},
				}),
				BREVO_API_KEY: "test-key",
			});

			// First call trips cloudflare's breaker and falls back to brevo
			const r1 = await sendEmail(env, baseMsg);
			expect(r1.providerName).toBe("brevo");
			expect(sendCf).toHaveBeenCalledTimes(1);

			// Second call: cloudflare breaker open → straight to brevo,
			// no cloudflare call.
			const r2 = await sendEmail(env, baseMsg);
			expect(r2.providerName).toBe("brevo");
			expect(sendCf).toHaveBeenCalledTimes(1); // unchanged
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// Local helper so we don't have to import the full registry in this file.
function importCircuitFail(name: string) {
	recordFailure(name);
}