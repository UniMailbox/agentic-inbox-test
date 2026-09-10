// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Zod schema for `PROVIDER_CONFIG`.
 *
 * Two shapes are accepted:
 *   - String: `"brevo"` (no failover)
 *   - Object: `{ "type": "brevo", "fallback": "cloudflare" }` (FOLLOWUP-005)
 *
 * Each `type` must match a registered provider name. We can't statically
 * validate that here (the registry is built at runtime); the eager
 * validator (see `validateConfig()` in `registry.ts`) cross-references
 * PROVIDERS to surface unknown types early.
 */
import { z } from "zod";

const DomainLabelSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(/^[a-z0-9.\-]+$/, {
		message: "domain label may only contain lowercase letters, digits, '.', '-'",
	})
	.refine((s) => s.split(".").length >= 2, {
		message: "domain must contain at least one dot",
	});

const ProviderNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, {
		message: "provider name must be lowercase alphanumeric/underscore/hyphen",
	});

const EntrySchema = z.union([
	ProviderNameSchema,
	z.object({
		type: ProviderNameSchema,
		fallback: ProviderNameSchema.optional(),
	}),
]);

export const ProviderConfigSchema = z
	.object({
		domains: z
			.record(DomainLabelSchema, EntrySchema)
			.optional()
			.describe("Map of sender domain → provider entry."),
		default: EntrySchema.optional().describe(
			"Fallback provider when domain lookup misses.",
		),
	})
	.strict();

export type ValidatedProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ValidatedEntry = z.infer<typeof EntrySchema>;