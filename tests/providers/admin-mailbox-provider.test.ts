// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the admin per-mailbox provider override endpoints
 * (FOLLOWUP-011).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleMailboxProviderGet,
	handleMailboxProviderPatch,
	handleMailboxProviderDelete,
	handleMailboxProviderAudit,
} from "../../workers/routes/admin-mailbox-provider";
import { _resetProviderCaches } from "../../workers/providers/registry";

// -- Fake R2 bucket --------------------------------------------------

interface R2Obj {
	text(): Promise<string>;
}

interface R2Obj {
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
}

class FakeBucket {
	store = new Map<string, string>();
	async get(key: string): Promise<R2Obj | null> {
		const v = this.store.get(key);
		if (v === undefined) return null;
		return {
			text: async () => v,
			json: async <T = unknown>() => JSON.parse(v) as T,
		};
	}
	async put(key: string, value: string): Promise<unknown> {
		this.store.set(key, value);
		return undefined;
	}
	async head(key: string): Promise<unknown> {
		return this.store.has(key) ? { key } : null;
	}
	async delete(key: string): Promise<boolean> {
		return this.store.delete(key);
	}
}

function makeEnvWithBucket(bucket: FakeBucket) {
	return {
		BUCKET: bucket,
		DEFAULT_PROVIDER: "cloudflare",
		PROVIDER_CONFIG: "",
	} as unknown as Parameters<typeof handleMailboxProviderGet>[0]["env"];
}

function makeCtx(
	env: unknown,
	url: string,
	method: "GET" | "PATCH" | "DELETE",
	body: unknown = undefined,
	mailboxId = "alice@example.com",
) {
	const headers = new Headers();
	return {
		env,
		var: { user: { id: "admin-sub-1", email: "a@x", role: "admin" } },
		req: {
			url,
			method,
			header: (n: string) => headers.get(n) ?? undefined,
			param: (n: string) => (n === "mailboxId" ? mailboxId : undefined),
			json: async () => body ?? {},
		},
		json: (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	} as unknown as Parameters<typeof handleMailboxProviderGet>[0];
}

beforeEach(() => {
	_resetProviderCaches();
});

describe("handleMailboxProviderGet", () => {
	it("returns null when no override is set", async () => {
		const bucket = new FakeBucket();
		await bucket.put("mailboxes/alice@example.com.json", JSON.stringify({}));
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"GET",
		);
		const res = await handleMailboxProviderGet(ctx);
		const body = (await res.json()) as { ok: boolean; provider: unknown };
		expect(body.ok).toBe(true);
		expect(body.provider).toBeNull();
	});

	it("returns the active override", async () => {
		const bucket = new FakeBucket();
		await bucket.put(
			"mailboxes/alice@example.com.json",
			JSON.stringify({ provider: { type: "brevo" } }),
		);
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"GET",
		);
		const res = await handleMailboxProviderGet(ctx);
		const body = (await res.json()) as { provider: { type: string } };
		expect(body.provider).toEqual({ type: "brevo" });
	});

	it("returns 404 when the mailbox does not exist", async () => {
		const bucket = new FakeBucket();
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/missing@example.com/provider",
			"GET",
		);
		const res = await handleMailboxProviderGet(ctx);
		expect(res.status).toBe(404);
	});
});

describe("handleMailboxProviderPatch", () => {
	it("sets an override and audits the change", async () => {
		const bucket = new FakeBucket();
		await bucket.put("mailboxes/alice@example.com.json", JSON.stringify({}));
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"PATCH",
			{ type: "brevo" },
		);
		const res = await handleMailboxProviderPatch(ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; provider: { type: string } };
		expect(body.provider).toEqual({ type: "brevo" });

		// R2 has the new settings.
		const storedText = await (
			await bucket.get("mailboxes/alice@example.com.json")
		)!.text();
		const stored = JSON.parse(storedText) as Record<string, unknown>;
		expect(stored).toEqual({ provider: { type: "brevo" } });

		// Audit log captured the write.
		const auditText = await (
			await bucket.get("config/mailbox-audit.jsonl")
		)!.text();
		const entries = auditText
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actor: "admin-sub-1",
			action: "set",
			mailboxId: "alice@example.com",
			previousType: null,
			nextType: "brevo",
		});
	});

	it("clears an existing override when type is null", async () => {
		const bucket = new FakeBucket();
		await bucket.put(
			"mailboxes/alice@example.com.json",
			JSON.stringify({
				provider: { type: "brevo" },
				fromName: "Alice",
			}),
		);
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"PATCH",
			{ type: null },
		);
		const res = await handleMailboxProviderPatch(ctx);
		expect(res.status).toBe(200);

		const storedText = await (
			await bucket.get("mailboxes/alice@example.com.json")
		)!.text();
		const stored = JSON.parse(storedText) as Record<string, unknown>;
		// provider is removed, other settings preserved
		expect(stored).toEqual({ fromName: "Alice" });
		expect(stored.provider).toBeUndefined();
	});

	it("rejects an unknown provider type with 400", async () => {
		const bucket = new FakeBucket();
		await bucket.put("mailboxes/alice@example.com.json", JSON.stringify({}));
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"PATCH",
			{ type: "unknown-provider" },
		);
		const res = await handleMailboxProviderPatch(ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Unknown provider");
	});

	it("returns 404 when the mailbox does not exist", async () => {
		const bucket = new FakeBucket();
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/missing@example.com/provider",
			"PATCH",
			{ type: "brevo" },
		);
		const res = await handleMailboxProviderPatch(ctx);
		expect(res.status).toBe(404);
	});

	it("rejects malformed body with 400", async () => {
		const bucket = new FakeBucket();
		await bucket.put("mailboxes/alice@example.com.json", JSON.stringify({}));
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"PATCH",
			{ type: 123 }, // wrong type
		);
		const res = await handleMailboxProviderPatch(ctx);
		expect(res.status).toBe(400);
	});
});

describe("handleMailboxProviderDelete", () => {
	it("clears the override and audits the change", async () => {
		const bucket = new FakeBucket();
		await bucket.put(
			"mailboxes/alice@example.com.json",
			JSON.stringify({ provider: { type: "brevo" } }),
		);
		const ctx = makeCtx(
			makeEnvWithBucket(bucket),
			"https://x.test/api/v1/admin/mailboxes/alice@example.com/provider",
			"DELETE",
		);
		const res = await handleMailboxProviderDelete(ctx);
		expect(res.status).toBe(200);
		const storedText = await (
			await bucket.get("mailboxes/alice@example.com.json")
		)!.text();
		const stored = JSON.parse(storedText) as Record<string, unknown>;
		expect(stored.provider).toBeUndefined();
	});
});

describe("handleMailboxProviderAudit", () => {
	it("returns recent entries newest-first", async () => {
		const bucket = new FakeBucket();
		const env = makeEnvWithBucket(bucket);
		await bucket.put("mailboxes/a@x.com.json", JSON.stringify({}));
		await bucket.put("mailboxes/b@x.com.json", JSON.stringify({}));
		const ctx1 = makeCtx(
			env,
			"https://x.test/api/v1/admin/mailboxes/a@x.com/provider",
			"PATCH",
			{ type: "brevo" },
			"a@x.com",
		);
		await handleMailboxProviderPatch(ctx1);
		const ctx2 = makeCtx(
			env,
			"https://x.test/api/v1/admin/mailboxes/b@x.com/provider",
			"PATCH",
			{ type: "cloudflare" },
			"b@x.com",
		);
		await handleMailboxProviderPatch(ctx2);

		const auditCtx = makeCtx(
			env,
			"https://x.test/api/v1/admin/mailboxes/provider-audit?limit=10",
			"GET",
		);
		const res = await handleMailboxProviderAudit(auditCtx);
		const body = (await res.json()) as { ok: boolean; entries: Array<{ mailboxId: string }> };
		expect(body.ok).toBe(true);
		expect(body.entries.map((e) => e.mailboxId)).toEqual(["b@x.com", "a@x.com"]);
	});
});
