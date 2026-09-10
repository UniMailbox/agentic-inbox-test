// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for FOLLOWUP-009 (zod validation + eager validation + health
 * endpoint data shape).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetEagerValidationFlag,
	_resetProviderCaches,
	_runEagerValidation,
	parseProviderConfig,
	validateConfig,
} from "../../workers/providers/registry";
import { ProviderConfigSchema } from "../../workers/providers/schema";
import { makeEnv } from "./_env";

beforeEach(() => {
	_resetProviderCaches();
	_resetEagerValidationFlag();
});

describe("ProviderConfigSchema (zod)", () => {
	it("accepts a minimal config", () => {
		const r = ProviderConfigSchema.safeParse({});
		expect(r.success).toBe(true);
	});

	it("accepts a string entry", () => {
		const r = ProviderConfigSchema.safeParse({
			domains: { "foo.com": "brevo" },
		});
		expect(r.success).toBe(true);
	});

	it("accepts an object entry with fallback", () => {
		const r = ProviderConfigSchema.safeParse({
			domains: { "foo.com": { type: "brevo", fallback: "cloudflare" } },
		});
		expect(r.success).toBe(true);
	});

	it("rejects unknown keys (strict mode)", () => {
		const r = ProviderConfigSchema.safeParse({
			domains: { "foo.com": "brevo" },
			foobar: true,
		});
		expect(r.success).toBe(false);
	});

	it("rejects invalid domain labels", () => {
		const r = ProviderConfigSchema.safeParse({
			domains: { "FOO.COM": "brevo" }, // uppercase not allowed
		});
		expect(r.success).toBe(false);
	});

	it("rejects invalid provider names", () => {
		const r = ProviderConfigSchema.safeParse({
			domains: { "foo.com": "Brevo!" }, // special char
		});
		expect(r.success).toBe(false);
	});

	it("rejects bare hostnames in domains", () => {
		const r = ProviderConfigSchema.safeParse({
			domains: { "localhost": "brevo" },
		});
		expect(r.success).toBe(false);
	});

	it("rejects non-string default", () => {
		const r = ProviderConfigSchema.safeParse({ default: 42 });
		expect(r.success).toBe(false);
	});
});

describe("validateConfig (FOLLOWUP-009)", () => {
	it("returns ok:true for empty config", async () => {
		const env = makeEnv();
		const report = await validateConfig(env);
		expect(report.ok).toBe(true);
		expect(report.parsed).toBe(true);
		expect(report.issues).toEqual([]);
		expect(report.referencedProviders).toEqual([]);
	});

	it("flags malformed JSON", async () => {
		const env = makeEnv({ PROVIDER_CONFIG: "{not json" });
		const report = await validateConfig(env);
		expect(report.ok).toBe(false);
		expect(report.parsed).toBe(false);
		expect(report.issues[0]).toContain("JSON");
	});

	it("flags unknown provider types", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "unknown" } }),
		});
		const report = await validateConfig(env);
		expect(report.ok).toBe(false);
		expect(report.unknownProviders).toContain("unknown");
		expect(report.issues[0]).toContain("Unknown provider");
	});

	it("lists all referenced provider types", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({
				domains: {
					"foo.com": "brevo",
					"bar.com": { type: "brevo", fallback: "cloudflare" },
				},
				default: { type: "cloudflare", fallback: "brevo" },
			}),
		});
		const report = await validateConfig(env);
		expect(report.referencedProviders.sort()).toEqual(["brevo", "cloudflare"]);
	});

	it("emits a warning when fallback equals primary", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({
				domains: { "foo.com": { type: "brevo", fallback: "brevo" } },
			}),
		});
		const report = await validateConfig(env);
		expect(report.warnings.length).toBeGreaterThan(0);
		expect(report.warnings[0]).toContain("no-op");
	});

	it("reports source = 'env' for env var config", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: JSON.stringify({ domains: { "foo.com": "brevo" } }),
		});
		const report = await validateConfig(env);
		expect(report.source).toBe("env");
	});

	it("reports source = 'r2' when R2 override is present (FOLLOWUP-006)", async () => {
		const env = makeEnv();
		(env.BUCKET as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn(
			async (key: string) => {
				if (key === "config/providers.json") {
					return { text: async () => JSON.stringify({ default: "brevo" }) };
				}
				return null;
			},
		);
		const report = await validateConfig(env);
		expect(report.source).toBe("r2");
	});
});

describe("_runEagerValidation (FOLLOWUP-009)", () => {
	it("logs once and does not log on the second call", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const env = makeEnv({ PROVIDER_CONFIG: "{not json" });

		await _runEagerValidation(env);
		await _runEagerValidation(env);
		// dedup: only one console.error even though we called twice
		expect(errSpy).toHaveBeenCalledTimes(1);
		errSpy.mockRestore();
	});

	it("does not log on the happy path", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const env = makeEnv();
		await _runEagerValidation(env);
		expect(errSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("parseProviderConfig with zod", () => {
	it("returns {} for a schema-invalid config and warns once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Invalid: domain has uppercase
		const raw = JSON.stringify({ domains: { "FOO.COM": "brevo" } });
		expect(parseProviderConfig(raw)).toEqual({});
		expect(parseProviderConfig(raw)).toEqual({});
		// dedup: same raw string → only one warn
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});
