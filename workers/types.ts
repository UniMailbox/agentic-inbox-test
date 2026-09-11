// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Worker env interface.
 *
 * `wrangler types` populates `Cloudflare.Env` with literal-typed `vars`
 * (e.g. `EMAIL_FROM: "no-reply@example.com"`). For vars/secrets we want
 * to treat as `string | undefined` (because they may be unset or come
 * from `.dev.vars`), we intersect the auto-generated shape with optional
 * overrides so the resulting type stays a subtype of `Cloudflare.Env`
 * (required by external generic constraints like `McpAgent<Env>`).
 */
export type Env = Cloudflare.Env & {
	// Plan D: better-auth bindings (D1 + KV session cache).
	DB: D1Database;
	SESSIONS_KV: KVNamespace;

	// Plan D: better-auth secrets/vars. Declared optional so the project
	// typechecks before they are provisioned.
	/** `wrangler secret put BETTER_AUTH_SECRET` — signs cookies/tokens. */
	BETTER_AUTH_SECRET?: string;
	/** From address for verification/reset emails (must be a verified Resend sender). */
	EMAIL_FROM?: string;
	/** `wrangler secret put RESEND_API_KEY` — used by workers/auth/sendEmail.ts. */
	RESEND_API_KEY?: string;

	/**
	 * Brevo transactional API key. Set via `wrangler secret put BREVO_API_KEY`.
	 * Declared here as `string | undefined` so the project typechecks before the
	 * secret is provisioned; the Brevo provider throws `EmailProviderConfigError`
	 * at construction time if the value is missing.
	 *
	 * After running `wrangler secret put BREVO_API_KEY` once, re-running
	 * `wrangler types` will narrow this to `string`.
	 */
	BREVO_API_KEY?: string;

	/**
	 * Brevo webhook signing secret. Set via
	 * `wrangler secret put BREVO_WEBHOOK_SECRET`. Required for the
	 * `/api/v1/webhooks/brevo` endpoint to accept delivery-status events
	 * (FOLLOWUP-004). Configure the same value as the "webhook secret"
	 * in the Brevo dashboard when registering the webhook URL.
	 */
	BREVO_WEBHOOK_SECRET?: string;

	/**
	 * Config source order for PROVIDER_CONFIG (FOLLOWUP-012). Comma-
	 * separated list of source names tried in order; first non-empty
	 * wins. Valid names: `r2`, `env`. Default: `r2,env`.
	 *
	 * Example: `"env,r2"` to prefer the env var over R2 in environments
	 * where the env is the source of truth.
	 */
	CONFIG_SOURCE?: string;
};
