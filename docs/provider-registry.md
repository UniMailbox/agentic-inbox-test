# Provider registry — public API contract

This document defines the **public API surface** of the email-sending
provider abstraction. Anyone deploying a `PROVIDER_CONFIG` relies on
the names listed here; breaking them without a deprecation path is a
user-visible incident.

## The contract

For every provider registered in `workers/providers/registry.ts`:

```ts
class XProvider implements EmailProvider {
  static readonly name = "<vendor-key>";
  // ...
}
```

1. **`static readonly name` is the public, stable identifier.** It
   appears in:
   - `PROVIDER_CONFIG.domains[domain] = "<name>"`
   - `PROVIDER_CONFIG.domains[domain].type = "<name>"`
   - `PROVIDER_CONFIG.domains[domain].fallback = "<name>"`
   - `mailboxes/<email>.json` → `settings.provider.type = "<name>"`
   - `wrangler tail` logs (`provider: <name>`)
   - The SENT row's `provider_name` column

2. **A name, once published, is permanent.** Removing a name
   unconditionally is a breaking change. The migration path is:

   - Add the new name as an additional `static readonly name` (or
     register a second class under a new name).
   - Update the registry map to accept BOTH names, mapping each to
     the same provider instance constructor.
   - Keep both names accepted in `parseProviderConfig` and
     `validateConfig` for at least 6 months.
   - Document the deprecation in `README.md` under a "Deprecations"
     section with the removal date.

3. **Renames are documented in `CHANGELOG.md`.** Each entry must
   reference the `FOLLOWUP-XXX` issue that proposed the rename and
   the date the old name stops being accepted.

## Current names

| Name           | Class                          | Status   | Since  |
| -------------- | ------------------------------ | -------- | ------ |
| `cloudflare`   | `CloudflareEmailProvider`      | stable   | v1.0   |
| `brevo`        | `BrevoEmailProvider`           | stable   | v1.0   |

A future rename must:

- Add the new class.
- Add an entry to the table above with status `deprecated`.
- Provide a migration script in `scripts/` (or a doc) that rewrites
  `PROVIDER_CONFIG` from the old name to the new.

## What is NOT public

Everything else is implementation detail and may change between
versions without notice:

- The class names (`CloudflareEmailProvider` etc.).
- The `EmailMessage` field names — they are internal; adding a field
  is fine but renaming one requires a deprecation alias.
- The R2 key (`config/providers.json`) — changeable via a one-time
  R2 migration.
- The audit log format (`config/audit.jsonl`) — JSONL is a contract
  but the field set is not.
- Provider-specific `provider_meta` contents — JSON, free-form, may
  grow without notice.

## Adding a new name (no rename)

1. Create `workers/providers/<name>.ts` with the class.
2. Register in `workers/providers/registry.ts`:
   ```ts
   [XProvider.name]: { name: XProvider.name, create: (env) => new XProvider(env.X_KEY as string | undefined) },
   ```
3. Add the secret to `Env` in `workers/types.ts`:
   ```ts
   X_KEY?: string;
   ```
4. Update `wrangler.jsonc` if any default var is needed.
5. Update `.dev.vars.example`.
6. Add a row to the table above with status `stable` and the version
   that shipped it.

## Renaming an existing name

1. Open a `FOLLOWUP-XXX` issue describing the rename + motivation.
2. Add the new class / `static readonly name` alongside the old.
3. Register both names in `PROVIDERS`. Both must construct the same
   provider instance (or wrappers that delegate to one impl).
4. Update `README.md` "Built-in providers" to list both names with a
   "deprecated" tag on the old one and the removal date.
5. Bump the major version (v1 → v2) at the next release.
6. After the 6-month window, drop the old name from `PROVIDERS`,
   update the table, and write a CHANGELOG entry.

## See also

- `docs/architecture/providers.md` — overall architecture and the
  provider contract.
- `README.md` — operator-facing built-in providers list.
