/**
 * Cloudflare Browser Run — lazy credential resolution
 *
 * Section 7 of DESIGN.md. Nothing here runs at import time, at `session_start`,
 * or from `/browser status`: opening Pi must never trigger a Proton Pass unlock
 * prompt. Resolution happens on the first call that actually needs a token.
 *
 * Containment rules this module is responsible for:
 *   - the resolver's argv carries only the locator (vault, item, field names);
 *   - resolved values live in a closure behind `Secret`, never in `process.env`,
 *     because Pi's environment is inherited by every bash command the model runs
 *     and agent-guard's env stripping is currently disabled;
 *   - resolver stdout is never logged, and stderr is scrubbed before it is.
 */

import { inspect } from "node:util";

import {
  type BrowserRunConfig,
  type CredentialConfig,
  describeCredentialConfig,
} from "./config.ts";
import { BrowserRunError, errorMessage } from "./errors.ts";
import { redact, type SecretRegistry } from "./redact.ts";

export const ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
export const TOKEN_ENV = "CLOUDFLARE_BROWSER_RUN_TOKEN";

/** Credentials are re-resolved after this long, so a rotated token is picked up. */
export const CREDENTIAL_TTL_MS = 15 * 60 * 1000;

export type CredentialState =
  | "unconfigured"
  | "resolving"
  | "ready"
  | "unavailable"
  | "rejected";

/**
 * A resolved secret value. `toString`, `toJSON`, and `util.inspect` all yield
 * `[redacted]`, so an accidental template interpolation or a `JSON.stringify`
 * into tool `details` produces a placeholder rather than a token.
 *
 * This is a guardrail, not a boundary: `use()` still hands out the string, and
 * the code inside `use()` is responsible for not leaking it.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  use<T>(fn: (value: string) => T): T {
    return fn(this.#value);
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "[redacted]";
  }
}

export interface Credentials {
  accountId: Secret;
  token: Secret;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface CredentialStoreDeps {
  exec: ExecFn;
  env: NodeJS.ProcessEnv;
  now: () => number;
  registry?: SecretRegistry;
}

/**
 * Parse one field value out of a secret manager's stdout.
 *
 * `pass-cli item view --output json` is the documented shape, but the exact
 * envelope is not pinned by the CLI's help output, so this accepts the forms a
 * field read can plausibly take and rejects anything ambiguous. A wrong parse
 * surfaces later as `credentials_rejected` from Cloudflare, which is a clear
 * failure rather than a silent one.
 */
export function parseFieldOutput(stdout: string, field: string): string {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new BrowserRunError("credentials_unavailable", `field "${field}" resolved to an empty value`);
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      throw new BrowserRunError(
        "credentials_unavailable",
        `field "${field}" returned a list; expected a single value`,
      );
    }
    if (typeof parsed === "string") return parsed.trim();
    if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["value", "content", "data", "field"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
      }
      const stringValues = Object.values(record).filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      if (stringValues.length === 1) return (stringValues[0] as string).trim();
      throw new BrowserRunError(
        "credentials_unavailable",
        `field "${field}" returned an object with no single value; set the field name exactly`,
      );
    }
  } catch (error) {
    if (error instanceof BrowserRunError) throw error;
    // Not JSON. Fall through to the plain-text forms below.
  }

  const lines = trimmed.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 1) {
    const line = lines[0] as string;
    const labelled = line.match(/^\s*([^:]{1,64}?)\s*:\s*(.+)$/);
    if (labelled && labelled[1]?.trim().toLowerCase() === field.trim().toLowerCase()) {
      return (labelled[2] as string).trim();
    }
    return line.trim();
  }

  throw new BrowserRunError(
    "credentials_unavailable",
    `field "${field}" returned ${lines.length} lines; expected a single value`,
  );
}

/** Build the resolver argv for one field. The value never appears here, only the locator. */
export function buildResolverArgv(
  config: CredentialConfig,
  field: string,
): { command: string; args: string[] } {
  if (config.source === "proton-pass") {
    return {
      command: "pass-cli",
      args: [
        "item",
        "view",
        "--vault-name",
        config.vault as string,
        "--item-title",
        config.item as string,
        "--field",
        field,
        "--output",
        "json",
      ],
    };
  }
  if (config.source === "command") {
    const argv = (config.argv as string[]).map((entry) => entry.replaceAll("{field}", field));
    return { command: argv[0] as string, args: argv.slice(1) };
  }
  throw new BrowserRunError("not_configured", `credential source ${config.source} has no resolver`);
}

export class CredentialStore {
  readonly #deps: CredentialStoreDeps;
  #state: CredentialState = "unconfigured";
  #credentials: Credentials | undefined;
  #resolvedAt = 0;
  #inFlight: Promise<Credentials> | undefined;

  constructor(deps: CredentialStoreDeps) {
    this.#deps = deps;
  }

  getState(): CredentialState {
    return this.#state;
  }

  /** True when a token is held in memory and has not aged out. */
  isFresh(): boolean {
    return (
      this.#credentials !== undefined &&
      this.#deps.now() - this.#resolvedAt < CREDENTIAL_TTL_MS
    );
  }

  /** Called when Cloudflare answers 401 or 403, so the next call re-resolves. */
  markRejected(): void {
    this.#credentials = undefined;
    this.#resolvedAt = 0;
    this.#state = "rejected";
  }

  clear(): void {
    this.#credentials = undefined;
    this.#resolvedAt = 0;
    this.#inFlight = undefined;
    this.#state = "unconfigured";
    this.#deps.registry?.clear();
  }

  /**
   * Report whether credentials could be resolved without resolving them. Used by
   * `/browser status`, which must not unlock a vault as a side effect.
   */
  describe(config: BrowserRunConfig): { configured: boolean; how: string } {
    const { source } = config.credentials;
    if (source === "env") {
      const present =
        typeof this.#deps.env[ACCOUNT_ID_ENV] === "string" &&
        typeof this.#deps.env[TOKEN_ENV] === "string";
      return {
        configured: present,
        how: present
          ? describeCredentialConfig(config.credentials)
          : `${describeCredentialConfig(config.credentials)} (not set)`,
      };
    }
    return { configured: true, how: describeCredentialConfig(config.credentials) };
  }

  async resolve(config: BrowserRunConfig, signal?: AbortSignal): Promise<Credentials> {
    if (this.#credentials && this.isFresh()) return this.#credentials;
    if (this.#inFlight) return this.#inFlight;

    this.#state = "resolving";
    const attempt = this.#resolve(config.credentials, signal);
    this.#inFlight = attempt;
    try {
      const credentials = await attempt;
      this.#credentials = credentials;
      this.#resolvedAt = this.#deps.now();
      this.#state = "ready";
      return credentials;
    } catch (error) {
      this.#state = error instanceof BrowserRunError && error.errorClass === "not_configured"
        ? "unconfigured"
        : "unavailable";
      throw error;
    } finally {
      this.#inFlight = undefined;
    }
  }

  async #resolve(config: CredentialConfig, signal?: AbortSignal): Promise<Credentials> {
    if (config.source === "env") {
      const accountId = this.#deps.env[ACCOUNT_ID_ENV];
      const token = this.#deps.env[TOKEN_ENV];
      if (!accountId || !token) {
        throw new BrowserRunError(
          "not_configured",
          `set ${ACCOUNT_ID_ENV} and ${TOKEN_ENV}, or configure a credential locator with /browser`,
        );
      }
      return this.#wrap(accountId.trim(), token.trim());
    }

    const accountId = await this.#resolveField(config, config.accountIdField as string, signal);
    const token = await this.#resolveField(config, config.tokenField as string, signal);
    return this.#wrap(accountId, token);
  }

  #wrap(accountId: string, token: string): Credentials {
    this.#deps.registry?.remember(accountId);
    this.#deps.registry?.remember(token);
    return { accountId: new Secret(accountId), token: new Secret(token) };
  }

  async #resolveField(
    config: CredentialConfig,
    field: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { command, args } = buildResolverArgv(config, field);
    let result: ExecResult;
    try {
      result = await this.#deps.exec(command, args, { signal, timeout: 60_000 });
    } catch (error) {
      const detail = errorMessage(error).includes("ENOENT")
        ? `${command} is not installed or not on PATH`
        : `${command} could not be run: ${redact(errorMessage(error), this.#deps.registry)}`;
      throw new BrowserRunError("credentials_unavailable", detail, { cause: error });
    }

    if (result.code !== 0) {
      // stdout may hold the secret; only stderr is reported, and only scrubbed.
      const stderr = redact(result.stderr.trim().split("\n")[0] ?? "", this.#deps.registry);
      throw new BrowserRunError(
        "credentials_unavailable",
        `${command} exited ${result.code} reading field "${field}"${stderr ? `: ${stderr}` : ""}`,
      );
    }
    return parseFieldOutput(result.stdout, field);
  }
}
