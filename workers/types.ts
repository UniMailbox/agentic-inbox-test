// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;

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
}
