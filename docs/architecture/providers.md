# Email sending providers

This document is the canonical architecture reference for the
pluggable email-sending provider abstraction. It complements
`README.md` (operator-facing) with the design rationale, scope, and
explicit non-goals that should anchor every PR touching the providers
subsystem.

## Goals (in scope)

1. **Pluggable backends** — adding a new email provider (SES, Resend,
   Postmark, SendGrid) is a 3-step change that touches no call sites.
2. **Per-domain routing** — `me@foo.com` can route to Brevo while
   `me@bar.com` continues to use Cloudflare, all from one Worker.
3. **Hot-reloadable routing** — operators can change routing without
   redeploy via `PUT /api/v1/admin/providers` (R2-backed override).
4. **Automatic failover** — `{ type, fallback }` config + circuit
   breaker per provider (FOLLOWUP-005).
5. **Delivery visibility** — the SENT row records `provider_name` /
   `provider_meta` / `delivery_status`; provider webhooks update it
   (FOLLOWUP-004 / FOLLOWUP-013).
6. **Eager validation** — invalid `PROVIDER_CONFIG` is logged once per
   isolate on the first inbound request, surfaced via the admin health
   endpoint (FOLLOWUP-009).

## Non-goals (explicit out-of-scope)

The following are intentionally NOT supported. PRs that try to add them
must be split into a separate discussion / RFC. This is the
`I1 feature creep` guard called out in the master plan.

| Non-goal                              | Why we reject it today                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| **Provider-level retry policy**       | The circuit breaker already absorbs transient errors; per-attempt retries amplify load on the failing provider and complicate the half-open semantics. Retries belong at the breaker, not the call site. |
| **Weighted routing (A/B test)**       | Per-domain routing is the unit. Weighted splits require persistence (Redis / DO) for the cohort assignment and add a new failure mode (DO down → which arm?). If a real A/B need appears, build it as an explicit "experiment" provider that wraps two real providers. |
| **Sticky routing by sender / cohort** | Same reason as weighted. The data store becomes load-bearing for correctness. |
| **Per-mailbox SMTP relay / custom MX** | A provider sends; it doesn't receive. Inbound mail is handled by Cloudflare Email Routing → this Worker. If a mailbox needs custom MX, that's an Email Routing config, not a provider feature. |
| **Provider failover for inbound mail** | Inbound is single-path (CF Email Routing → Worker → DO). Failover would mean two ingress points, two DOs, conflict resolution. Not worth it at our scale. |
| **Auto-discovery of providers**       | The `PROVIDERS` map in `workers/providers/registry.ts` is the registry. Dynamic loading from R2/KV adds attack surface (a malicious config could swap providers) and complicates the secret-binding story. |
| **Cross-provider dedup / dedupe keys** | Each provider has its own `messageId` namespace. Translating between them requires a stable local key per send — we have `outgoingMessageId`, but tying it across providers is brittle. Skip. |
| **Provider-side HTML transformation** | `EmailMessage.html` is canonical. Provider-specific sanitization (e.g. rewriting links for click-tracking) is the provider's job; we don't double-process. |

If a feature doesn't fit cleanly into the goals above, the answer is
**"build a wrapper provider that delegates"**, not "extend the
abstraction". Example: an "experiment" provider that randomly chooses
between Brevo and Cloudflare per-send, with the breaker applied to
each arm independently.

## Layering

```
            ┌──────────────────────────────────────┐
            │ workers/index.ts (call sites)         │
            │ sendEmail(env, msg, settings?)        │
            └──────────────────────────────────────┘
                              │
                              ▼
            ┌──────────────────────────────────────┐
            │ providers/registry.ts                │
            │  - resolveDomainRoute (precedence)   │
            │  - sendEmail (failover + breaker)    │
            │  - parseProviderConfig               │
            │  - validateConfig                    │
            └──────────────────────────────────────┘
                │                  │                │
                ▼                  ▼                ▼
   providers/             providers/        providers/
   config-source.ts        schema.ts         circuit-breaker.ts
   (R2 / env chain)        (zod)            (per-isolate state)
                │
                ▼
   providers/cloudflare.ts / brevo.ts / <future>.ts
                │
                ▼
   external HTTP API or Workers binding
```

## Provider contract

Each provider implements `EmailProvider` (see `workers/providers/types.ts`):

```ts
interface EmailProvider {
  readonly name: string;
  validateMessage(msg: EmailMessage): { ok: boolean; reason?: string };
  send(msg: EmailMessage): Promise<SendResult>;
  healthCheck?(): Promise<{ ok: boolean; reason?: string }>;
}
```

Two rules every provider must follow:

1. **`send()` errors must be sanitized.** The error message MUST NOT
   contain the request body, the API key, or attachment contents.
   `EmailProviderError` carries `{ code, cause? }` metadata — use the
   `code` to label the failure, not the body. Brevo truncates its
   vendor error to 200 chars; Cloudflare exposes only the numeric
   status and error name. Both are audit-checked in code review.

2. **`static readonly name` is public API.** Renaming a provider
   (e.g. `"cloudflare"` → `"cf"`) is a breaking change for every
   `PROVIDER_CONFIG` already deployed. See
   [`docs/provider-registry.md`](../provider-registry.md) for the
   deprecation policy.

## Adding a new provider

1. Create `workers/providers/<name>.ts` with
   `class XProvider implements EmailProvider`. The class file is the
   only place that imports the vendor SDK.
2. Add one entry to `PROVIDERS` in `workers/providers/registry.ts`.
3. Add the secret via `wrangler secret put <NAME>_API_KEY` (or
   equivalent). Re-run `wrangler types` so the secret appears on
   `Env`.
4. Add a webhook handler in `workers/routes/webhooks-<name>.ts` if
   the provider supports transactional webhooks; route it through
   `deliveryEventToUpdate(...)` so the DB column stays canonical
   (FOLLOWUP-013).
5. Update `.dev.vars.example` with the new secret name + a comment.
6. Add unit tests in `tests/providers/<name>.test.ts` covering at
   least: `send` 2xx / 4xx / 5xx paths, preflight limit rejection,
   `healthCheck` happy + failure paths, error sanitization (no
   `body` / `key` leak).
7. Document the provider in the README's "Built-in providers" list.

## Limits

Provider limits are enforced by `validateMessage()` BEFORE the request
leaves the Worker (FOLLOWUP-002). Defaults are conservative; consult
each provider's docs before claiming higher limits.

| Provider    | Max size | Max recipients | Max custom headers |
| ----------- | -------- | -------------- | ------------------ |
| cloudflare  | 5 MiB    | 50             | 20                 |
| brevo       | 25 MiB   | 50             | 30                 |
| <new>       | ?        | ?              | ?                  |

When you add a provider, set its `static readonly limits: ProviderLimits`
and add a row to this table.

## Audit / observability

- `GET /api/v1/admin/providers/health` — validation report + circuit
  breaker snapshot + per-provider healthCheck probes.
- `GET /api/v1/admin/providers/audit` — recent routing-config changes.
- `GET /api/v1/admin/mailboxes/provider-audit` — per-mailbox override
  changes.
- `wrangler tail` — logs only; never the raw env (FOLLOWUP-010).

## See also

- `docs/provider-registry.md` — name stability policy.
- `README.md` — operator-facing setup, escape cheat sheet, curl
  examples for the admin endpoints.
- Master plan file at the repo root (committed alongside Phase 1) —
  full risk register and the 17 FOLLOWUP-XXX items.
