/**
 * Agent Guard — Tool Result Redaction
 *
 * Exports a single function `redactContent` that scans a text string for
 * secret-looking patterns and replaces each matching span with a stable
 * placeholder of the form `[REDACTED:<label>]`.
 *
 * Design rationale and supported/unsupported categories are documented in
 * docs/agent-guard/05-redaction-notes.md.
 *
 * Key properties:
 *   - Patterns come from `policy.secretGuard.redactionPatterns` (policy.ts).
 *   - Compiled RegExp objects are cached per policy reference (WeakMap) so
 *     compilation cost is paid once per session.
 *   - Patterns are applied in order; later passes see already-redacted text,
 *     so `[REDACTED:…]` placeholders are never re-matched by subsequent patterns.
 *   - The `g` (global) flag ensures ALL occurrences within a block are replaced,
 *     not just the first.
 *   - Returns `count === 0` when nothing was redacted so the caller can
 *     short-circuit and avoid replacing the original content unnecessarily.
 *
 * ⚠ deferred (mvp):
 *   - Redaction of binary / base64-encoded secrets embedded in tool output.
 *   - Entropy-based heuristic scanning for unrecognised high-entropy tokens.
 *   - Structured-output (JSON/YAML) key-aware redaction that targets only
 *     specific field values rather than arbitrary substrings.
 */

import type { GuardPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RedactionResult {
  /**
   * The input text with every secret-looking span replaced by a
   * `[REDACTED:<label>]` placeholder.  Identical to the input when
   * `count === 0`.
   */
  redacted: string;
  /**
   * Total number of replacement operations performed across all patterns.
   * Zero means the input contained no detectable secret material.
   */
  count: number;
}

// ---------------------------------------------------------------------------
// Pattern compilation cache
// ---------------------------------------------------------------------------

const compiledRedactionCache = new WeakMap<
  GuardPolicy,
  Array<{ label: string; re: RegExp }>
>();

/**
 * Compiles `policy.secretGuard.redactionPatterns` into RegExp objects.
 * Results are cached against the policy object reference so compilation
 * happens at most once per session.
 *
 * Inline PCRE-style flags (e.g. `(?i)`) at the very start of a pattern string
 * are stripped before compilation because JavaScript's `RegExp` does not
 * support inline flags; the `gi` flags are applied at construction time.
 * This handles the `generic-api-key` pattern in DEFAULT_POLICY which uses
 * `(?i)` for historical reasons.
 */
function getCompiledRedactionPatterns(
  policy: GuardPolicy,
): Array<{ label: string; re: RegExp }> {
  let compiled = compiledRedactionCache.get(policy);
  if (!compiled) {
    compiled = policy.secretGuard.redactionPatterns.map(({ label, pattern }) => {
      // Strip a leading PCRE-style inline flag group such as (?i), (?m), (?s).
      // JavaScript does not support these; we compile with "gi" instead.
      const src = pattern.replace(/^\(\?[a-z]+\)/i, "");
      // Global + case-insensitive: replace all occurrences in a single pass.
      const re = new RegExp(src, "gi");
      return { label, re };
    });
    compiledRedactionCache.set(policy, compiled);
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies all configured redaction patterns to `text` and returns the
 * sanitised string together with a count of replacements made.
 *
 * Patterns from `policy.secretGuard.redactionPatterns` are applied in
 * declaration order.  All occurrences of each pattern are replaced with
 * `[REDACTED:<label>]` before the next pattern runs, so later patterns always
 * operate on text that may already contain placeholders (but `[REDACTED:…]`
 * placeholders are not themselves secret-shaped, so they will not be
 * re-matched by well-formed patterns).
 *
 * When `policy.secretGuard.enabled` is `false`, or when `text` is empty,
 * the function returns immediately with the original text and `count: 0`.
 *
 * @param text   - Raw text to scan (bash stdout/stderr, file contents, etc.).
 * @param policy - The loaded guard policy (from `loadPolicy` in policy.ts).
 */
export function redactContent(text: string, policy: GuardPolicy): RedactionResult {
  if (!policy.secretGuard.enabled || !text) {
    return { redacted: text, count: 0 };
  }

  let current = text;
  let totalCount = 0;

  for (const { label, re } of getCompiledRedactionPatterns(policy)) {
    // Use a replacer function to count replacements without a second scan.
    // String.prototype.replace with a global RegExp replaces all occurrences.
    const placeholder = `[REDACTED:${label}]`;
    let patternCount = 0;
    current = current.replace(re, () => {
      patternCount++;
      return placeholder;
    });
    totalCount += patternCount;
  }

  return { redacted: current, count: totalCount };
}
