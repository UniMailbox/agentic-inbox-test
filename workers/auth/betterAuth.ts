// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Better-auth instance for the Agentic Inbox worker.
 *
 * Mounted at `/api/auth/*` (see `workers/app.ts`). Owns:
 *  - Drizzle adapter against Cloudflare D1 (binding `DB`)
 *  - KV session cache (binding `SESSIONS_KV`, via `better-auth-cloudflare`)
 *  - email + password with verification and password reset
 *  - three custom columns on `user`: `role`, `active`, `twoFactorEnabled`
 *  - the `twoFactor` plugin registered (but no enforcement) so Plan E can
 *    flip a single config flag without a schema migration
 *
 * Idempotent: `createAuth(env)` returns a fresh instance per call. Worker
 * isolates are short-lived so we don't memoize.
 */
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { withCloudflare } from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/d1";

import { schema } from "./d1Schema";
import { sendEmail } from "./sendEmail";
import { adminEmailSet } from "../lib/auth";
import type { Env } from "../types";

// `createAuth` returns `betterAuth(...)` whose fully-inferred type
// transitively references `better-auth/node_modules/zod/v4/core`. TS refuses
// to *name* that type in a declaration file ("type cannot be named without a
// reference"). We cast to the portable generic `ReturnType<typeof betterAuth>`
// so the exported signature stays usable while staying portable across zod
// installs. Callers only need `.handler` / `.api`, which are invariant.
export function createAuth(env: Env) {
	const cfOptions = {
		d1: {
			db: drizzle(env.DB, { schema, casing: "snake_case" }),
		},
		kv: env.SESSIONS_KV,
		geolocationTracking: false,
	};

	const authOptions = {
		secret: env.BETTER_AUTH_SECRET ?? "dev-only-secret-do-not-use-in-prod",
		baseURL: env.BETTER_AUTH_URL,
		trustedOrigins: [
			env.BETTER_AUTH_URL ?? "http://localhost:5173",
			"http://localhost:5173",
			"http://127.0.0.1:5173",
		],
		cookiePrefix: "agentic_inbox",
		advanced: {
			useSecureCookies: env.BETTER_AUTH_URL?.startsWith("https://") ?? false,
			defaultCookieAttributes: { sameSite: "lax" as const },
		},
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: false,
			minPasswordLength: 8,
			maxPasswordLength: 128,
			autoSignIn: true,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
				await sendEmail(env, undefined, {
					to: user.email,
					subject: "Reset your Agentic Inbox password",
					text: `Click the link below to reset your password:\n\n${url}\n\nIf you didn't request this, ignore this email.`,
				});
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
				await sendEmail(env, undefined, {
					to: user.email,
					subject: "Verify your Agentic Inbox email",
					text: `Click the link below to verify your email:\n\n${url}\n\nThis link expires in 1 hour.`,
				});
			},
		},
		user: {
			additionalFields: {
				role: {
					type: ["admin", "user"] as Array<"admin" | "user">,
					required: false,
					defaultValue: "user" as const,
					input: false,
				},
				active: {
					type: "boolean" as const,
					required: false,
					defaultValue: true,
					input: false,
				},
				twoFactorEnabled: {
					type: "boolean" as const,
					required: false,
					defaultValue: false,
					input: false,
					returned: true,
				},
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user: { email?: string }) => {
						const admins = adminEmailSet(env);
						const email = user.email?.toLowerCase();
						const role = email && admins.has(email) ? "admin" : "user";
						return { data: { ...user, role } };
					},
				},
			},
		},
		plugins: [
			twoFactor({
				issuer: "Agentic Inbox",
			}),
		],
	};

	// Cast: `better-auth-cloudflare` pins an older `@cloudflare/workers-types`
	// whose `KVNamespace.get` is narrower than the version `wrangler types`
	// generates. Runtime is identical. Same reason for the `as unknown` on
	// authOptions (readonly tuple vs mutable plugin array from the `as const`
	// we don't write but that the array literal infers).
	return betterAuth(
		withCloudflare(
			cfOptions as unknown as Parameters<typeof withCloudflare>[0],
			authOptions as unknown as Parameters<typeof betterAuth>[0],
		),
	) as unknown as ReturnType<typeof betterAuth>;
}

export type AppAuth = Awaited<ReturnType<typeof createAuth>>;
