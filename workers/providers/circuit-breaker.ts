// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-isolate circuit breaker for email providers.
 *
 * A circuit breaker avoids hammering a degraded downstream: after a small
 * number of consecutive failures the breaker "opens" and short-circuits the
 * next N requests to fail fast for a cool-off period. After the cool-off
 * expires, the breaker is considered "half-open" — the next call is allowed
 * through; if it succeeds the breaker closes (resets), if it fails it
 * re-opens for another cool-off window.
 *
 * Scope: module-level `Map<providerName, BreakerState>`. Workers isolates
 * are reused but reset on deploy. Per-mailbox state would not make sense
 * because the issue is at the provider boundary, not at the mailbox.
 *
 * FUTURE: per-provider configurable thresholds via env vars (FOLLOWUP-005).
 */

export interface BreakerState {
	/** Consecutive failures since last success. */
	failures: number;
	/** Unix epoch ms when the breaker re-closes. 0 = closed. */
	openUntil: number;
	/** Total successful sends since last reset (for diagnostics). */
	successes: number;
}

/** Default thresholds; tweakable in tests via `_setBreakerThresholds()`. */
const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLOFF_MS = 30_000;

let threshold = DEFAULT_THRESHOLD;
let cooloffMs = DEFAULT_COOLOFF_MS;

const states = new Map<string, BreakerState>();

/** Test-only escape hatch. */
export function _resetCircuitBreakers(): void {
	states.clear();
	threshold = DEFAULT_THRESHOLD;
	cooloffMs = DEFAULT_COOLOFF_MS;
}

/** Test-only escape hatch. */
export function _setBreakerThresholds(opts: { threshold?: number; cooloffMs?: number }): void {
	if (typeof opts.threshold === "number" && opts.threshold > 0) threshold = opts.threshold;
	if (typeof opts.cooloffMs === "number" && opts.cooloffMs > 0) cooloffMs = opts.cooloffMs;
}

function getState(name: string): BreakerState {
	let s = states.get(name);
	if (!s) {
		s = { failures: 0, openUntil: 0, successes: 0 };
		states.set(name, s);
	}
	return s;
}

/**
 * True if the breaker is currently open and short-circuiting calls.
 * `now` is a parameter so tests can advance time without monkey-patching Date.
 */
export function isBreakerOpen(name: string, now: number = Date.now()): boolean {
	const s = states.get(name);
	if (!s || !s.openUntil) return false;
	if (now >= s.openUntil) return false; // half-open
	return true;
}

/** Record a successful send. Resets the failure counter and closes the breaker. */
export function recordSuccess(name: string): void {
	const s = getState(name);
	s.successes++;
	s.failures = 0;
	s.openUntil = 0;
}

/**
 * Record a failed send. Opens the breaker if threshold is reached.
 * Returns `true` if this call just tripped the breaker (i.e. it was the
 * threshold-th consecutive failure).
 */
export function recordFailure(name: string, now: number = Date.now()): boolean {
	const s = getState(name);
	s.failures++;
	if (s.failures >= threshold) {
		s.openUntil = now + cooloffMs;
		return true;
	}
	return false;
}

/** Diagnostics for the health endpoint (FOLLOWUP-009). */
export function getBreakerSnapshot(): Record<string, BreakerState> {
	const out: Record<string, BreakerState> = {};
	for (const [k, v] of states.entries()) {
		out[k] = { ...v };
	}
	return out;
}

/** Wait until the breaker re-closes, plus the configured cool-off. */
export function getCooloffMs(): number {
	return cooloffMs;
}