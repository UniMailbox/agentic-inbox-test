// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for `parseProviderConfig`.
 */
import { describe, expect, it, vi } from "vitest";
import { parseProviderConfig } from "../../workers/providers/registry";

describe("parseProviderConfig", () => {
	it("returns empty object for undefined / empty input", () => {
		expect(parseProviderConfig(undefined)).toEqual({});
		expect(parseProviderConfig("")).toEqual({});
	});

	it("parses a well-formed config with both `domains` and `default`", () => {
		const result = parseProviderConfig(
			JSON.stringify({
				domains: { "foo.com": "brevo", "bar.com": "cloudflare" },
				default: "cloudflare",
			}),
		);
		expect(result).toEqual({
			domains: { "foo.com": "brevo", "bar.com": "cloudflare" },
			default: "cloudflare",
		});
	});

	it("lowercases all keys", () => {
		const result = parseProviderConfig(
			JSON.stringify({ domains: { "FOO.COM": "Brevo" }, default: "Cloudflare" }),
		);
		expect(result).toEqual({
			domains: { "foo.com": "brevo" },
			default: "cloudflare",
		});
	});

	it("returns empty object for malformed JSON and logs once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(parseProviderConfig("{not json")).toEqual({});
		expect(parseProviderConfig("{not json")).toEqual({});
		// dedup: same raw string → only one warn
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("skips non-string entries in `domains`", () => {
		const result = parseProviderConfig(
			JSON.stringify({
				domains: {
					"foo.com": "brevo",
					"bad.com": 123,
					"ok.com": { nested: true },
				},
			}),
		);
		expect(result).toEqual({
			domains: { "foo.com": "brevo" },
		});
	});

	it("handles a config with only `domains`", () => {
		const result = parseProviderConfig(
			JSON.stringify({ domains: { "foo.com": "brevo" } }),
		);
		expect(result).toEqual({ domains: { "foo.com": "brevo" } });
		expect(result.default).toBeUndefined();
	});

	it("handles a config with only `default`", () => {
		const result = parseProviderConfig(JSON.stringify({ default: "brevo" }));
		expect(result).toEqual({ default: "brevo" });
		expect(result.domains).toBeUndefined();
	});

	it("returns empty when input is non-object JSON", () => {
		expect(parseProviderConfig("null")).toEqual({});
		expect(parseProviderConfig("123")).toEqual({});
		expect(parseProviderConfig('"string"')).toEqual({});
		expect(parseProviderConfig("[]")).toEqual({});
	});
});