// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * @deprecated Direct import paths have moved to `./providers/...`. This
 * file is preserved as a back-compat shim so existing `import { sendEmail }
 * from "./email-sender"` lines keep working. The exported function now
 * performs per-domain provider routing via the registry.
 *
 * New code should import directly from `./providers/registry` or
 * `./providers` (barrel).
 */

export type { EmailMessage as SendEmailParams } from "./providers/types";
export { sendEmail } from "./providers/registry";