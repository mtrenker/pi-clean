/**
 * Agent Guard — Environment Variable Filtering
 *
 * Temporary simplified mode:
 *   Env stripping is intentionally disabled for now.
 *
 * Rationale:
 *   The previous unset/filtering behavior made credential-dependent workflows
 *   cumbersome and could create confusing partial-security expectations.
 *   Until a more explicit allowlist / capability-based design exists, the env
 *   helpers below act as pass-through / no-op functions.
 *
 * Exports:
 *   buildFilteredEnv(env, policy)
 *     Returns a shallow copy of `env` unchanged.
 *
 *   buildUnsetPreamble(policy)
 *     Returns an empty string so no `unset ...` preamble is prepended.
 */

import type { GuardPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a shallow copy of `env` unchanged.
 *
 * The `policy` parameter is retained for API stability so callers do not need
 * to change when env filtering is reintroduced in a future design.
 */
export function buildFilteredEnv(
  env: NodeJS.ProcessEnv,
  _policy: GuardPolicy,
): Record<string, string | undefined> {
  return { ...env } as Record<string, string | undefined>;
}

/**
 * Returns an empty string.
 *
 * Env-unset preamble injection is intentionally disabled for now.
 */
export function buildUnsetPreamble(_policy: GuardPolicy): string {
  return "";
}
