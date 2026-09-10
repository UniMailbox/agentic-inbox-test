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
			domains: {
				"foo.com": { type: "brevo" },
				"bar.com": { type: "cloudflare" },
			},
			default: { type: "cloudflare" },
		});
	});

	it("rejects uppercase inputs (zod schema is strict; operators should send canonical config)", () => {
		const raw = JSON.stringify({ domains: { "FOO.COM": "Brevo" }, default: "Cloudflare" });
		// Schema rejects uppercase domain labels + provider names; the parser
		// returns {} and warns once. Operators should write lowercase.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(parseProviderConfig(raw)).toEqual({});
		warn.mockRestore();
	});

	it("returns empty object for malformed JSON and logs once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(parseProviderConfig("{not json")).toEqual({});
		expect(parseProviderConfig("{not json")).toEqual({});
		// dedup: same raw string → only one warn
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("rejects non-string entries in `domains` (zod schema enforces entry shape)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = parseProviderConfig(
			JSON.stringify({
				domains: {
					"foo.com": "brevo",
					"bad.com": 123,
					"ok.com": { nested: true },
				},
			}),
		);
		// Schema rejects the bad entries; entire config returns {}.
		expect(result).toEqual({});
		warn.mockRestore();
	});

	it("handles a config with only `domains`", () => {
		const result = parseProviderConfig(
			JSON.stringify({ domains: { "foo.com": "brevo" } }),
		);
		expect(result).toEqual({ domains: { "foo.com": { type: "brevo" } } });
		expect(result.default).toBeUndefined();
	});

	it("handles a config with only `default`", () => {
		const result = parseProviderConfig(JSON.stringify({ default: "brevo" }));
		expect(result).toEqual({ default: { type: "brevo" } });
		expect(result.domains).toBeUndefined();
	});

	it("parses object form with fallback (FOLLOWUP-005)", () => {
		const result = parseProviderConfig(
			JSON.stringify({
				domains: { "foo.com": { type: "brevo", fallback: "cloudflare" } },
			}),
		);
		expect(result.domains?.["foo.com"]).toEqual({
			type: "brevo",
			fallback: "cloudflare",
		});
	});

	it("returns empty when input is non-object JSON", () => {
		expect(parseProviderConfig("null")).toEqual({});
		expect(parseProviderConfig("123")).toEqual({});
		expect(parseProviderConfig('"string"')).toEqual({});
		expect(parseProviderConfig("[]")).toEqual({});
	});
});