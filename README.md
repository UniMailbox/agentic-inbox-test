<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment: 
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Deploy to Cloudflare. The deploy flow will automatically provision R2, Durable Objects, and Workers AI. You'll be prompted for **DOMAINS**, which is the domain (yourdomain.com) you want to receive emails for (email@yourdomain.com).

     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agentic-inbox)

2. **Provision better-auth storage** -- The app uses Cloudflare D1 (binding `DB`) for users/sessions/accounts and a KV namespace (binding `SESSIONS_KV`) for session caching.

   ```bash
   wrangler d1 create agentic-inbox-db
   wrangler d1 migrations apply agentic-inbox-db --remote
   wrangler kv namespace create SESSIONS
   ```

   Then paste the returned `database_id` and KV namespace `id` into the matching entries in `wrangler.jsonc`. Re-run `npm run cf-typegen` so the new bindings appear in `Env`.

3. **Set the auth secrets** -- Generate a session-signing secret and a Resend API key (for verification / password-reset emails), then push them as Worker secrets:

   ```bash
   npx @better-auth/cli secret           # paste the output as BETTER_AUTH_SECRET
   wrangler secret put BETTER_AUTH_SECRET
   wrangler secret put RESEND_API_KEY     # from resend.com; "dev" logs links to wrangler dev output instead
   ```

   Also set the `BETTER_AUTH_URL` and `EMAIL_FROM` vars in `wrangler.jsonc` to your deployed URL and a verified Resend sender (e.g. `no-reply@yourdomain.com`).

4. **Bootstrap the first admin** -- List one or more emails in the `ADMIN_EMAILS` var in `wrangler.jsonc`. Anyone who signs up with that email gets the admin role automatically; everyone else lands in the `user` role and sees only mailboxes they've been granted access to.

5. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
6. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
7. **Sign up & create a mailbox** -- Open the deployed app, sign up (the verification email is sent through Resend), then visit `/admin` to create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Troubleshooting better-auth

1. If `/api/auth/sign-up/email` returns 500 with `Failed to send Resend ...` in the worker logs, `RESEND_API_KEY` is missing or invalid. Set it with `wrangler secret put RESEND_API_KEY` and re-deploy.
2. If verification emails don't arrive in dev, check the `wrangler dev` output — when `RESEND_API_KEY` is unset or `"dev"`, the worker console.logs the verification URL instead of sending (mirrors the existing dev pattern for `ADMIN_EMAILS`).
3. If you're locked out as the last admin, set `ADMIN_EMAILS` to your email, `wrangler deploy`, and sign in again — the role bootstrap fires on every successful sign-in.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/moonshotai/kimi-k2.5`), `react-markdown` + `remark-gfm`
- **Auth:** Email + password via better-auth (D1 + KV session cache; Resend for verification / reset); per-mailbox grants enforced via `ADMIN_EMAILS` + `/admin` UI. TOTP MFA is a follow-up.

## Getting Started

```bash
npm install
npm run dev
```

### Tests

```bash
npm test                              # 188 unit tests across 14 files
npm run check:no-env-leak             # forbidden env-logging guard
npm run check:secrets-vs-types        # secret-vs-Env declaration guard

# Real-API integration tests (requires a Brevo test key):
BREVO_API_KEY=<key> npm test -- tests/integration
```

Unit tests run offline against in-memory fakes and mock fetch; the
integration suite hits the real Brevo API. CI (`.github/workflows/ci.yml`)
runs unit + guards on every PR and integration only on pushes to `main`
where the `BREVO_API_KEY` secret is available.

### Configuration

1. Set your domain(s) in `wrangler.jsonc` (`DOMAINS` is a comma-separated list — see [Multiple domains](#multiple-domains) below)
2. Create an R2 bucket named `agentic-inbox`: `wrangler r2 bucket create agentic-inbox`

### Multiple domains

`DOMAINS` accepts a comma-separated list of zones that have [Email Routing](https://developers.cloudflare.com/email-routing/) enabled. The first value is treated as the **default domain** in the UI; the others are selectable when creating a mailbox.

```jsonc
"vars": {
  "DOMAINS": "example.com,foo.com,bar.com",
  "EMAIL_ADDRESSES": []
}
```

Operational notes:

- **One Worker, many zones.** Cloudflare Email Routing only delivers mail for the zone on which the catch-all rule is configured. You must add a catch-all rule (`*@example.com → Worker`, `*@foo.com → Worker`, etc.) in **each** zone's Email Routing dashboard, all pointing to this same Worker.
- **Default domain.** Only the first entry in `DOMAINS` is shown in the UI as the default; other entries appear in the domain picker when creating mailboxes.
- **Changing `DOMAINS` locally.** Edit `wrangler.jsonc` (or `.dev.vars` if you have one) and **restart `wrangler dev`** — `vars` are loaded at boot, not hot-reloaded. The UI refetches on focus/reload after restart.
- **Inbound delivery to the right mailbox.** When a message arrives, the worker picks the **first recipient whose domain is in `DOMAINS`** (or whose address is in `EMAIL_ADDRESSES`, which takes precedence). One inbound message is delivered to exactly one mailbox; cross-domain recipients on the same message are not split into multiple mailboxes.
- **Outbound mail.** The `From` address of every outgoing email is the mailbox address itself, so the displayed sender domain is whichever domain the mailbox was created on. Make sure outbound `send_email` is enabled for every zone in the Email Service dashboard.
- **Per-domain allow-list.** When `EMAIL_ADDRESSES` is empty, mailboxes can only be created on addresses whose domain is in `DOMAINS`. With `EMAIL_ADDRESSES` set, that explicit allow-list takes precedence and `DOMAINS` still gates inbound delivery (the recipient domain must match one of the configured zones).
- **Safety net.** If neither `EMAIL_ADDRESSES` nor `DOMAINS` is configured, inbound mail is refused (logged and dropped). Configure at least one before expecting to receive anything.
- **Multi-domain ≠ multi-tenant.** Admins (configured via `ADMIN_EMAILS`) see every mailbox; everyone else only sees mailboxes they've been granted access to on `/admin` → Mailbox access. Each grant can be `read`, `write`, `delete`, or `manage` (which implies all the others).

### Deploy

```bash
npm run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- A [Resend](https://resend.com/) account + API key (for better-auth verification / password-reset emails)
- A D1 database + KV namespace (better-auth storage)

Any signed-up user is recognized by the app. Admins (anyone listed in the `ADMIN_EMAILS` env var) can see and manage every mailbox; non-admins only see mailboxes they have been granted access to on the `/admin` page.

The MCP server at `/mcp` enforces the same per-mailbox grants: external AI tools (Claude Code, Cursor, etc.) connected via MCP operate on a mailbox only if the calling user has the required permission (`read`/`write`/`delete`/`manage`) on it. `manage` implies all others.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## Email sending providers

The worker ships with a pluggable provider abstraction in `workers/providers/`. Each registered provider knows how to send one `EmailMessage`; the registry routes outgoing mail by the sender's domain so different `from` domains can use different backends.

### Built-in providers

| Provider | `name` | Backed by | Notes |
|---|---|---|---|
| **Cloudflare Email Service** | `"cloudflare"` | `env.EMAIL.send()` binding | Default. Always available when the binding is declared. |
| **Brevo** | `"brevo"` | `https://api.brevo.com/v3/smtp/email` | Requires `BREVO_API_KEY` secret (`wrangler secret put BREVO_API_KEY`). The `From` address must be on Brevo's verified-senders list. |

### Resolution precedence

The sender's domain is looked up in this order; the first match wins:

1. **Per-mailbox override** — `mailboxes/{email}.json` → `settings.provider.type` (admin-only)
2. **`PROVIDER_CONFIG.domains[domain]`** — operator-defined routing
3. **`PROVIDER_CONFIG.default`** — operator-defined fallback
4. **`DEFAULT_PROVIDER`** env var
5. **`"cloudflare"`** — hard-coded last resort

### Configuration

Route `foo.com` to Brevo and keep Cloudflare as the default for everything else:

```jsonc
// wrangler.jsonc
"vars": {
  "DEFAULT_PROVIDER": "cloudflare",
  "PROVIDER_CONFIG": "{\"domains\":{\"foo.com\":\"brevo\"}}"
}
```

```bash
# Brevo secret (only required if any domain maps to brevo)
wrangler secret put BREVO_API_KEY
```

Because `wrangler.jsonc` is JSON, the embedded JSON in `PROVIDER_CONFIG` must escape its inner quotes. The same config in a TOML `.dev.vars` is unescaped:

```toml
# .dev.vars (local dev only)
DEFAULT_PROVIDER = "cloudflare"
PROVIDER_CONFIG = '{"domains":{"foo.com":"brevo"}}'
```

#### Escape cheat sheet (FOLLOWUP-008)

Wrangler vars live inside JSON, so each `"` inside the value must be `\"`. The most common shapes:

| Shape                                              | JSON value                                                      |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Default-only                                       | `"{}"`                                                          |
| One domain                                         | `"{\"domains\":{\"foo.com\":\"brevo\"}}"`                        |
| Multiple domains                                   | `"{\"domains\":{\"foo.com\":\"brevo\",\"bar.com\":\"cloudflare\"}}"` |
| Domain with fallback                               | `"{\"domains\":{\"foo.com\":{\"type\":\"brevo\",\"fallback\":\"cloudflare\"}}}"` |
| Domain + global default                            | `"{\"domains\":{\"foo.com\":\"brevo\"},\"default\":\"cloudflare\"}"` |

If you find the escaping unreadable, paste your intended config into a [JSON escape tool](https://www.freeformatter.com/json-escape.html) ("escape JavaScript string" mode), or set the value through R2 instead (see [Hot reload via admin API](#hot-reload-via-admin-api) below).

#### Hot reload via admin API (FOLLOWUP-006)

Operators can override `PROVIDER_CONFIG` at runtime without redeploying by writing it to the R2 bucket as `config/providers.json`. The registry reads R2 first, then falls back to the env var, so the override takes effect on the next send in any isolate (no cache flush needed; the composite config key auto-invalidates `instanceCache` + `domainCache`).

```bash
# Sign in once and stash the session cookie (better-auth sets it as HttpOnly)
curl -c cookies.txt -X POST https://<your-worker>/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin-email>","password":"<password>"}'

# Write / replace the override
curl -X PUT https://<your-worker>/api/v1/admin/providers \
  -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"config":"{\"domains\":{\"foo.com\":\"brevo\"}}"}'

# Read the active config (R2 if set, else env var)
curl https://<your-worker>/api/v1/admin/providers -b cookies.txt

# Drop the override (subsequent reads fall back to env var)
curl -X DELETE https://<your-worker>/api/v1/admin/providers -b cookies.txt

# View the audit log (newest first; default limit 50, max 500)
curl 'https://<your-worker>/api/v1/admin/providers/audit?limit=20' -b cookies.txt

# Liveness + circuit-breaker snapshot (any provider with an open breaker
# shows up here; failures trip the breaker at 5 consecutive errors)
curl https://<your-worker>/api/v1/admin/providers/health -b cookies.txt
```

The audit log is appended to `config/audit.jsonl` (JSONL; one entry per write/delete with `timestamp`, `actor`, `action`, `previousRaw`, `nextRaw`).

#### Delivery status webhooks (FOLLOWUP-004)

To track whether the recipient's MTA accepted a message sent through Brevo, register a transactional webhook in the Brevo dashboard pointing at:

```
https://<your-worker>/api/v1/webhooks/brevo
```

Set the webhook signing secret in both Brevo and Cloudflare:

```bash
wrangler secret put BREVO_WEBHOOK_SECRET
# value: same secret you configured in Brevo
```

Brevo events are mapped to the `delivery_status` column on the email row:

| Brevo event         | `delivery_status` |
| ------------------- | ----------------- |
| `request`           | `accepted`        |
| `delivered`         | `delivered`       |
| `hard_bounce` / `soft_bounce` / `blocked` / `invalid_email` | `bounced` |
| `spam`              | `spam`            |
| `deferred`          | `deferred`        |
| `error`             | `failed`          |
| `opened`            | `opened`          |
| `click`             | `clicked`         |

### Adding a new provider

1. Create `workers/providers/<name>.ts` with `class XProvider implements EmailProvider`.
2. Register it in `PROVIDERS` inside `workers/providers/registry.ts`.
3. Add the matching secret via `wrangler secret put <NAME>_API_KEY` and re-run `wrangler types`.
4. Reference it in `PROVIDER_CONFIG.domains`.

No call-site changes are required — `sendEmail(env, msg)` resolves the adapter transparently.

#### Per-mailbox provider override (FOLLOWUP-011)

The mailbox creation endpoint (`POST /api/v1/mailboxes`) and the
mailbox settings endpoint (`PUT /api/v1/mailboxes/:id`) both apply a
strict zod schema that excludes the `provider` field. The dedicated
admin endpoints are the only way to change which provider a single
mailbox routes through. Each change is audited to
`config/mailbox-audit.jsonl`.

```bash
# Read the current override (or null)
curl https://<your-worker>/api/v1/admin/mailboxes/alice@example.com/provider \
  -b cookies.txt

# Set an override
curl -X PATCH https://<your-worker>/api/v1/admin/mailboxes/alice@example.com/provider \
  -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"type":"brevo"}'

# Clear the override (next send falls back to PROVIDER_CONFIG / DEFAULT_PROVIDER)
curl -X DELETE https://<your-worker>/api/v1/admin/mailboxes/alice@example.com/provider \
  -b cookies.txt
# — or —
curl -X PATCH .../provider -b cookies.txt -d '{"type":null}'

# Audit log (newest first)
curl 'https://<your-worker>/api/v1/admin/mailboxes/provider-audit?limit=20' \
  -b cookies.txt
```

The `provider` field on the mailbox JSON is only written by these
endpoints. POST/PUT mailbox returns `400` if `settings.provider` is
included.

#### Sanitization guard (FOLLOWUP-010)

To prevent accidentally logging the entire `env` object (which would
expose every Cloudflare secret in `wrangler tail`), run
[`scripts/check-no-env-leak.sh`](scripts/check-no-env-leak.sh) before
committing:

```bash
bash scripts/check-no-env-leak.sh
# check-no-env-leak: clean
```

Wire it into your editor or CI as desired; the script is dependency-free
bash + grep. It catches `console.log(env)` / `console.error(env)` /
`JSON.stringify(env)` patterns. Nested leaks (`{ k: env }`, `[env]`)
require an AST-aware tool — see the script header for known limitations.

### Limitations (as of v1.1)

- **Provider limits are enforced synchronously.** `validateMessage()` rejects over-limit messages before they reach the provider — calls that previously failed in `waitUntil` now return `4xx` immediately. Provider limits are conservative defaults; consult each provider's docs for exact caps.
- **Failover with circuit breaker.** Each provider tracks consecutive failures in a module-level breaker (threshold 5, cool-off 30s); once open, sends short-circuit to a configured `fallback` if any, otherwise fail fast. Success resets the counter. (`FOLLOWUP-005`)
- **Delivery status is recorded for Brevo only.** Cloudflare's email worker doesn't expose delivery events, so `delivery_status` for CF-routed mail stays at `sent`. Brevo's transactional webhook updates the row on `delivered` / `bounced` / etc. (`FOLLOWUP-004`)
- **Hot reload via R2 admin API.** `PUT /api/v1/admin/providers` writes R2 `config/providers.json` and audits the change. The composite config key (source + raw + `DEFAULT_PROVIDER`) auto-invalidates the per-isolate caches so the next send picks up the new routing. (`FOLLOWUP-006`)
- **Eager validation at first request.** Invalid `PROVIDER_CONFIG` (JSON or schema) is logged once per isolate on the first inbound request. The health endpoint surfaces all issues for diagnostics. (`FOLLOWUP-009`)
- **Sender domain normalization.** Unicode domains (IDN) are converted to ASCII via punycode before lookup, but quoted local parts (`"john doe"@example.com`) and other RFC 5322 edge cases are not deeply parsed. The `from` address must already be plain enough for `extractDomain(msg.from)` to work.
- **Configuration UX.** JSON-in-env-var still requires escaping inside `wrangler.jsonc`; the [escape cheat sheet](#escape-cheat-sheet-followup-008) above mitigates this. For complex routing prefer the R2 admin API.

## License

Apache 2.0 -- see [LICENSE](LICENSE).
