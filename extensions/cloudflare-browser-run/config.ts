/**
 * Cloudflare Browser Run — configuration contract
 *
 * Section 6 of DESIGN.md. Configuration is user scoped and non-secret: it holds
 * a credential *locator*, never a credential. Every path derives from
 * `getAgentDir()` rather than a hardcoded `.pi`, so a rebranded distribution
 * keeps working.
 *
 * Unknown keys are rejected with the offending key named rather than ignored. A
 * typo that silently disables a bound is worse than a startup error.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { BrowserRunError } from "./errors.ts";

export const EXTENSION_DIR_NAME = "cloudflare-browser-run";

/** Cloudflare documents a 10 minute maximum for the CDP `keep_alive` parameter. */
export const KEEP_ALIVE_MAX_MS = 600_000;
/** Cloudflare documents 100000 as the ceiling for `/crawl` `limit`. */
export const CRAWL_LIMIT_CEILING = 100_000;
/** This extension's own ceiling for crawl depth; see DESIGN.md section 16.2. */
export const CRAWL_DEPTH_CEILING = 5;

export const CRAWL_PURPOSES = ["search", "ai-input"] as const;
export type CrawlPurpose = (typeof CRAWL_PURPOSES)[number];

export const CREDENTIAL_SOURCES = ["env", "proton-pass", "command"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface CredentialConfig {
  source: CredentialSource;
  vault?: string;
  item?: string;
  accountIdField?: string;
  tokenField?: string;
  /** For `source: "command"`: argv whose stdout is the field value. `{field}` is substituted. */
  argv?: string[];
}

export interface BrowserSettings {
  keepAliveMs: number;
  actionTimeoutMs: number;
  queueDepth: number;
  maxActionsPerSession: number;
  confirmClicks: "never" | "always";
  screenshotsWithProfile: "ask" | "never" | "always";
  viewport: { width: number; height: number };
}

export interface ProfileDefinition {
  origins: string[];
  allowNavigationOutsideProfile: boolean;
}

export interface CrawlSettings {
  crawlPurposes: CrawlPurpose[];
  defaultLimit: number;
  maxLimit: number;
  defaultDepth: number;
  allowRenderedCrawl: boolean;
  maxJobsPerDay: number;
  resultCacheDays: number;
}

export const KEY_BACKENDS = ["auto", "keyring", "secret-manager", "env"] as const;
export type KeyBackendPreference = (typeof KEY_BACKENDS)[number];

export interface ProfileVaultSettings {
  backend: KeyBackendPreference;
  /** Command whose stdout is a base64 master key, for the secret-manager backend. */
  command?: string;
  args?: string[];
}

export interface LoggingSettings {
  enabled: boolean;
  maxBytes: number;
  keep: number;
}

export interface BrowserRunConfig {
  credentials: CredentialConfig;
  browser: BrowserSettings;
  profiles: Record<string, ProfileDefinition>;
  profileVault: ProfileVaultSettings;
  crawl: CrawlSettings;
  logging: LoggingSettings;
}

export interface StatePaths {
  root: string;
  configFile: string;
  profilesDir: string;
  crawlsDir: string;
  logFile: string;
}

export const DEFAULT_CONFIG: BrowserRunConfig = {
  credentials: { source: "env" },
  browser: {
    keepAliveMs: KEEP_ALIVE_MAX_MS,
    actionTimeoutMs: 30_000,
    queueDepth: 4,
    maxActionsPerSession: 200,
    confirmClicks: "never",
    screenshotsWithProfile: "ask",
    viewport: { width: 1280, height: 800 },
  },
  profiles: {},
  profileVault: { backend: "auto" },
  crawl: {
    crawlPurposes: ["ai-input"],
    defaultLimit: 25,
    maxLimit: 500,
    defaultDepth: 2,
    allowRenderedCrawl: false,
    maxJobsPerDay: 10,
    resultCacheDays: 14,
  },
  logging: { enabled: true, maxBytes: 5_242_880, keep: 3 },
};

export function statePaths(agentDir: string = getAgentDir()): StatePaths {
  const root = join(agentDir, EXTENSION_DIR_NAME);
  return {
    root,
    configFile: join(root, "config.json"),
    profilesDir: join(root, "profiles"),
    crawlsDir: join(root, "crawls"),
    logFile: join(root, "activity.jsonl"),
  };
}

/** Create the state directory tree with owner-only permissions. Idempotent. */
export async function ensureStateDir(paths: StatePaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.profilesDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.crawlsDir, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function invalid(path: string, detail: string): never {
  throw new BrowserRunError("invalid_request", `config ${path}: ${detail}`);
}

function asObject(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      invalid(path === "" ? key : `${path}.${key}`, `unknown key (allowed: ${allowed.join(", ")})`);
    }
  }
  return record;
}

function asString(value: unknown, path: string, fallback?: string): string {
  if (value === undefined) {
    if (fallback === undefined) invalid(path, "is required");
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") invalid(path, "must be a non-empty string");
  return value;
}

function asBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function asInteger(
  value: unknown,
  path: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) invalid(path, "must be an integer");
  if (value < bounds.min || value > bounds.max) {
    invalid(path, `must be between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, "must be an array of strings");
  return value.map((item, index) => asString(item, `${path}[${index}]`));
}

/**
 * An allowlist entry must be an exact origin: scheme, host, and optional
 * non-default port, with no path, query, credentials, or trailing slash.
 */
export function assertExactOrigin(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(path, `"${value}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid(path, `"${value}" must use http or https`);
  }
  if (url.username || url.password) invalid(path, `"${value}" must not carry credentials`);
  if (url.origin !== value) {
    invalid(path, `"${value}" must be an exact origin such as ${url.origin}`);
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ROOT_KEYS = [
  "credentials",
  "browser",
  "profiles",
  "profileVault",
  "crawl",
  "logging",
] as const;
const PROFILE_VAULT_KEYS = ["backend", "command", "args"] as const;
const CREDENTIAL_KEYS = ["source", "vault", "item", "accountIdField", "tokenField", "argv"] as const;
const BROWSER_KEYS = [
  "keepAliveMs",
  "actionTimeoutMs",
  "queueDepth",
  "maxActionsPerSession",
  "confirmClicks",
  "screenshotsWithProfile",
  "viewport",
] as const;
const VIEWPORT_KEYS = ["width", "height"] as const;
const PROFILE_KEYS = ["origins", "allowNavigationOutsideProfile"] as const;
const CRAWL_KEYS = [
  "crawlPurposes",
  "defaultLimit",
  "maxLimit",
  "defaultDepth",
  "allowRenderedCrawl",
  "maxJobsPerDay",
  "resultCacheDays",
] as const;
const LOGGING_KEYS = ["enabled", "maxBytes", "keep"] as const;

function parseCredentials(raw: unknown): CredentialConfig {
  const record = asObject(raw, "credentials", CREDENTIAL_KEYS);
  const source = asEnum(record["source"], "credentials.source", CREDENTIAL_SOURCES, "env");
  const config: CredentialConfig = { source };

  if (source === "proton-pass") {
    config.vault = asString(record["vault"], "credentials.vault");
    config.item = asString(record["item"], "credentials.item");
    config.accountIdField = asString(record["accountIdField"], "credentials.accountIdField");
    config.tokenField = asString(record["tokenField"], "credentials.tokenField");
  } else if (source === "command") {
    const argv = asStringArray(record["argv"], "credentials.argv");
    if (argv.length === 0) invalid("credentials.argv", "must contain at least the executable");
    if (!argv.some((entry) => entry.includes("{field}"))) {
      invalid("credentials.argv", "must contain a {field} placeholder");
    }
    config.argv = argv;
    config.accountIdField = asString(record["accountIdField"], "credentials.accountIdField");
    config.tokenField = asString(record["tokenField"], "credentials.tokenField");
  }
  return config;
}

function parseBrowser(raw: unknown): BrowserSettings {
  const record = asObject(raw, "browser", BROWSER_KEYS);
  const defaults = DEFAULT_CONFIG.browser;
  const viewportRecord = asObject(record["viewport"], "browser.viewport", VIEWPORT_KEYS);
  return {
    keepAliveMs: asInteger(record["keepAliveMs"], "browser.keepAliveMs", defaults.keepAliveMs, {
      min: 10_000,
      max: KEEP_ALIVE_MAX_MS,
    }),
    actionTimeoutMs: asInteger(
      record["actionTimeoutMs"],
      "browser.actionTimeoutMs",
      defaults.actionTimeoutMs,
      { min: 1_000, max: 300_000 },
    ),
    queueDepth: asInteger(record["queueDepth"], "browser.queueDepth", defaults.queueDepth, {
      min: 1,
      max: 32,
    }),
    maxActionsPerSession: asInteger(
      record["maxActionsPerSession"],
      "browser.maxActionsPerSession",
      defaults.maxActionsPerSession,
      { min: 1, max: 10_000 },
    ),
    confirmClicks: asEnum(
      record["confirmClicks"],
      "browser.confirmClicks",
      ["never", "always"] as const,
      defaults.confirmClicks,
    ),
    screenshotsWithProfile: asEnum(
      record["screenshotsWithProfile"],
      "browser.screenshotsWithProfile",
      ["ask", "never", "always"] as const,
      defaults.screenshotsWithProfile,
    ),
    viewport: {
      width: asInteger(viewportRecord["width"], "browser.viewport.width", defaults.viewport.width, {
        min: 320,
        max: 1600,
      }),
      height: asInteger(
        viewportRecord["height"],
        "browser.viewport.height",
        defaults.viewport.height,
        { min: 240, max: 1600 },
      ),
    },
  };
}

function parseProfiles(raw: unknown): Record<string, ProfileDefinition> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("profiles", "must be an object keyed by profile name");
  }
  const profiles: Record<string, ProfileDefinition> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) {
      invalid(`profiles.${name}`, "name must be 1-64 characters of letters, digits, or hyphens");
    }
    const record = asObject(value, `profiles.${name}`, PROFILE_KEYS);
    const origins = asStringArray(record["origins"], `profiles.${name}.origins`).map((origin, index) =>
      assertExactOrigin(origin, `profiles.${name}.origins[${index}]`),
    );
    if (origins.length === 0) invalid(`profiles.${name}.origins`, "must list at least one origin");
    profiles[name] = {
      origins: [...new Set(origins)],
      allowNavigationOutsideProfile: asBoolean(
        record["allowNavigationOutsideProfile"],
        `profiles.${name}.allowNavigationOutsideProfile`,
        false,
      ),
    };
  }
  return profiles;
}

function parseProfileVault(raw: unknown): ProfileVaultSettings {
  const record = asObject(raw, "profileVault", PROFILE_VAULT_KEYS);
  const backend = asEnum(record["backend"], "profileVault.backend", KEY_BACKENDS, "auto");
  const settings: ProfileVaultSettings = { backend };
  if (record["command"] !== undefined) settings.command = asString(record["command"], "profileVault.command");
  if (record["args"] !== undefined) settings.args = asStringArray(record["args"], "profileVault.args");
  if (backend === "secret-manager" && !settings.command) {
    invalid("profileVault.command", "is required for the secret-manager backend");
  }
  return settings;
}

function parseCrawl(raw: unknown): CrawlSettings {
  const record = asObject(raw, "crawl", CRAWL_KEYS);
  const defaults = DEFAULT_CONFIG.crawl;

  let crawlPurposes = defaults.crawlPurposes;
  if (record["crawlPurposes"] !== undefined) {
    const values = asStringArray(record["crawlPurposes"], "crawl.crawlPurposes");
    if (values.length === 0) invalid("crawl.crawlPurposes", "must declare at least one purpose");
    for (const value of values) {
      if (value === "ai-train") {
        invalid(
          "crawl.crawlPurposes",
          "ai-train is not supported: this extension has no training pipeline, so declaring it " +
            "would misstate the purpose to every site that reads Content Signals",
        );
      }
      if (!CRAWL_PURPOSES.includes(value as CrawlPurpose)) {
        invalid("crawl.crawlPurposes", `"${value}" must be one of ${CRAWL_PURPOSES.join(", ")}`);
      }
    }
    crawlPurposes = [...new Set(values)] as CrawlPurpose[];
  }

  const maxLimit = asInteger(record["maxLimit"], "crawl.maxLimit", defaults.maxLimit, {
    min: 1,
    max: CRAWL_LIMIT_CEILING,
  });
  const defaultLimit = asInteger(record["defaultLimit"], "crawl.defaultLimit", defaults.defaultLimit, {
    min: 1,
    max: CRAWL_LIMIT_CEILING,
  });
  if (defaultLimit > maxLimit) invalid("crawl.defaultLimit", "must not exceed crawl.maxLimit");

  return {
    crawlPurposes,
    defaultLimit,
    maxLimit,
    defaultDepth: asInteger(record["defaultDepth"], "crawl.defaultDepth", defaults.defaultDepth, {
      min: 0,
      max: CRAWL_DEPTH_CEILING,
    }),
    allowRenderedCrawl: asBoolean(
      record["allowRenderedCrawl"],
      "crawl.allowRenderedCrawl",
      defaults.allowRenderedCrawl,
    ),
    maxJobsPerDay: asInteger(record["maxJobsPerDay"], "crawl.maxJobsPerDay", defaults.maxJobsPerDay, {
      min: 1,
      max: 1_000,
    }),
    resultCacheDays: asInteger(
      record["resultCacheDays"],
      "crawl.resultCacheDays",
      defaults.resultCacheDays,
      { min: 1, max: 14 },
    ),
  };
}

function parseLogging(raw: unknown): LoggingSettings {
  const record = asObject(raw, "logging", LOGGING_KEYS);
  const defaults = DEFAULT_CONFIG.logging;
  return {
    enabled: asBoolean(record["enabled"], "logging.enabled", defaults.enabled),
    maxBytes: asInteger(record["maxBytes"], "logging.maxBytes", defaults.maxBytes, {
      min: 64_000,
      max: 268_435_456,
    }),
    keep: asInteger(record["keep"], "logging.keep", defaults.keep, { min: 0, max: 20 }),
  };
}

/** Validate a parsed configuration document. Throws `invalid_request` naming the offending key. */
export function parseConfig(raw: unknown): BrowserRunConfig {
  const record = asObject(raw ?? {}, "", ROOT_KEYS);
  return {
    credentials: parseCredentials(record["credentials"]),
    browser: parseBrowser(record["browser"]),
    profiles: parseProfiles(record["profiles"]),
    profileVault: parseProfileVault(record["profileVault"]),
    crawl: parseCrawl(record["crawl"]),
    logging: parseLogging(record["logging"]),
  };
}

/** Read and validate `config.json`. A missing file yields the defaults. */
export async function loadConfig(paths: StatePaths): Promise<BrowserRunConfig> {
  let text: string;
  try {
    text = await readFile(paths.configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw new BrowserRunError("invalid_request", `config could not be read: ${paths.configFile}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BrowserRunError(
      "invalid_request",
      `config is not valid JSON: ${paths.configFile}`,
      { cause: error },
    );
  }
  return parseConfig(parsed);
}

/** Human-readable, secret-free summary of how credentials are configured. */
export function describeCredentialConfig(config: CredentialConfig): string {
  switch (config.source) {
    case "env":
      return "environment variables CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BROWSER_RUN_TOKEN";
    case "proton-pass":
      return `Proton Pass vault "${config.vault}", item "${config.item}", fields "${config.accountIdField}" and "${config.tokenField}"`;
    case "command":
      return `command ${config.argv?.[0] ?? "(unset)"} with fields "${config.accountIdField}" and "${config.tokenField}"`;
  }
}
