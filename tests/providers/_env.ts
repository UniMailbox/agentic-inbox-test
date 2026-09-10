// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared env stub factory for provider tests. Because `loadProviderConfigRaw`
 * now reads from R2 first, every test env must include a `BUCKET` that returns
 * null/undefined for the config key (so the fallback to `PROVIDER_CONFIG`
 * env var behaves as before).
 */
import { vi } from "vitest";
import type { Env } from "../../workers/types";

interface R2ObjectLike {
	text(): Promise<string>;
}

interface R2BucketLike {
	get(key: string): Promise<R2ObjectLike | null>;
	put(key: string, value: string, opts?: unknown): Promise<unknown>;
	delete(key: string): Promise<unknown>;
}

/** Build an empty R2 stub that returns null for any get(). */
export function makeBucket(overrides: Partial<R2BucketLike> = {}): R2BucketLike {
	return {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
		...overrides,
	};
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		POLICY_AUD: "aud",
		TEAM_DOMAIN: "team.cloudflareaccess.com",
		EMAIL: {
			send: vi.fn(async () => ({ messageId: "cf-1" })),
		} as unknown as Env["EMAIL"],
		BUCKET: makeBucket() as unknown as Env["BUCKET"],
		BREVO_API_KEY: undefined,
		DEFAULT_PROVIDER: "cloudflare",
		PROVIDER_CONFIG: "",
		...overrides,
	} as unknown as Env;
}
