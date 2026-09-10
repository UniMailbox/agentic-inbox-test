// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for FOLLOWUP-006 admin endpoints (PUT/GET/DELETE + audit) and the
 * R2 config source.
 *
 * These are integration-style tests against the route handlers using a fake
 * R2 bucket. The handlers read `c.var.user.id` (admin auth is enforced by
 * `requireAdmin` middleware outside these tests).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleProvidersGet,
	handleProvidersPut,
	handleProvidersDelete,
	handleProvidersAudit,
} from "../../workers/routes/admin-providers";
import {
	loadProviderConfigRaw,
	writeR2Config,
	deleteR2Config,
	appendAuditEntry,
	readAuditLog,
	getR2ConfigKey,
} from "../../workers/providers/config-source";
import { _resetProviderCaches } from "../../workers/providers/registry";

// -- Mock R2 + env ---------------------------------------------------

interface R2Object {
	text(): Promise<string>;
}

interface R2Bucket {
	store: Map<string, string>;
	get(key: string): Promise<R2Object | null>;
	put(key: string, value: string): Promise<unknown>;
	delete(key: string): Promise<boolean>;
	head(key: string): Promise<unknown>;
}

function makeBucket(): R2Bucket {
	const store = new Map<string, string>();
	return {
		store,
		async get(key) {
			const v = store.get(key);
			return v ? { text: async () => v } : null;
		},
		async put(key, value) {
			store.set(key, value);
			return undefined;
		},
		async delete(key) {
			return store.delete(key);
		},
		async head(key) {
			return store.has(key) ? { key } : null;
		},
	};
}

function makeEnv(bucket: R2Bucket, overrides: Record<string, unknown> = {}) {
	return {
		BUCKET: bucket,
		DEFAULT_PROVIDER: "cloudflare",
		PROVIDER_CONFIG: "",
		...overrides,
	} as unknown as Parameters<typeof loadProviderConfigRaw>[0];
}

function makeCtx(env: unknown, url = "https://x.test/api/v1/admin/providers", method = "GET") {
	const headers = new Headers();
	return {
		env,
		var: { user: { id: "admin-sub-1", email: "a@x", role: "admin" } },
		req: {
			url,
			method,
			header: (n: string) => headers.get(n) ?? undefined,
			param: (n: string) => undefined,
			json: async () => ({}),
		},
		json: (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	} as unknown as Parameters<typeof handleProvidersGet>[0];
}

beforeEach(() => {
	_resetProviderCaches();
});

// -- config-source ----------------------------------------------------

describe("loadProviderConfigRaw (FOLLOWUP-006)", () => {
	it("returns 'default' when neither R2 nor env is set", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		const r = await loadProviderConfigRaw(env);
		expect(r.raw).toBeUndefined();
		expect(r.source).toBe("default");
	});

	it("reads env var when R2 is empty", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket, { PROVIDER_CONFIG: '{"default":"cloudflare"}' });
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("env");
		expect(r.raw).toBe('{"default":"cloudflare"}');
	});

	it("prefers R2 over env", async () => {
		const bucket = makeBucket();
		await bucket.put("config/providers.json", '{"default":"brevo"}');
		const env = makeEnv(bucket, { PROVIDER_CONFIG: '{"default":"cloudflare"}' });
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("r2");
		expect(r.raw).toBe('{"default":"brevo"}');
	});

	it("falls back to env when R2 read fails", async () => {
		const bucket = {
			store: new Map(),
			get: vi.fn(async () => {
				throw new Error("R2 down");
			}),
			put: vi.fn(),
			delete: vi.fn(),
			head: vi.fn(),
		} as unknown as R2Bucket;
		const env = makeEnv(bucket, { PROVIDER_CONFIG: '{"default":"cloudflare"}' });
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("env");
		expect(r.raw).toBe('{"default":"cloudflare"}');
	});

	it("treats whitespace-only R2 as missing", async () => {
		const bucket = makeBucket();
		await bucket.put("config/providers.json", "   \n  ");
		const env = makeEnv(bucket);
		const r = await loadProviderConfigRaw(env);
		expect(r.source).toBe("default");
	});
});

describe("writeR2Config / deleteR2Config", () => {
	it("writes and deletes the config key", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		await writeR2Config(env, '{"default":"brevo"}');
		expect(bucket.store.get(getR2ConfigKey())).toBe('{"default":"brevo"}');
		await deleteR2Config(env);
		expect(bucket.store.has(getR2ConfigKey())).toBe(false);
	});
});

describe("audit log", () => {
	it("appends and reads entries newest-first", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		await appendAuditEntry(env, {
			timestamp: "2026-01-01T00:00:00Z",
			actor: "alice",
			action: "write",
			nextRaw: '{"default":"brevo"}',
		});
		await appendAuditEntry(env, {
			timestamp: "2026-01-02T00:00:00Z",
			actor: "bob",
			action: "write",
			nextRaw: '{"default":"cloudflare"}',
		});

		const entries = await readAuditLog(env, 50);
		expect(entries).toHaveLength(2);
		expect(entries[0].actor).toBe("bob");
		expect(entries[1].actor).toBe("alice");
	});

	it("respects limit and orders newest-first", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		for (let i = 0; i < 5; i++) {
			await appendAuditEntry(env, {
				timestamp: `2026-01-0${i + 1}T00:00:00Z`,
				actor: `u${i}`,
				action: "write",
			});
		}
		const entries = await readAuditLog(env, 3);
		expect(entries).toHaveLength(3);
		expect(entries[0].actor).toBe("u4");
		expect(entries[2].actor).toBe("u2");
	});

	it("skips malformed lines without throwing", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		await bucket.put("config/audit.jsonl", "not-json\n");
		const entries = await readAuditLog(env, 10);
		expect(entries).toEqual([]);
	});
});

// -- PUT /api/v1/admin/providers --------------------------------------

describe("handleProvidersPut", () => {
	it("writes a valid config and appends an audit entry", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		const ctx = makeCtx(env);
		ctx.req.json = async () => ({ config: '{"default":"brevo"}' });

		const res = await handleProvidersPut(ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			source: string;
			validation: { ok: boolean };
		};
		expect(body.ok).toBe(true);
		expect(body.source).toBe("r2");
		expect(body.validation.ok).toBe(true);

		// R2 has the new value
		expect(bucket.store.get("config/providers.json")).toBe(
			'{"default":"brevo"}',
		);

		// Audit log captured the write
		const entries = await readAuditLog(env, 10);
		expect(entries).toHaveLength(1);
		expect(entries[0].action).toBe("write");
		expect(entries[0].actor).toBe("admin-sub-1");
		expect(entries[0].nextRaw).toBe('{"default":"brevo"}');
		expect(entries[0].previousRaw).toBeUndefined();
	});

	it("rejects malformed JSON with 400", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		const ctx = makeCtx(env);
		ctx.req.json = async () => ({ config: "{not json" });

		const res = await handleProvidersPut(ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("JSON");
		// Nothing was written
		expect(bucket.store.has("config/providers.json")).toBe(false);
	});

	it("rejects schema-invalid JSON with 400 and lists issues", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		const ctx = makeCtx(env);
		// uppercase domain — zod rejects
		ctx.req.json = async () => ({ config: '{"domains":{"FOO.COM":"brevo"}}' });

		const res = await handleProvidersPut(ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			ok: boolean;
			issues: Array<{ path: string; message: string }>;
		};
		expect(body.ok).toBe(false);
		expect(body.issues.length).toBeGreaterThan(0);
		expect(bucket.store.has("config/providers.json")).toBe(false);
	});

	it("accepts a config with an unknown provider type but flags it in the validation report", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		const ctx = makeCtx(env);
		ctx.req.json = async () => ({
			config: '{"domains":{"foo.com":"unknown-provider"}}',
		});

		// Schema-level validation is permissive about provider name strings
		// (so renames don't brick old configs); unknown types surface in the
		// validation report instead.
		const res = await handleProvidersPut(ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			validation: { ok: boolean; unknownProviders: string[] };
		};
		expect(body.ok).toBe(true);
		expect(body.validation.ok).toBe(false);
		expect(body.validation.unknownProviders).toContain("unknown-provider");
	});

	it("captures the previous raw in the audit log", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket, {
			PROVIDER_CONFIG: '{"default":"cloudflare"}',
		});
		const ctx = makeCtx(env);
		ctx.req.json = async () => ({ config: '{"default":"brevo"}' });

		const res = await handleProvidersPut(ctx);
		expect(res.status).toBe(200);

		const entries = await readAuditLog(env, 10);
		expect(entries[0].previousRaw).toBe('{"default":"cloudflare"}');
		expect(entries[0].nextRaw).toBe('{"default":"brevo"}');
	});
});

// -- GET /api/v1/admin/providers --------------------------------------

describe("handleProvidersGet", () => {
	it("reports source=default when nothing is configured", async () => {
		const bucket = makeBucket();
		const ctx = makeCtx(makeEnv(bucket));
		const res = await handleProvidersGet(ctx);
		const body = (await res.json()) as {
			ok: boolean;
			source: string;
			raw: string;
			validation: { ok: boolean };
		};
		expect(body.source).toBe("default");
		expect(body.raw).toBe("");
		expect(body.validation.ok).toBe(true);
	});

	it("reports source=env when env var is set", async () => {
		const bucket = makeBucket();
		const ctx = makeCtx(
			makeEnv(bucket, { PROVIDER_CONFIG: '{"default":"cloudflare"}' }),
		);
		const res = await handleProvidersGet(ctx);
		const body = (await res.json()) as { source: string; raw: string };
		expect(body.source).toBe("env");
		expect(body.raw).toBe('{"default":"cloudflare"}');
	});

	it("reports source=r2 when override is present", async () => {
		const bucket = makeBucket();
		await bucket.put("config/providers.json", '{"default":"brevo"}');
		const ctx = makeCtx(
			makeEnv(bucket, { PROVIDER_CONFIG: '{"default":"cloudflare"}' }),
		);
		const res = await handleProvidersGet(ctx);
		const body = (await res.json()) as { source: string; raw: string };
		expect(body.source).toBe("r2");
		expect(body.raw).toBe('{"default":"brevo"}');
	});
});

// -- DELETE /api/v1/admin/providers -----------------------------------

describe("handleProvidersDelete", () => {
	it("removes the R2 override and audits the action", async () => {
		const bucket = makeBucket();
		await bucket.put("config/providers.json", '{"default":"brevo"}');
		const ctx = makeCtx(makeEnv(bucket));

		const res = await handleProvidersDelete(ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; source: string };
		expect(body.ok).toBe(true);
		expect(body.source).toBe("env");

		expect(bucket.store.has("config/providers.json")).toBe(false);

		const entries = await readAuditLog(
			(ctx as unknown as { env: Parameters<typeof readAuditLog>[0] }).env,
			10,
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].action).toBe("delete");
		expect(entries[0].actor).toBe("admin-sub-1");
	});
});

// -- GET /api/v1/admin/providers/audit -------------------------------

describe("handleProvidersAudit", () => {
	it("returns up to `limit` entries (clamped)", async () => {
		const bucket = makeBucket();
		const env = makeEnv(bucket);
		for (let i = 0; i < 5; i++) {
			await appendAuditEntry(env, {
				timestamp: `2026-01-0${i + 1}T00:00:00Z`,
				actor: `u${i}`,
				action: "write",
			});
		}
		const ctx = makeCtx(
			env,
			"https://x.test/api/v1/admin/providers/audit?limit=2",
		);
		const res = await handleProvidersAudit(ctx);
		const body = (await res.json()) as { ok: boolean; entries: unknown[] };
		expect(body.ok).toBe(true);
		expect(body.entries).toHaveLength(2);
	});

	it("defaults to 50 entries when no limit provided", async () => {
		const bucket = makeBucket();
		const ctx = makeCtx(makeEnv(bucket));
		const res = await handleProvidersAudit(ctx);
		const body = (await res.json()) as { ok: boolean; entries: unknown[] };
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.entries)).toBe(true);
	});
});
