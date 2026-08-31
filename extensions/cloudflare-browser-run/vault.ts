/**
 * Cloudflare Browser Run - profile key backends and sealed storage
 *
 * Section 11.3 of DESIGN.md. Saved storage state is bearer-equivalent
 * authentication material, so it is never written in plaintext.
 *
 * Envelope encryption: a random 32 byte data key encrypts the filtered storage
 * state with AES-256-GCM, the ciphertext goes to a 0600 file, and the data key is
 * wrapped by a key backend. A file holds the ciphertext because storage state runs
 * to tens of kilobytes; a keyring holds the key because 32 bytes is exactly what a
 * keyring is for.
 *
 * The backend chain never downgrades silently. A locked keyring is an error that
 * names the keyring, not a quiet fall-through to something weaker, because a
 * fallback that changes the security properties of stored credentials without
 * saying so is worse than a stopped workflow.
 *
 * Deletion destroys the wrapping key first. On a copy-on-write or journaling
 * filesystem, overwriting a file does not reliably erase the old blocks, so key
 * destruction is the guarantee that actually holds.
 */

import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { type StatePaths } from "./config.ts";
import { BrowserRunError, errorMessage } from "./errors.ts";

export const KEY_BYTES = 32;
export const SEAL_VERSION = 1;
export const KEYRING_SERVICE = "pi-cloudflare-browser-run";
export const PROFILE_KEY_ENV = "PI_BROWSER_RUN_PROFILE_KEY";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a command with an optional stdin payload, so a key never reaches argv. */
export type CommandRunner = (command: string, args: string[], input?: string) => Promise<RunResult>;

export function createCommandRunner(): CommandRunner {
  return (command, args, input) =>
    new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

export interface SealedBlob {
  version: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** Bind the profile name and format version into the ciphertext. */
function additionalData(profile: string): Buffer {
  return Buffer.from(`profile=${profile};version=${SEAL_VERSION}`, "utf8");
}

export function seal(plaintext: string, key: Buffer, profile: string): SealedBlob {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(profile));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: SEAL_VERSION,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function unseal(blob: SealedBlob, key: Buffer, profile: string): string {
  if (blob.version !== SEAL_VERSION) {
    throw new BrowserRunError(
      "profile_unreadable",
      `profile ${profile} was written in format version ${blob.version}; this build reads version ${SEAL_VERSION}`,
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.nonce, "base64"));
    decipher.setAAD(additionalData(profile));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new BrowserRunError(
      "profile_unreadable",
      `profile ${profile} could not be decrypted with the stored key`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Key backends
// ---------------------------------------------------------------------------

export type KeyBackendId = "keyring" | "secret-manager" | "env";

export interface KeyBackend {
  id: KeyBackendId;
  describe(): string;
  get(profile: string): Promise<Buffer | null>;
  set(profile: string, key: Buffer): Promise<void>;
  clear(profile: string): Promise<void>;
}

/** libsecret. The key travels on stdin; argv carries only the lookup attributes. */
export function createKeyringBackend(run: CommandRunner): KeyBackend {
  const attributes = (profile: string): string[] => ["service", KEYRING_SERVICE, "profile", profile];

  return {
    id: "keyring",
    describe: () => `OS keyring (secret-tool, service ${KEYRING_SERVICE})`,
    async get(profile) {
      const result = await run("secret-tool", ["lookup", ...attributes(profile)]).catch((error: unknown) => {
        throw new BrowserRunError(
          "profile_unreadable",
          `secret-tool could not be run: ${errorMessage(error)}`,
          { cause: error },
        );
      });
      if (result.code === 0) return Buffer.from(result.stdout.trim(), "base64");
      // Exit 1 with nothing on stderr is "no such secret". Anything else means the
      // keyring itself is unavailable, most often locked, and must not fall through.
      if (result.code === 1 && result.stderr.trim() === "") return null;
      throw new BrowserRunError(
        "profile_unreadable",
        `the OS keyring is unavailable (secret-tool exited ${result.code}${
          result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""
        }). Unlock the keyring, or configure another profile key backend.`,
      );
    },
    async set(profile, key) {
      const result = await run(
        "secret-tool",
        ["store", "--label", `Pi Browser Run profile ${profile}`, ...attributes(profile)],
        key.toString("base64"),
      );
      if (result.code !== 0) {
        throw new BrowserRunError(
          "profile_unreadable",
          `the OS keyring refused the key (secret-tool exited ${result.code})`,
        );
      }
    },
    async clear(profile) {
      const result = await run("secret-tool", ["clear", ...attributes(profile)]);
      if (result.code !== 0) {
        throw new BrowserRunError(
          "profile_unreadable",
          `the OS keyring refused to clear the key (secret-tool exited ${result.code}). ` +
            "The sealed file was left in place because its key still exists.",
        );
      }
    },
  };
}

export interface SecretManagerLocator {
  command: string;
  args: string[];
}

/**
 * A secret manager holding one master key, from which each profile key is
 * derived. Works headless and needs no prompt, which is what RPC and print modes
 * require. Read-only: a secret manager backend cannot mint new keys, so the
 * master key is provisioned by the operator once.
 */
export function createSecretManagerBackend(
  run: CommandRunner,
  locator: SecretManagerLocator,
): KeyBackend {
  const master = async (): Promise<Buffer> => {
    const result = await run(locator.command, locator.args);
    if (result.code !== 0) {
      throw new BrowserRunError(
        "profile_unreadable",
        `${locator.command} exited ${result.code} reading the profile master key`,
      );
    }
    const value = result.stdout.trim();
    if (value === "") {
      throw new BrowserRunError("profile_unreadable", "the profile master key is empty");
    }
    return Buffer.from(value, "base64");
  };

  return {
    id: "secret-manager",
    describe: () => `secret manager (${locator.command})`,
    async get(profile) {
      return deriveProfileKey(await master(), profile);
    },
    async set() {
      // Derived keys need nothing stored: the master key is the only secret.
      return undefined;
    },
    async clear() {
      throw new BrowserRunError(
        "profile_unreadable",
        "the secret-manager backend derives keys from one master key, so a single profile's key " +
          "cannot be destroyed. Rotate the master key to invalidate every profile.",
      );
    },
  };
}

/** For the opt-in integration test. One master key in the environment, derived per profile. */
export function createEnvBackend(env: NodeJS.ProcessEnv): KeyBackend {
  const master = (): Buffer => {
    const value = env[PROFILE_KEY_ENV];
    if (!value) {
      throw new BrowserRunError("profile_unreadable", `${PROFILE_KEY_ENV} is not set`);
    }
    return Buffer.from(value, "base64");
  };
  return {
    id: "env",
    describe: () => `environment variable ${PROFILE_KEY_ENV}`,
    async get(profile) {
      return deriveProfileKey(master(), profile);
    },
    async set() {
      return undefined;
    },
    async clear() {
      throw new BrowserRunError(
        "profile_unreadable",
        `the ${PROFILE_KEY_ENV} backend derives keys from one master key, so a single profile's ` +
          "key cannot be destroyed. Rotate the variable to invalidate every profile.",
      );
    },
  };
}

/** HKDF so one master key yields an independent key per profile. */
export function deriveProfileKey(master: Buffer, profile: string): Buffer {
  if (master.byteLength < KEY_BYTES) {
    throw new BrowserRunError(
      "profile_unreadable",
      `the profile master key must be at least ${KEY_BYTES} bytes of base64`,
    );
  }
  const derived = hkdfSync(
    "sha256",
    master,
    Buffer.from(KEYRING_SERVICE),
    Buffer.from(profile),
    KEY_BYTES,
  );
  return Buffer.from(derived);
}

export interface BackendResolution {
  backend: KeyBackend;
  /** Backends that derive from a master key cannot mint a new random key. */
  canMintKeys: boolean;
}

export interface ResolveBackendOptions {
  preferred: "auto" | KeyBackendId;
  run: CommandRunner;
  env: NodeJS.ProcessEnv;
  secretManager?: SecretManagerLocator;
}

export async function resolveKeyBackend(options: ResolveBackendOptions): Promise<BackendResolution> {
  const keyringAvailable = async (): Promise<boolean> => {
    try {
      const result = await options.run("secret-tool", ["--version"]);
      return result.code === 0;
    } catch {
      return false;
    }
  };

  if (options.preferred === "keyring") {
    if (!(await keyringAvailable())) {
      throw new BrowserRunError("profile_unreadable", "secret-tool is not installed or not on PATH");
    }
    return { backend: createKeyringBackend(options.run), canMintKeys: true };
  }
  if (options.preferred === "secret-manager") {
    if (!options.secretManager) {
      throw new BrowserRunError(
        "profile_unreadable",
        "the secret-manager backend needs profileVault.secretManager in the configuration",
      );
    }
    return {
      backend: createSecretManagerBackend(options.run, options.secretManager),
      canMintKeys: false,
    };
  }
  if (options.preferred === "env") {
    return { backend: createEnvBackend(options.env), canMintKeys: false };
  }

  if (await keyringAvailable()) {
    return { backend: createKeyringBackend(options.run), canMintKeys: true };
  }
  if (options.secretManager) {
    return {
      backend: createSecretManagerBackend(options.run, options.secretManager),
      canMintKeys: false,
    };
  }
  if (options.env[PROFILE_KEY_ENV]) {
    return { backend: createEnvBackend(options.env), canMintKeys: false };
  }
  throw new BrowserRunError(
    "profile_unreadable",
    "no profile key backend is available. Install libsecret (secret-tool), configure " +
      `profileVault.secretManager, or set ${PROFILE_KEY_ENV}. Profiles are never stored in plaintext.`,
  );
}

// ---------------------------------------------------------------------------
// Sealed file storage
// ---------------------------------------------------------------------------

export class ProfileVault {
  readonly #paths: StatePaths;
  readonly #resolution: BackendResolution;

  constructor(paths: StatePaths, resolution: BackendResolution) {
    this.#paths = paths;
    this.#resolution = resolution;
  }

  get backendId(): KeyBackendId {
    return this.#resolution.backend.id;
  }

  describeBackend(): string {
    return this.#resolution.backend.describe();
  }

  sealedPath(profile: string): string {
    return join(this.#paths.profilesDir, `${profile}.sealed`);
  }

  async save(profile: string, plaintext: string): Promise<void> {
    const path = this.sealedPath(profile);
    await withFileMutationQueue(path, async () => {
      let key = await this.#resolution.backend.get(profile);
      if (!key || key.byteLength !== KEY_BYTES) {
        if (!this.#resolution.canMintKeys) {
          throw new BrowserRunError(
            "profile_unreadable",
            `the ${this.#resolution.backend.id} backend has no key for profile ${profile}`,
          );
        }
        key = randomBytes(KEY_BYTES);
        await this.#resolution.backend.set(profile, key);
      }
      const blob = seal(plaintext, key, profile);
      await writeFile(path, JSON.stringify(blob), { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    });
  }

  async load(profile: string): Promise<string> {
    const key = await this.#resolution.backend.get(profile);
    if (!key || key.byteLength !== KEY_BYTES) {
      throw new BrowserRunError(
        "profile_unreadable",
        `no key is stored for profile ${profile} in ${this.#resolution.backend.describe()}`,
      );
    }
    let text: string;
    try {
      text = await readFile(this.sealedPath(profile), "utf8");
    } catch (error) {
      throw new BrowserRunError(
        "profile_missing",
        `profile ${profile} has no saved authentication state. Run /browser-login ${profile}.`,
        { cause: error },
      );
    }
    let blob: SealedBlob;
    try {
      blob = JSON.parse(text) as SealedBlob;
    } catch (error) {
      throw new BrowserRunError("profile_unreadable", `profile ${profile} is corrupt`, {
        cause: error,
      });
    }
    return unseal(blob, key, profile);
  }

  /**
   * Destroy the key first, then the ciphertext. If key destruction fails the
   * ciphertext stays, because a sealed file whose key still exists is the state
   * the operator can retry from.
   */
  async destroy(profile: string): Promise<void> {
    await this.#resolution.backend.clear(profile);
    await rm(this.sealedPath(profile), { force: true });
  }
}
