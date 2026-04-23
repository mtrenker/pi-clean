/**
 * Agent Guard - Path Guard
 *
 * Provides classification and enforcement of file-path access according to the
 * guard policy's `secretGuard.hardBlockPaths` and `secretGuard.warnOnlyPaths`
 * buckets.
 *
 * Two-bucket model:
 *   - hard-block  - access is denied immediately; the tool call returns an error.
 *   - warn-only   - access is allowed through; the event is logged and the
 *                   caller may show a UI notification.
 *   - allow       - no match; access is fully permitted.
 *
 * Path resolution order:
 *   1. Patterns starting with `~/`  -> resolved relative to os.homedir().
 *   2. All other patterns           -> used as-is as minimatch glob patterns.
 *      Because "**" is used in most cwd-relative patterns (e.g. "**\/.env"),
 *      those patterns match against the absolute input path directly, which
 *      means they will fire regardless of which working directory is active.
 *
 * Callers should pass an absolute path to `classifyPath` or an arbitrary
 * (possibly relative / tilde-prefixed) path to `enforcePathGuard`; the latter
 * calls `resolveInputPath` internally before classifying.
 */

import * as os from "os";
import * as path from "path";
import { minimatch } from "minimatch";
import type { GuardPolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Audit-log callback.  Every hard-block and warn-only decision is recorded via
 * this function.  The caller (index.ts) owns the actual log file handle.
 */
export type LogFn = (event: Record<string, unknown>) => Promise<void>;

/**
 * Return type from `enforcePathGuard`.
 *
 * - `{ block: true; reason: string }` - caller must abort the tool call.
 * - `undefined`                       - caller may proceed (covers both
 *                                       "warn-only" and "allow"; the caller is
 *                                       responsible for any UI notification
 *                                       for warn-only paths by checking
 *                                       `classifyPath` independently if needed).
 */
export type PathEnforceResult = { block: true; reason: string } | undefined;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Expands a policy pattern to an absolute glob string ready for minimatch.
 *
 * "~/foo/**" -> "<homedir>/foo/**"
 * "**\/.env" -> "**\/.env"  (unchanged; minimatch handles the "**" correctly
 *              when the test path is absolute because the double-star can
 *              match the leading "/" segments)
 */
function resolvePattern(pattern: string): string {
  if (pattern.startsWith("~/")) {
    return path.join(os.homedir(), pattern.slice(2));
  }
  return pattern;
}

/**
 * Returns `true` when `absolutePath` matches the policy `pattern`.
 *
 * Uses minimatch with `{ dot: true }` so dotfiles are matched by wildcards
 * (e.g. "**\/.env" correctly matches "/home/user/project/.env").
 */
function matchesPattern(absolutePath: string, pattern: string): boolean {
  const resolved = resolvePattern(pattern);
  return minimatch(absolutePath, resolved, { dot: true });
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Resolves an arbitrary input path (relative, absolute, or tilde-prefixed) to
 * an absolute path.
 *
 * Resolution rules:
 *   - `~/...`      -> os.homedir() + rest
 *   - absolute     -> returned as-is (after `path.resolve` normalisation to
 *                     collapse any `..` segments)
 *   - relative     -> resolved against `cwd`
 *
 * `path.resolve` is used in all cases so that `..` traversal in a relative
 * path cannot escape the intended root (e.g. `../../.ssh/id_rsa` from cwd is
 * resolved correctly to its real absolute location and is then matched by the
 * `~/.ssh/id_*` pattern).
 */
export function resolveInputPath(inputPath: string, cwd: string): string {
  if (inputPath.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), inputPath.slice(2)));
  }
  return path.resolve(cwd, inputPath);
}

/**
 * Classifies an **absolute** file path against the guard policy.
 *
 * Returns:
 *   - `"hard-block"` if the path matches any `secretGuard.hardBlockPaths` pattern.
 *   - `"warn-only"`  if the path matches any `secretGuard.warnOnlyPaths` pattern
 *                    (and no hard-block pattern matched).
 *   - `"allow"`      if no pattern matched, or if `secretGuard.enabled` is false.
 *
 * Hard-block takes precedence over warn-only.
 */
export function classifyPath(
  absolutePath: string,
  policy: GuardPolicy,
): "hard-block" | "warn-only" | "allow" {
  if (!policy.secretGuard.enabled) {
    return "allow";
  }

  for (const pattern of policy.secretGuard.hardBlockPaths) {
    if (matchesPattern(absolutePath, pattern)) {
      return "hard-block";
    }
  }

  for (const pattern of policy.secretGuard.warnOnlyPaths) {
    if (matchesPattern(absolutePath, pattern)) {
      return "warn-only";
    }
  }

  return "allow";
}

/**
 * Enforces the path guard for a single file-tool invocation.
 *
 * Resolves `inputPath` to absolute, classifies it, writes an audit-log entry
 * for hard-block and warn-only decisions, and returns a block result when
 * access must be denied.
 *
 * @param toolName  - One of `"read"`, `"write"`, `"edit"`.
 * @param inputPath - Raw path as received from the tool call (may be relative,
 *                    absolute, or tilde-prefixed).
 * @param cwd       - Absolute working directory (`ctx.cwd`).
 * @param policy    - Merged guard policy from `loadPolicy`.
 * @param log       - Audit-log callback; called for every non-allow decision.
 *
 * @returns `{ block: true; reason }` when the path is hard-blocked, or
 *          `undefined` when the path is warn-only or allowed.
 *          The caller is responsible for showing a UI notification when the
 *          return value is `undefined` but the path is warn-only; it can do
 *          so by calling `classifyPath(resolveInputPath(inputPath, cwd), policy)`
 *          before calling this function.
 */
export async function enforcePathGuard(
  toolName: string,
  inputPath: string,
  cwd: string,
  policy: GuardPolicy,
  log: LogFn,
): Promise<PathEnforceResult> {
  const absolutePath = resolveInputPath(inputPath, cwd);
  const verdict = classifyPath(absolutePath, policy);

  if (verdict === "hard-block") {
    await log({
      guard: "secretGuard",
      type: "path-blocked",
      toolName,
      path: absolutePath,
      reason: "matched hard-block policy pattern",
    });
    return {
      block: true,
      reason:
        `Access denied: "${inputPath}" matches a hard-blocked secret path ` +
        `pattern. This file cannot be read, written, or edited by any file tool.`,
    };
  }

  if (verdict === "warn-only") {
    await log({
      guard: "secretGuard",
      type: "path-warned",
      toolName,
      path: absolutePath,
    });
    // Access is allowed; caller handles UI notification.
    return undefined;
  }

  // verdict === "allow" - nothing to do
  return undefined;
}
