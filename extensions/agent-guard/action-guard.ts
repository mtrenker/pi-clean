/**
 * Agent Guard — Catastrophic Command Blocking
 *
 * Exports a single function `checkAction` that pattern-matches a bash
 * command string against the configured `actionGuard.catastrophicPatterns`
 * list and returns a blocking decision.
 *
 * Design decisions (from docs/agent-guard/01-architecture.md §4.3):
 *   - Hard-block only; no interactive confirmation.
 *   - Patterns are checked against the ORIGINAL command string, before the
 *     env-unset preamble is prepended.
 *   - The list is intentionally short — only patterns with near-zero false-
 *     positive risk and catastrophic, irreversible consequences.
 *
 * ⚠ deferred (mvp):
 *   - Per-project approval workflows (warnPatterns / confirm flow).
 *   - Broad command risk scoring of arbitrary shell commands.
 */

import type { GuardPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionCheckResult {
  /** `true` when the command matches a catastrophic pattern and must be blocked. */
  blocked: boolean;
  /**
   * Human-readable explanation included in the block response shown to the
   * agent and (if UI is available) to the operator. Always set when `blocked`
   * is `true`; `undefined` when `blocked` is `false`.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pattern cache
// ---------------------------------------------------------------------------

/** Compiled catastrophic pattern cache keyed by policy reference. */
const compiledCatastrophicCache = new WeakMap<
  GuardPolicy,
  Array<{ label: string; re: RegExp }>
>();

function getCompiledCatastrophic(
  policy: GuardPolicy,
): Array<{ label: string; re: RegExp }> {
  let compiled = compiledCatastrophicCache.get(policy);
  if (!compiled) {
    compiled = policy.actionGuard.catastrophicPatterns.map(({ label, pattern }) => ({
      label,
      re: new RegExp(pattern, "i"),
    }));
    compiledCatastrophicCache.set(policy, compiled);
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether `command` matches any catastrophic pattern in `policy`.
 *
 * Returns `{ blocked: false }` when either:
 *   - `policy.actionGuard.enabled` is `false`, or
 *   - No pattern matches.
 *
 * Returns `{ blocked: true, reason }` when a pattern matches, where `reason`
 * includes the matched pattern label so operators can understand why the
 * command was rejected.
 *
 * @param command - The raw bash command string (before preamble prepending).
 * @param policy  - The loaded guard policy.
 */
export function checkAction(
  command: string,
  policy: GuardPolicy,
): ActionCheckResult {
  if (!policy.actionGuard.enabled) {
    return { blocked: false };
  }

  const patterns = getCompiledCatastrophic(policy);

  for (const { label, re } of patterns) {
    if (re.test(command)) {
      return {
        blocked: true,
        reason: `Command blocked by agent-guard (catastrophic pattern: ${label}). This operation is classified as irreversible and destructive. If you genuinely need to run this command, do so manually outside the agent session.`,
      };
    }
  }

  return { blocked: false };
}
