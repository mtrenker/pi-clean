/**
 * Agent Guard — Environment Variable Filtering
 *
 * Provides two exports:
 *
 *   buildFilteredEnv(env, policy)
 *     Returns a copy of `env` with secret-matching variables removed.
 *     Used when the caller can directly supply a filtered env object.
 *
 *   buildUnsetPreamble(policy)
 *     Returns a shell snippet that `unset`s each matching variable.
 *     Prepended to bash command strings so secrets are gone before any
 *     user command runs, even in subshells that inherit the parent env.
 *
 * Design note (from docs/agent-guard/01-architecture.md §4.1):
 *   The preamble approach is preferred over replacing the bash tool because
 *   it keeps the built-in tool intact and the mutation is visible in the
 *   session transcript.
 */

import type { GuardPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compiles `policy.secretGuard.stripEnvPatterns` into a list of RegExp objects.
 * Results are cached across calls with the same policy reference.
 */
const compiledPatternsCache = new WeakMap<GuardPolicy, RegExp[]>();

function getCompiledPatterns(policy: GuardPolicy): RegExp[] {
  let patterns = compiledPatternsCache.get(policy);
  if (!patterns) {
    patterns = policy.secretGuard.stripEnvPatterns.map(
      (src) => new RegExp(src, "i"),
    );
    compiledPatternsCache.set(policy, patterns);
  }
  return patterns;
}

/**
 * Returns `true` if the env var `name` should be stripped.
 *
 * A variable is stripped when:
 *   - Its name matches at least one pattern in `stripEnvPatterns`, AND
 *   - Its name is NOT in `preserveEnvVars` (exact, case-sensitive match), AND
 *   - Its name does NOT start with `PI_`.
 *
 * `PI_` is an explicit operator escape hatch for env vars that should remain
 * visible to subprocesses even when their suffix would otherwise look secret.
 */
function shouldStrip(name: string, policy: GuardPolicy): boolean {
  if (name.startsWith("PI_")) {
    return false;
  }
  if (policy.secretGuard.preserveEnvVars.includes(name)) {
    return false;
  }
  const patterns = getCompiledPatterns(policy);
  return patterns.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a shallow copy of `env` with all secret-matching variables removed.
 *
 * Variables with `undefined` values are preserved as-is (they are not secret
 * by definition and many tools check for key presence, not value).
 *
 * @param env    - Typically `process.env` or a copy of it.
 * @param policy - The loaded guard policy.
 */
export function buildFilteredEnv(
  env: NodeJS.ProcessEnv,
  policy: GuardPolicy,
): Record<string, string | undefined> {
  if (!policy.secretGuard.enabled) {
    return { ...env } as Record<string, string | undefined>;
  }

  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!shouldStrip(key, policy)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Returns a POSIX shell snippet that `unset`s every environment variable
 * whose name (a) matches a strip pattern and (b) is currently set in
 * `process.env`.
 *
 * The snippet is prepended to the bash command string in the `tool_call`
 * handler so that the unset operations run before any user command — even
 * in subshells spawned by the command.
 *
 * Example output:
 *   unset AWS_SECRET_ACCESS_KEY ANTHROPIC_API_KEY GITHUB_TOKEN
 *
 * If no matching variables are present in the current process env, returns
 * an empty string so no-op prepending is harmless.
 *
 * @param policy - The loaded guard policy.
 */
export function buildUnsetPreamble(policy: GuardPolicy): string {
  if (!policy.secretGuard.enabled) {
    return "";
  }

  const toUnset = Object.keys(process.env).filter((key) =>
    shouldStrip(key, policy),
  );

  if (toUnset.length === 0) {
    return "";
  }

  return `unset ${toUnset.join(" ")}`;
}
