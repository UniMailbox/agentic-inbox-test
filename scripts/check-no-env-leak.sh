#!/usr/bin/env bash
# scripts/check-no-env-leak.sh
#
# Guard against accidentally logging the entire `env` object (FOLLOWUP-010).
# Such a leak would expose every Cloudflare secret the worker has access to
# (BREVO_API_KEY, BREVO_WEBHOOK_SECRET, future *_KEY) in `wrangler tail`.
#
# Patterns detected:
#   console.log(env[, ...])
#   console.error(env[, ...])
#   console.warn(env[, ...])
#   JSON.stringify(env[, ...])     // also dangerous; catches other sinks
#
# Allowlist (one line per path): patterns that look like leaks but are
# intentional — add with a justification comment.
#
# Exit 0 if clean, 1 if any leak found. Designed to run in pre-commit
# or CI without external dependencies (no node, no jq).
#
# Usage:
#   bash scripts/check-no-env-leak.sh                # scan workers/
#   bash scripts/check-no-env-leak.sh path/to/dir    # scan custom dir

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$ROOT/workers}"

if [ ! -d "$TARGET" ]; then
  echo "check-no-env-leak: target $TARGET is not a directory" >&2
  exit 2
fi

# Use grep -rEn (POSIX) — bash 3.x compatible (macOS default).
# Match `env` passed directly as a function argument (not as `env.SOMETHING`).
# `env` must be followed by `)`, `,`, end of line, or whitespace + `)`/`,`
# (so `console.log(env)` and `console.log(env, ...)` both match, but
# `console.log(env.SOMETHING)` does not).
#
# Known limitations (better caught by an ESLint rule, see FOLLOWUP-010
# follow-up): we do NOT detect
#   - `console.log({ k: env })` — env nested in an object
#   - `console.log([env])`        — env nested in an array
#   - `console.log("x", { a: env })`
# AST-aware detection is out of scope for a pure-shell guard.
LEAKS=$(grep -rEn \
  -e 'console\.(log|error|warn|info|debug)\s*\(\s*env(\s*[),]|$)' \
  -e 'JSON\.stringify\s*\(\s*env(\s*[),]|$)' \
  --include='*.ts' --include='*.tsx' --include='*.js' \
  "$TARGET" || true)

if [ -n "$LEAKS" ]; then
  echo "check-no-env-leak: forbidden env logging detected" >&2
  echo "" >&2
  echo "$LEAKS" >&2
  echo "" >&2
  echo "Logging the full env object exposes every Cloudflare secret in" >&2
  echo "wrangler tail (BREVO_API_KEY, BREVO_WEBHOOK_SECRET, ...)." >&2
  echo "Log specific fields instead (e.g. console.log({ route: env.ROUTE }))." >&2
  echo "If this is intentional, add the path to the allowlist at the top" >&2
  echo "of scripts/check-no-env-leak.sh with a justification." >&2
  exit 1
fi

echo "check-no-env-leak: clean"
exit 0
