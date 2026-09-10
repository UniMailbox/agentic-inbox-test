// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Admin health endpoint for the email provider abstraction.
 *
 * `GET /api/v1/admin/providers/health` — returns:
 *   - parsed PROVIDER_CONFIG validation report
 *   - per-provider circuit-breaker snapshot
 *   - per-provider liveness (calls each provider's `healthCheck()` if defined)
 *
 * Intended for an operator dashboard (Phase 4 UI) or a curl smoke test.
 * Mount with `requireAdmin` middleware in `workers/index.ts`.
 *
 * @see FOLLOWUP-009
 */
import type { Context } from "hono";
import {
	getBreakerSnapshot,
	isBreakerOpen,
} from "../providers/circuit-breaker";
import {
	PROVIDERS,
	getProviderForDomain,
	validateConfig,
	type MailboxProviderSettings,
} from "../providers/registry";
import type { MailboxContext } from "../lib/context";

type AppContext = Context<MailboxContext>;

export async function handleProvidersHealth(c: AppContext): Promise<Response> {
	const env = c.env;
	const report = await validateConfig(env);
	const breakers = getBreakerSnapshot();

	// Build per-provider health by calling each provider's healthCheck().
	// Each call has its own timeout; a slow/dead provider shouldn't block
	// the whole response.
	const providerHealth: Record<string, { ok: boolean; reason?: string }> = {};
	for (const name of Object.keys(PROVIDERS)) {
		try {
			const dummySettings: MailboxProviderSettings | null = null;
			const provider = await getProviderForDomain(env, name, dummySettings);
			if (typeof provider.healthCheck === "function") {
				providerHealth[name] = await provider.healthCheck();
			} else {
				providerHealth[name] = { ok: true, reason: "no healthCheck defined" };
			}
		} catch (e) {
			providerHealth[name] = {
				ok: false,
				reason: (e as Error).message,
			};
		}
	}

	return c.json({
		validation: {
			ok: report.ok,
			parsed: report.parsed,
			source: report.source,
			issues: report.issues,
			warnings: report.warnings,
			referencedProviders: report.referencedProviders,
			unknownProviders: report.unknownProviders,
		},
		config: report.config,
		providers: Object.keys(PROVIDERS).map((name) => ({
			name,
			health: providerHealth[name],
			breaker: breakers[name]
				? {
						failures: breakers[name].failures,
						successes: breakers[name].successes,
						open: isBreakerOpen(name),
						openUntil: breakers[name].openUntil || undefined,
					}
				: null,
		})),
	});
}