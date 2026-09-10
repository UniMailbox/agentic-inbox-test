// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for `normalizeDomain` + `domainFromFrom` (FOLLOWUP-001).
 */
import { describe, expect, it } from "vitest";
import { domainFromFrom, fromEmailString, normalizeDomain } from "../../workers/providers/types";

describe("normalizeDomain", () => {
	it("lowercases uppercase", () => {
		expect(normalizeDomain("EXAMPLE.COM")).toBe("example.com");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeDomain("  example.com  ")).toBe("example.com");
	});

	it("returns null for empty / null / undefined", () => {
		expect(normalizeDomain("")).toBeNull();
		expect(normalizeDomain("   ")).toBeNull();
		expect(normalizeDomain(null)).toBeNull();
		expect(normalizeDomain(undefined)).toBeNull();
	});

	it("returns null for IPv4 literals", () => {
		expect(normalizeDomain("10.0.0.1")).toBeNull();
		expect(normalizeDomain("192.168.1.1")).toBeNull();
	});

	it("returns null for bracketed IP literals", () => {
		expect(normalizeDomain("[10.0.0.1]")).toBeNull();
		expect(normalizeDomain("[::1]")).toBeNull();
	});

	it("returns null for bare hostnames (no dot)", () => {
		expect(normalizeDomain("localhost")).toBeNull();
		expect(normalizeDomain("intranet")).toBeNull();
	});

	it("returns null for malformed input with disallowed chars", () => {
		expect(normalizeDomain("example.com<script>")).toBeNull();
	});

	it("preserves a trailing dot", () => {
		expect(normalizeDomain("example.com.")).toBe("example.com.");
	});

	it("rejects empty labels", () => {
		expect(normalizeDomain("example..com")).toBeNull();
	});

	it("rejects labels starting or ending with hyphen", () => {
		expect(normalizeDomain("-example.com")).toBeNull();
		expect(normalizeDomain("example-.com")).toBeNull();
	});
});

describe("fromEmailString", () => {
	it("lowercases string form", () => {
		expect(fromEmailString("John@Example.COM")).toBe("john@example.com");
	});

	it("extracts email from object form", () => {
		expect(fromEmailString({ email: "John@Example.COM", name: "John" })).toBe(
			"john@example.com",
		);
	});

	it("returns null for missing / empty", () => {
		expect(fromEmailString(undefined)).toBeNull();
		expect(fromEmailString(null)).toBeNull();
		expect(fromEmailString("")).toBeNull();
	});
});

describe("domainFromFrom", () => {
	it("returns the normalized domain from a string address", () => {
		expect(domainFromFrom("jane@EXAMPLE.com")).toBe("example.com");
	});

	it("returns the normalized domain from an EmailAddress object", () => {
		expect(domainFromFrom({ email: "jane@EXAMPLE.com", name: "Jane" })).toBe(
			"example.com",
		);
	});

	it("returns null when there is no @", () => {
		expect(domainFromFrom("not-an-email")).toBeNull();
	});

	it("returns null when the domain part is empty", () => {
		// jane@ — local part is "jane", no domain after @
		expect(domainFromFrom("jane@")).toBeNull();
	});
});