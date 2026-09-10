// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for FOLLOWUP-007 (cache auto-invalidation) and the
 * parseProviderConfig memoization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetProviderCaches,
	getProviderForDomain,
	parseProviderConfig,
} from "../../workers/providers/registry";
import { makeEnv } from "./_env";

beforeEach(() => {
	_resetProviderCaches();
});

describe("parseProviderConfig memoization", () => {
	it("returns the same object reference for identical raw input", () => {
		const a = parseProviderConfig('{"domains":{"foo.com":"brevo"}}');
		const b = parseProviderConfig('{"domains":{"foo.com":"brevo"}}');
		// Object identity is preserved by memoization
		expect(a).toBe(b);
	});

	it("returns different objects for different raw input", () => {
		const a = parseProviderConfig('{"domains":{"foo.com":"brevo"}}');
		const b = parseProviderConfig('{"domains":{"foo.com":"cloudflare"}}');
		expect(a).not.toBe(b);
		expect(a.domains?.["foo.com"]).toEqual({ type: "brevo" });
		expect(b.domains?.["foo.com"]).toEqual({ type: "cloudflare" });
	});

	it("_resetProviderCaches clears the parsed-config memo", () => {
		const a = parseProviderConfig('{"domains":{"foo.com":"brevo"}}');
		_resetProviderCaches();
		const b = parseProviderConfig('{"domains":{"foo.com":"brevo"}}');
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});
});

describe("getProviderForDomain cache auto-invalidation (FOLLOWUP-007)", () => {
	it("uses the cached instance for the same config snapshot", async () => {
		const env = makeEnv();
		const a = await getProviderForDomain(env, "foo.com");
		const b = await getProviderForDomain(env, "foo.com");
		expect(a).toBe(b);
	});

	it("creates a new instance after PROVIDER_CONFIG changes", async () => {
		const initial = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "cloudflare" } }),
		});
		const first = await getProviderForDomain(initial, "foo.com");
		expect(first.name).toBe("cloudflare");

		// Operator updates PROVIDER_CONFIG — same call site, new env snapshot
		const updated = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "cloudflare" } }),
		});
		// Same value as `initial` → still cached
		const secondSame = await getProviderForDomain(updated, "foo.com");
		expect(secondSame).toBe(first);

		// Different value (e.g. brevo now) → cache should be invalidated and
		// routing must follow the new config. We use vi.stubGlobal('fetch')
		// to satisfy the Brevo network call.
		const fetchStub = vi.fn(async () =>
			new Response(JSON.stringify({ messageId: "brevo-stub" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchStub);
		try {
			const updatedToBrevo = makeEnv({
				PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "brevo" } }),
				BREVO_API_KEY: "test-key",
			});
			const third = await getProviderForDomain(updatedToBrevo, "foo.com");
			// The registry followed the new config — instance is a Brevo provider.
			expect(third).not.toBe(first);
			expect(third.name).toBe("brevo");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("uses the cached instance when DEFAULT_PROVIDER is unchanged", async () => {
		const env = makeEnv({
			DEFAULT_PROVIDER: "cloudflare",
		});
		const a = await getProviderForDomain(env, "any.com");
		const b = await getProviderForDomain(env, "other.com");
		expect(a).toBe(b);
	});

	it("R2 override takes precedence over PROVIDER_CONFIG env var (FOLLOWUP-006)", async () => {
		// Env says cloudflare; R2 says brevo — R2 must win.
		const fetchStub = vi.fn(async () =>
			new Response(JSON.stringify({ messageId: "brevo-stub" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchStub);
		try {
			const env = makeEnv({
				PROVIDER_CONFIG: JSON.stringify({ default: "cloudflare" }),
				BREVO_API_KEY: "test-key",
			});
			// Inject an R2 config that overrides
			(env.BUCKET as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn(
				async (key: string) => {
					if (key === "config/providers.json") {
						return {
							text: async () =>
								JSON.stringify({ default: "brevo" }),
						};
					}
					return null;
				},
			);

			const provider = await getProviderForDomain(env, "any.com");
			expect(provider.name).toBe("brevo");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
