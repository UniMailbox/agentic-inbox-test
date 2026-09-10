// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Vitest config — pure unit tests only. No worker runtime, no bindings.
 * Tests in `tests/providers/` exercise the provider abstraction: pure
 * functions (domain normalization, config parsing) plus a mockable fetch
 * for the Brevo adapter.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});