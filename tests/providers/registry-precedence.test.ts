// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for `getProviderForDomain` precedence (4-level fallback chain)
 * and `sendEmail` integration.
 *
 * Uses a tiny in-memory env stub. Because `instanceCache` is module-level,
 * every test calls `_resetProviderCaches()` so tests don't bleed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../workers/types";
import {
	_resetProviderCaches,
	PROVIDERS,
	getProviderForDomain,
	sendEmail,
} from "../../workers/providers/registry";
import {
	EmailProviderError,
	EmailProviderConfigError,
} from "../../workers/providers/types";

/** Minimal env stub: only the fields the registry reads. */
function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		POLICY_AUD: "aud",
		TEAM_DOMAIN: "team.cloudflareaccess.com",
		EMAIL: { send: vi.fn(async () => ({ messageId: "cf-1" })) } as unknown as Env["EMAIL"],
		BREVO_API_KEY: "brevo-test-key",
		DEFAULT_PROVIDER: "cloudflare",
		PROVIDER_CONFIG: "",
		...overrides,
	} as unknown as Env;
}

beforeEach(() => {
	_resetProviderCaches();
});

describe("getProviderForDomain precedence", () => {
	it("mailbox override wins over everything else", () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "cloudflare" } }),
			DEFAULT_PROVIDER: "cloudflare",
		});
		// mailbox override says brevo even though PROVIDER_CONFIG says cloudflare
		const provider = getProviderForDomain(env, "foo.com", { provider: { type: "brevo" } });
		expect(provider.name).toBe("brevo");
	});

	it("PROVIDER_CONFIG.domains[domain] wins over DEFAULT_PROVIDER", () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "brevo" } }),
			DEFAULT_PROVIDER: "cloudflare",
		});
		const provider = getProviderForDomain(env, "foo.com");
		expect(provider.name).toBe("brevo");
	});

	it("PROVIDER_CONFIG.default wins over DEFAULT_PROVIDER", () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ default: "brevo" }),
			DEFAULT_PROVIDER: "cloudflare",
		});
		const provider = getProviderForDomain(env, "unmapped.com");
		expect(provider.name).toBe("brevo");
	});

	it("falls back to DEFAULT_PROVIDER when no config matches", () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "other.com": "brevo" } }),
			DEFAULT_PROVIDER: "cloudflare",
		});
		const provider = getProviderForDomain(env, "unmapped.com");
		expect(provider.name).toBe("cloudflare");
	});

	it("falls back to 'cloudflare' when neither config nor env var is set", () => {
		const env = makeEnv({
			DEFAULT_PROVIDER: undefined,
			PROVIDER_CONFIG: "",
		});
		const provider = getProviderForDomain(env, "any.com");
		expect(provider.name).toBe("cloudflare");
	});

	it("throws EmailProviderConfigError on unknown provider type in PROVIDER_CONFIG", () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "unknown" } }),
		});
		expect(() => getProviderForDomain(env, "foo.com")).toThrow(
			EmailProviderConfigError,
		);
	});

	it("caches the resolved provider across calls for the same domain", () => {
		const env = makeEnv();
		const a = getProviderForDomain(env, "foo.com");
		const b = getProviderForDomain(env, "foo.com");
		expect(a).toBe(b);
	});

	it("provider instances are cached across domains mapping to the same provider", () => {
		const env = makeEnv();
		const a = getProviderForDomain(env, "foo.com");
		const b = getProviderForDomain(env, "bar.com");
		// Both map to "cloudflare" — same instance
		expect(a).toBe(b);
	});

	it("exposes the registered provider names", () => {
		expect(Object.keys(PROVIDERS).sort()).toEqual(["brevo", "cloudflare"]);
	});
});

describe("sendEmail (registry entry point)", () => {
	it("routes to the cloudflare provider by default", async () => {
		const send = vi.fn(async () => ({ messageId: "cf-ok" }));
		const env = makeEnv({ EMAIL: { send } as unknown as Env["EMAIL"] });

		const result = await sendEmail(env, {
			to: "alice@example.com",
			from: "me@foo.com",
			subject: "hi",
			html: "<p>hi</p>",
		});

		expect(result).toEqual({ messageId: "cf-ok", providerName: "cloudflare" });
		expect(send).toHaveBeenCalledOnce();
	});

	it("stubs global fetch when routing to Brevo so no real network call happens", async () => {
		const fetchStub = vi.fn(async () =>
			new Response(JSON.stringify({ messageId: "brevo-stub" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchStub);

		try {
			const env = makeEnv({
				PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "brevo" } }),
			});
			const result = await sendEmail(env, {
				to: "alice@example.com",
				from: "me@foo.com",
				subject: "hi",
				html: "<p>hi</p>",
			});
			expect(result.providerName).toBe("brevo");
			expect(fetchStub).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("throws when the sender domain cannot be extracted", async () => {
		const env = makeEnv();
		await expect(
			sendEmail(env, { to: "a@b.com", from: "", subject: "x", html: "y" }),
		).rejects.toThrow(EmailProviderConfigError);
	});

	it("throws EmailProviderError when preflight validation fails", async () => {
		const env = makeEnv();
		// 60 recipients > CF limit of 50 → preflight must reject synchronously
		const many: string[] = [];
		for (let i = 0; i < 60; i++) many.push(`r${i}@example.com`);
		await expect(
			sendEmail(env, {
				to: many,
				from: "me@foo.com",
				subject: "x",
				html: "<p>x</p>",
			}),
		).rejects.toThrow(EmailProviderError);
	});
});