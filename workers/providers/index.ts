// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Barrel export for the provider abstraction.
 *
 * Typical callers only need `sendEmail` from `./registry`. The classes are
 * exported for tests + future registry entries.
 */

export * from "./types";
export * from "./registry";
export { CloudflareEmailProvider } from "./cloudflare";
export {
	BrevoEmailProvider,
	type BrevoProviderOptions,
	type BrevoFetch,
} from "./brevo";