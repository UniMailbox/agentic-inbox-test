// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the ConfigSource abstraction (FOLLOWUP-012).
 *
 * Covers:
 *   - EnvConfigSource reads from env.PROVIDER_CONFIG.
 *   - R2ConfigSource reads from env.BUCKET; empty / missing → null.
 *   - R2ConfigSource returns null on read error (logs warn).
 *   - CompositeConfigSource walks sources in order.
 *   - buildConfigSourceChain honors CONFIG_SOURCE env var.
 *   - loadProviderConfigRaw still returns the v1.1 default chain
 *     (R2 → env) when CONFIG_SOURCE is unset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../workers/types";
import {
	buildConfigSourceChain,
	CompositeConfigSource,
	DEFAULT_CONFIG_SOURCES,
	EnvConfigSource,
	loadProviderConfigRaw,
	R2ConfigSource,
} from "../../workers/providers/config-source";

// -- Fake R2 --------------------------------------------------------

class FakeBucket {
	store = new Map<string, string>();
	get = vi.fn(async (key: string) => {
		const v = this.store.get(key);
		return v ? { text: async () => v } : null;
	});
	put = vi.fn(async (key: string, value: string) => {
		this.store.set(key, value);
		return undefined;
	});
	delete = vi.fn(async (key: string) => this.store.delete(key));
	head = vi.fn(async (key: string) =>
		this.store.has(key) ? { key } : null,
	);
}

function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		BUCKET: new FakeBucket() as unknown as Env["BUCKET"],
		DEFAULT_PROVIDER: "cloudflare",
		PROVIDER_CONFIG: "",
		...overrides,
	} as unknown as Env;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("EnvConfigSource", () => {
	it("returns null when PROVIDER_CONFIG is unset", async () => {
		const env = makeEnv();
		const result = await new EnvConfigSource().load(env);
		expect(result).toBeNull();
	});

	it("returns null for an empty PROVIDER_CONFIG", async () => {
		const env = makeEnv({ PROVIDER_CONFIG: "   " });
		const result = await new EnvConfigSource().load(env);
		expect(result).toBeNull();
	});

	it("returns the raw value with source='env'", async () => {
		const env = makeEnv({ PROVIDER_CONFIG: '{"default":"brevo"}' });
		const result = await new EnvConfigSource().load(env);
		expect(result).toEqual({ raw: '{"default":"brevo"}', source: "env" });
	});
});

describe("R2ConfigSource", () => {
	it("returns null when R2 has no config", async () => {
		const env = makeEnv();
		const result = await new R2ConfigSource().load(env);
		expect(result).toBeNull();
	});

	it("returns the raw R2 object with source='r2'", async () => {
		const env = makeEnv();
		(env.BUCKET as unknown as FakeBucket).store.set(
			"config/providers.json",
			'{"default":"brevo"}',
		);
		const result = await new R2ConfigSource().load(env);
		expect(result).toEqual({ raw: '{"default":"brevo"}', source: "r2" });
	});

	it("returns null for whitespace-only R2 object", async () => {
		const env = makeEnv();
		(env.BUCKET as unknown as FakeBucket).store.set(
			"config/providers.json",
			"   \n  ",
		);
		const result = await new R2ConfigSource().load(env);
		expect(result).toBeNull();
	});

	it("returns null on R2 read error (logs warn)", async () => {
		const env = makeEnv();
		(env.BUCKET as unknown as FakeBucket).get = vi.fn(async () => {
			throw new Error("R2 down");
		});
		const result = await new R2ConfigSource().load(env);
		expect(result).toBeNull();
		expect(console.warn).toHaveBeenCalled();
	});

	it("honors a custom R2 key", async () => {
		const env = makeEnv();
		(env.BUCKET as unknown as FakeBucket).store.set(
			"config/custom.json",
			'{"default":"cloudflare"}',
		);
		const result = await new R2ConfigSource("config/custom.json").load(env);
		expect(result?.raw).toBe('{"default":"cloudflare"}');
	});
});

describe("CompositeConfigSource", () => {
	it("returns the first non-null result", async () => {
		const env = makeEnv({ PROVIDER_CONFIG: '{"default":"brevo"}' });
		// R2 has nothing, env wins.
		const composite = new CompositeConfigSource([
			new R2ConfigSource(),
			new EnvConfigSource(),
		]);
		const result = await composite.load(env);
		expect(result?.source).toBe("env");
	});

	it("returns null when every source returns null", async () => {
		const env = makeEnv();
		const composite = new CompositeConfigSource([
			new R2ConfigSource(),
			new EnvConfigSource(),
		]);
		expect(await composite.load(env)).toBeNull();
	});

	it("prefers the first source when it has a value", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: '{"default":"brevo"}',
		});
		(env.BUCKET as unknown as FakeBucket).store.set(
			"config/providers.json",
			'{"default":"cloudflare"}',
		);
		// R2 wins over env (default order).
		const result = await new CompositeConfigSource(DEFAULT_CONFIG_SOURCES).load(
			env,
		);
		expect(result?.source).toBe("r2");
		expect(result?.raw).toBe('{"default":"cloudflare"}');
	});
});

describe("buildConfigSourceChain", () => {
	it("returns R2 → env by default", () => {
		const chain = buildConfigSourceChain(undefined);
		expect(chain.map((s) => s.name)).toEqual(["r2", "env"]);
	});

	it("honors 'env,r2'", () => {
		const chain = buildConfigSourceChain("env,r2");
		expect(chain.map((s) => s.name)).toEqual(["env", "r2"]);
	});

	it("honors a single source", () => {
		expect(buildConfigSourceChain("env").map((s) => s.name)).toEqual(["env"]);
		expect(buildConfigSourceChain("r2").map((s) => s.name)).toEqual(["r2"]);
	});

	it("dedupes repeated names", () => {
		const chain = buildConfigSourceChain("r2,env,r2");
		expect(chain.map((s) => s.name)).toEqual(["r2", "env"]);
	});

	it("falls back to default for unknown values", () => {
		const chain = buildConfigSourceChain("kv,env");
		expect(chain.map((s) => s.name)).toEqual(["r2", "env"]);
		expect(console.warn).toHaveBeenCalled();
	});

	it("trims and lowercases", () => {
		const chain = buildConfigSourceChain("  ENV , R2  ");
		expect(chain.map((s) => s.name)).toEqual(["env", "r2"]);
	});

	it("returns default for empty string", () => {
		const chain = buildConfigSourceChain("");
		expect(chain.map((s) => s.name)).toEqual(["r2", "env"]);
	});
});

describe("loadProviderConfigRaw (v1.1 compat)", () => {
	it("returns source='r2' when both R2 and env are set (R2 wins)", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: '{"default":"brevo"}',
		});
		(env.BUCKET as unknown as FakeBucket).store.set(
			"config/providers.json",
			'{"default":"cloudflare"}',
		);
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("r2");
		expect(r.raw).toBe('{"default":"cloudflare"}');
	});

	it("returns source='env' when only env is set", async () => {
		const env = makeEnv({ PROVIDER_CONFIG: '{"default":"brevo"}' });
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("env");
	});

	it("returns source='default' when neither is set", async () => {
		const env = makeEnv();
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("default");
		expect(r.raw).toBeUndefined();
	});

	it("falls back to env when R2 read fails", async () => {
		const env = makeEnv({ PROVIDER_CONFIG: '{"default":"brevo"}' });
		(env.BUCKET as unknown as FakeBucket).get = vi.fn(async () => {
			throw new Error("R2 down");
		});
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("env");
	});

	it("honors CONFIG_SOURCE='env,r2' (env wins)", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: '{"default":"brevo"}',
			CONFIG_SOURCE: "env,r2",
		});
		(env.BUCKET as unknown as FakeBucket).store.set(
			"config/providers.json",
			'{"default":"cloudflare"}',
		);
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("env");
		expect(r.raw).toBe('{"default":"brevo"}');
	});

	it("CONFIG_SOURCE='r2' skips env entirely", async () => {
		const env = makeEnv({
			PROVIDER_CONFIG: '{"default":"brevo"}',
			CONFIG_SOURCE: "r2",
		});
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("default");
		expect(r.raw).toBeUndefined();
	});
});
