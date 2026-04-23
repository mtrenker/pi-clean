/**
 * Agent Guard — Policy Contract
 *
 * This file is the single source of truth for all guard lists, patterns, and
 * configuration defaults. Every other module (env.ts, path-guard.ts,
 * action-guard.ts, redaction.ts) imports constants from here rather than
 * defining its own.
 *
 * Config merging order (highest → lowest precedence):
 *   1. Project-level  : <cwd>/.pi/agent-guard.json
 *   2. Global-level   : ~/.pi/agent/agent-guard.json
 *   3. Hardcoded      : DEFAULT_POLICY (this file)
 *
 * Deferred capabilities are annotated with // ⚠ deferred (mvp) and are
 * intentionally absent from the interface and defaults. Do not add them
 * without updating docs/agent-guard/02-policy.md in the same PR.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Shared primitive types
// ---------------------------------------------------------------------------

/** A labelled regex pattern. `pattern` is a JS RegExp source string. */
export interface LabelledPattern {
  /** Short human-readable name used in audit-log entries and block reasons. */
  label: string;
  /**
   * RegExp source string (no surrounding slashes). Compiled at runtime with
   * the `i` (case-insensitive) flag unless the label ends with ":cs"
   * (case-sensitive), which is reserved for future use.
   */
  pattern: string;
}

// ---------------------------------------------------------------------------
// secretGuard
// ---------------------------------------------------------------------------

export interface SecretGuardPolicy {
  /** Master switch. When false, all secretGuard logic is skipped. */
  enabled: boolean;

  /**
   * Regex patterns matched against environment variable **names**.
   * Any variable whose name matches is stripped from the bash environment
   * via the unset preamble, unless its name also appears in `preserveEnvVars`.
   *
   * Patterns are matched case-insensitively.
   *
   * // ⚠ deferred (mvp): password-manager secret injection — when a future
   * // version supports injecting secrets from a vault (e.g. 1Password, Bitwarden)
   * // into subprocesses, the injection mechanism will gate on this list so that
   * // only vault-managed vars are re-introduced after stripping.
   */
  stripEnvPatterns: string[];

  /**
   * Exact environment variable names that must be preserved even if their
   * name matches a pattern in `stripEnvPatterns`. Useful for toolchain vars
   * (PATH, HOME, NODE_ENV, …) that must be present for commands to work.
   */
  preserveEnvVars: string[];

  /**
   * Glob patterns for file paths that are **hard-blocked** from being read,
   * written, or edited by any file tool. Patterns are resolved relative to
   * the user's HOME directory (for patterns starting with `~/`) or the
   * project cwd (for all others).
   *
   * A hard-blocked access returns `{ block: true }` immediately; no
   * warn-and-allow fallback applies.
   */
  hardBlockPaths: string[];

  /**
   * Glob patterns for file paths that trigger a **warning** but are still
   * allowed through. The access is logged to the audit log and a UI
   * notification is shown, but the tool call is not blocked.
   *
   * Same resolution rules as `hardBlockPaths`.
   */
  warnOnlyPaths: string[];

  /**
   * Labelled regex patterns applied to tool results (bash stdout/stderr,
   * file contents) before those results are committed to session history.
   * Each match is replaced with `[REDACTED:<label>]`.
   *
   * Patterns are applied in order; later patterns see already-redacted text
   * so ordering only matters if one pattern could match a `[REDACTED:…]`
   * placeholder (avoid that).
   *
   * // ⚠ deferred (mvp): stronger bash sandboxing — a future version may run
   * // bash inside a network-isolated sandbox (bubblewrap / sandbox-exec) so
   * // that secrets cannot be exfiltrated even if redaction is bypassed.
   * // Redaction remains as a defence-in-depth layer regardless.
   */
  redactionPatterns: LabelledPattern[];
}

// ---------------------------------------------------------------------------
// actionGuard
// ---------------------------------------------------------------------------

export interface ActionGuardPolicy {
  /** Master switch. When false, all actionGuard logic is skipped. */
  enabled: boolean;

  /**
   * Labelled regex patterns matched against the full bash command string
   * **before** the env-stripping preamble is prepended. Any command that
   * matches is hard-blocked; no operator confirmation is requested.
   *
   * Keep this list small and high-confidence. The goal is to prevent
   * accidental catastrophic operations, not to create a general allow/deny
   * policy.
   *
   * // ⚠ deferred (mvp): per-project approval workflows — a future version
   * // may support a `warnPatterns` list analogous to secretGuard's
   * // `warnOnlyPaths`, pausing execution and asking the operator to approve.
   *
   * // ⚠ deferred (mvp): broad command risk scoring — automated risk scoring
   * // of arbitrary shell commands is explicitly out of scope for the initial
   * // policy model. Only the short, curated `catastrophicPatterns` list is used.
   */
  catastrophicPatterns: LabelledPattern[];
}

// ---------------------------------------------------------------------------
// Top-level policy
// ---------------------------------------------------------------------------

export interface GuardPolicy {
  /**
   * Path (relative to cwd) where audit events are written as newline-delimited
   * JSON. The `/agent-guard` command tails this file for its status display.
   * All modules import this from DEFAULT_POLICY so the path is defined once.
   */
  auditLogPath: string;

  /** Controls secret-material protection. */
  secretGuard: SecretGuardPolicy;

  /**
   * Controls catastrophic irreversible command blocking.
   * Operates independently of secretGuard.
   */
  actionGuard: ActionGuardPolicy;
}

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

export const DEFAULT_POLICY: GuardPolicy = {
  auditLogPath: ".pi/agent-guard-audit.jsonl",

  // -------------------------------------------------------------------------
  // secretGuard defaults
  // -------------------------------------------------------------------------
  secretGuard: {
    enabled: true,

    /**
     * Strip env vars whose names match any of these case-insensitive patterns.
     * Covers the most common credential naming conventions across AWS, GitHub,
     * OpenAI, Anthropic, database, and generic secret naming schemes.
     */
    stripEnvPatterns: [
      // Generic credential suffixes
      "_(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|CERT|PRIVATE_KEY|PRIVATE)$",
      // AWS – explicit to catch non-suffix forms
      "^AWS_ACCESS_KEY_ID$",
      "^AWS_SECRET_ACCESS_KEY$",
      "^AWS_SESSION_TOKEN$",
      "^AWS_SECURITY_TOKEN$",
      // Git hosting providers
      "^(GITHUB|GH|GITLAB|BITBUCKET)_TOKEN$",
      "^GH_PAT$",
      // LLM/AI providers
      "^(ANTHROPIC|OPENAI|COHERE|HUGGINGFACE|REPLICATE|TOGETHER)_API_KEY$",
      "^GEMINI_API_KEY$",
      // Database connection strings (may embed passwords)
      "^(DATABASE|DB|MONGO|POSTGRES|MYSQL|REDIS)_URL$",
      "^(DATABASE|DB)_DSN$",
      // Generic secret-shaped names
      "^(SECRET|PRIVATE_KEY|SIGNING_KEY|ENCRYPTION_KEY)$",
    ],

    /**
     * These exact env var names are always preserved even if they match a
     * pattern in `stripEnvPatterns`. Only override if absolutely necessary.
     */
    preserveEnvVars: [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TERM",
      "TERM_PROGRAM",
      "COLORTERM",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "LC_MESSAGES",
      "TMPDIR",
      "TMP",
      "TEMP",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "PWD",
      "OLDPWD",
      "NODE_ENV",
      "CI",
      "NO_COLOR",
      "FORCE_COLOR",
    ],

    /**
     * Files in these glob patterns are hard-blocked from all file-tool access.
     * Patterns starting with `~/` are resolved relative to os.homedir().
     * All others are resolved relative to cwd.
     */
    hardBlockPaths: [
      // SSH private keys (any algorithm, optional passphrase)
      "~/.ssh/id_rsa",
      "~/.ssh/id_dsa",
      "~/.ssh/id_ecdsa",
      "~/.ssh/id_ed25519",
      "~/.ssh/id_*",
      // GPG private material
      "~/.gnupg/private-keys-v1.d/**",
      "~/.gnupg/secring.gpg",
      // Plaintext credential stores
      "~/.netrc",
      "~/.aws/credentials",
      // age encryption keys (XDG-style and legacy locations)
      "~/.config/age/keys.txt",
      "~/.age/keys.txt",
      // pass password store
      "~/.password-store/**",
      // Project-level dotenv files that are never committed
      "**/.env",
      "**/.env.local",
      "**/.env.*.local",
    ],

    /**
     * Files in these glob patterns trigger a warning but are still allowed.
     * Access is logged and a UI notification is shown.
     */
    warnOnlyPaths: [
      // SSH config — sensitive but not key material
      "~/.ssh/config",
      "~/.ssh/known_hosts",
      // AWS config — may contain role ARNs and region preferences
      "~/.aws/config",
      // Named dotenv files for specific environments
      "**/.env.development",
      "**/.env.staging",
      "**/.env.production",
      "**/.env.test",
    ],

    /**
     * Labelled regex patterns applied to tool results before session storage.
     * Each match is replaced with [REDACTED:<label>].
     *
     * Ordered from most-specific to least-specific to avoid partial matches
     * shadowing more precise ones.
     */
    redactionPatterns: [
      {
        label: "aws-access-key-id",
        // AWS access key IDs always start with AKIA or ASIA and are 20 chars
        pattern: "\\b(AKIA|ASIA)[0-9A-Z]{16}\\b",
      },
      {
        label: "aws-secret-access-key",
        // AWS secret keys: 40 chars of base64url following a known context word
        pattern:
          "(?<=aws_secret_access_key\\s*[=:]\\s*)[A-Za-z0-9/+]{40}\\b",
      },
      {
        label: "anthropic-api-key",
        // Anthropic keys: sk-ant-api03-… or similar prefixed forms
        pattern: "\\bsk-ant-[a-zA-Z0-9_\\-]{20,}\\b",
      },
      {
        label: "openai-api-key",
        // OpenAI keys: sk-… (legacy) or sk-proj-… (project-scoped)
        pattern: "\\bsk-(?:proj-)?[a-zA-Z0-9]{20,}\\b",
      },
      {
        label: "github-pat",
        // GitHub personal access tokens: classic (ghp_) and fine-grained (github_pat_)
        pattern: "\\b(ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,}\\b",
      },
      {
        label: "generic-api-key",
        // key=value or key: value patterns where the value looks like a secret
        pattern:
          "(?i)(?:api[-_]?key|secret[-_]?key|access[-_]?token|auth[-_]?token)\\s*[=:]\\s*[\"']?([a-zA-Z0-9/_\\-+.]{16,})[\"']?",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // actionGuard defaults
  // -------------------------------------------------------------------------
  actionGuard: {
    enabled: true,

    /**
     * Commands matching any of these patterns are hard-blocked without prompting.
     * Patterns are matched against the full command string, case-insensitively.
     * Keep this list small — only include patterns with near-zero false-positive
     * risk and catastrophic, hard-to-reverse consequences.
     */
    catastrophicPatterns: [
      {
        label: "rm-rf-root",
        // rm -rf / or rm -rf /* — deletes the entire filesystem
        pattern: "\\brm\\b.{0,30}\\s-[^\\s]*r[^\\s]*f[^\\s]*\\s+/\\s*\\*?\\s*$",
      },
      {
        label: "rm-rf-home",
        // rm -rf ~ or rm -rf $HOME
        pattern: "\\brm\\b.{0,30}-[^\\s]*r[^\\s]*f[^\\s]*\\s+(~|\\$HOME)\\s*/?\\s*$",
      },
      {
        label: "fork-bomb",
        // Classic POSIX fork bomb: :(){ :|:& };:
        pattern: ":\\s*\\(\\s*\\)\\s*\\{",
      },
      {
        label: "dd-to-block-device",
        // dd if=… of=/dev/sd* or of=/dev/nvme* — overwrites a block device
        pattern: "\\bdd\\b.{0,200}\\bof=/dev/(sd[a-z]|nvme[0-9]|hd[a-z]|vd[a-z]|xvd[a-z])\\b",
      },
      {
        label: "stdout-to-block-device",
        // Redirect output directly to a block device: > /dev/sda
        pattern: ">\\s*/dev/(sd[a-z]|nvme[0-9]|hd[a-z]|vd[a-z]|xvd[a-z])\\b",
      },
      {
        label: "mkfs",
        // mkfs.* — formats a filesystem; nearly always irreversible
        pattern: "\\bmkfs\\b",
      },
      {
        label: "format-disk-mac",
        // macOS diskutil eraseDisk / eraseVolume
        pattern: "\\bdiskutil\\b.{0,100}\\b(eraseDisk|eraseVolume|partitionDisk)\\b",
      },
      {
        label: "shred-root",
        // shred against / or /dev/sd*
        pattern: "\\bshred\\b.{0,100}(/dev/(sd[a-z]|nvme[0-9])|(^|\\s)/)\\b",
      },
      {
        label: "chmod-777-root",
        // chmod -R 777 / — world-writable root filesystem
        pattern: "\\bchmod\\b.{0,30}-[^\\s]*R[^\\s]*\\s+[0-7]*7[0-7]{2}\\s+/\\s*$",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Deep-merges `overrides` on top of `base`. Arrays in overrides **replace**
 * (not concatenate) the corresponding array in base, consistent with the
 * typical expectation that a project policy replaces the default list entirely.
 * Primitive values and nested objects follow standard deep-merge semantics.
 */
function deepMerge<T extends object>(base: T, overrides: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const bv = base[key];
    const ov = overrides[key];
    if (
      ov !== null &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      typeof bv === "object" &&
      bv !== null &&
      !Array.isArray(bv)
    ) {
      result[key as string] = deepMerge(
        bv as object,
        ov as Partial<typeof bv>,
      );
    } else if (ov !== undefined) {
      result[key as string] = ov;
    }
  }
  return result as T;
}

/**
 * Reads a JSON file and returns its parsed contents, or `undefined` if the
 * file does not exist or cannot be parsed.
 */
function readJsonFile(filePath: string): Partial<GuardPolicy> | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Partial<GuardPolicy>;
  } catch {
    return undefined;
  }
}

/**
 * Loads and merges the guard policy.
 *
 * Merge order (highest wins):
 *   1. `<cwd>/.pi/agent-guard.json`   (project-level)
 *   2. `~/.pi/agent/agent-guard.json` (global-level)
 *   3. DEFAULT_POLICY                  (hardcoded defaults)
 *
 * Missing files are silently ignored. JSON parse errors are silently ignored
 * (the next lower-precedence config is used instead). This keeps the
 * extension resilient to accidental malformed overrides.
 *
 * @param cwd - Absolute path to the project working directory (ctx.cwd).
 */
export function loadPolicy(cwd: string): GuardPolicy {
  const globalConfigPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "agent-guard.json",
  );
  const projectConfigPath = path.join(cwd, ".pi", "agent-guard.json");

  const globalOverride = readJsonFile(globalConfigPath);
  const projectOverride = readJsonFile(projectConfigPath);

  let policy = DEFAULT_POLICY;
  if (globalOverride) {
    policy = deepMerge(policy, globalOverride);
  }
  if (projectOverride) {
    policy = deepMerge(policy, projectOverride);
  }

  return policy;
}
