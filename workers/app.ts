// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { createAuth } from "./auth/betterAuth";
import { sessionMiddleware } from "./auth/sessionMiddleware";
import type { Env } from "./types";
import type { AccessContext } from "./lib/context";
import { _runEagerValidation } from "./providers/registry";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Hono context type used by the outer middleware chain. Inner routers
// (apiApp, MCP) declare their own context types via the centralized
// definitions in `workers/lib/context.ts`.
const app = new Hono<AccessContext>();

// Plan D: better-auth endpoint. Registered BEFORE the session middleware
// below so /api/auth/* requests can be anonymous (sign-up, sign-in,
// forgot/reset). better-auth itself attaches the Set-Cookie header on
// successful sign-in/sign-up; downstream middleware picks it up.
app.all("/api/auth/*", (c) => {
	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

// FOLLOWUP-009: eager provider-config validation. Runs once per isolate on
// the first inbound request — we can't do this at module load because
// `env` isn't available until the worker handles a request. The flag inside
// `_runEagerValidation()` prevents repeated runs. Vitest tests bypass this
// code path because they never mount the Hono app.
let eagerValidationRan = false;
function runEagerValidationOnce(env: Env): void {
	if (eagerValidationRan) return;
	eagerValidationRan = true;
	_runEagerValidation(env);
}

// Plan D: better-auth session middleware (replaces the Cloudflare Access
// JWT middleware that lived here through Plan C). Loads the session via
// `auth.api.getSession` and populates `c.var.user` for downstream
// middlewares (`requireUser`, /mcp forwarding). Anonymous requests are
// valid; `requireUser` enforces 401 for protected routes.
app.use("*", async (c, next) => {
	// FOLLOWUP-009: validate PROVIDER_CONFIG once on first request.
	runEagerValidationOnce(c.env);
	return sessionMiddleware(c, next);
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });

/**
 * Forward a request to the MCP Durable Object, carrying the verified caller
 * identity via `X-User-*` headers. The DO is single-threaded, so its
 * `fetch` override can safely stash the caller into `this.caller` for
 * tool handlers to read.
 */
function forwardToMcp(c: any, handler: typeof mcpHandler) {
	const user = c.var.user;
	const headers = new Headers(c.req.raw.headers);
	if (user) {
		headers.set("X-User-Id", user.id);
		headers.set("X-User-Email", user.email);
		headers.set("X-User-Role", user.role);
	}
	const proxied = new Request(c.req.raw.url, {
		method: c.req.raw.method,
		headers,
		body: c.req.raw.body,
	});
	return handler.fetch(proxied, c.env, c.executionCtx as ExecutionContext);
}

app.all("/mcp", async (c) => forwardToMcp(c, mcpHandler));
app.all("/mcp/*", async (c) => forwardToMcp(c, mcpHandler));

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};