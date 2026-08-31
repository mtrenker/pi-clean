/**
 * Cloudflare Browser Run - named authenticated profiles
 *
 * Sections 11.1, 11.2, and 11.4 of DESIGN.md.
 *
 * The honest limit, which belongs next to the code and in the README: filtering
 * bounds what is stored, not what the browser sends. A retained `.example.com`
 * cookie is sent by Chrome to every `*.example.com` host the context visits,
 * which is broader than the allowlist. The control that actually bounds exposure
 * is navigation confinement in session.ts, which keeps a profile-backed context
 * on the profile's origins in the first place.
 */

import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { type ProfileDefinition, type StatePaths } from "./config.ts";
import { BrowserRunError } from "./errors.ts";
import { type KeyBackendId, type ProfileVault } from "./vault.ts";

export const PROFILE_FORMAT_VERSION = 1;

export type ProfileState = "absent" | "saved" | "expired" | "unreadable";

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface StorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: StorageOrigin[];
}

export interface FilterResult {
  state: StorageState;
  keptCookies: number;
  droppedCookies: number;
  keptOrigins: number;
  droppedOrigins: number;
  /** True when a retained cookie is domain scoped and therefore broader than the allowlist. */
  carriesDomainCookies: boolean;
  /** Unix seconds of the soonest non-session cookie expiry, or null when there is none. */
  earliestCookieExpiry: number | null;
  localStorageCounts: Record<string, number>;
}

function hostsOf(origins: string[]): string[] {
  return origins.map((origin) => new URL(origin).hostname.toLowerCase());
}

/** A domain cookie covers a host when the host is the domain or a subdomain of it. */
export function domainCovers(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Keep only what the allowlist covers.
 *
 * - `origins[]` entries survive on an exact origin match, so a bare-domain entry
 *   is dropped when only the `www` host is allowed.
 * - A host-only cookie survives when its host equals an allowed origin's host.
 * - A domain cookie survives when it covers an allowed host.
 * - An already-expired cookie is dropped: it is dead weight that would only
 *   distort the profile's expiry reporting.
 */
export function filterStorageState(
  raw: unknown,
  origins: string[],
  now: number = Date.now(),
): FilterResult {
  const state = (raw ?? {}) as Partial<StorageState>;
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const originEntries = Array.isArray(state.origins) ? state.origins : [];
  const allowedOrigins = new Set(origins);
  const allowedHosts = hostsOf(origins);

  const keptOrigins = originEntries.filter((entry) => allowedOrigins.has(entry.origin));
  const nowSeconds = Math.floor(now / 1000);

  let carriesDomainCookies = false;
  const keptCookies = cookies.filter((cookie) => {
    if (typeof cookie?.domain !== "string") return false;
    if (cookie.expires > 0 && cookie.expires < nowSeconds) return false;

    const isDomainCookie = cookie.domain.startsWith(".");
    const covered = isDomainCookie
      ? allowedHosts.some((host) => domainCovers(cookie.domain, host))
      : allowedHosts.includes(cookie.domain.toLowerCase());
    if (covered && isDomainCookie) carriesDomainCookies = true;
    return covered;
  });

  const expiries = keptCookies.map((cookie) => cookie.expires).filter((value) => value > 0);
  const localStorageCounts: Record<string, number> = {};
  for (const entry of keptOrigins) {
    localStorageCounts[entry.origin] = Array.isArray(entry.localStorage)
      ? entry.localStorage.length
      : 0;
  }

  return {
    state: { cookies: keptCookies, origins: keptOrigins },
    keptCookies: keptCookies.length,
    droppedCookies: cookies.length - keptCookies.length,
    keptOrigins: keptOrigins.length,
    droppedOrigins: originEntries.length - keptOrigins.length,
    carriesDomainCookies,
    earliestCookieExpiry: expiries.length > 0 ? Math.min(...expiries) : null,
    localStorageCounts,
  };
}

/** Non-secret. No cookie names, no values, no page text. */
export interface ProfileMetadata {
  name: string;
  origins: string[];
  formatVersion: number;
  createdAt: string;
  lastRefreshedAt: string;
  cookieCount: number;
  droppedCookieCount: number;
  originCount: number;
  localStorageCounts: Record<string, number>;
  earliestCookieExpiry: number | null;
  carriesDomainCookies: boolean;
  keyBackend: KeyBackendId;
}

export interface ProfileStatus {
  name: string;
  state: ProfileState;
  metadata?: ProfileMetadata;
  reason?: string;
}

export class ProfileStore {
  readonly #paths: StatePaths;
  readonly #vault: ProfileVault;
  readonly #now: () => number;

  constructor(paths: StatePaths, vault: ProfileVault, now: () => number = () => Date.now()) {
    this.#paths = paths;
    this.#vault = vault;
    this.#now = now;
  }

  metadataPath(name: string): string {
    return join(this.#paths.profilesDir, `${name}.meta.json`);
  }

  async save(
    name: string,
    definition: ProfileDefinition,
    rawState: unknown,
  ): Promise<{ metadata: ProfileMetadata; filter: FilterResult }> {
    const filter = filterStorageState(rawState, definition.origins, this.#now());
    if (filter.keptCookies === 0 && filter.keptOrigins === 0) {
      throw new BrowserRunError(
        "profile_missing",
        `no cookies or local storage matched the allowed origins for ${name}. ` +
          "Check that the sign-in completed on one of the configured origins.",
      );
    }

    await this.#vault.save(name, JSON.stringify(filter.state));

    const previous = await this.readMetadata(name).catch(() => undefined);
    const timestamp = new Date(this.#now()).toISOString();
    const metadata: ProfileMetadata = {
      name,
      origins: [...definition.origins],
      formatVersion: PROFILE_FORMAT_VERSION,
      createdAt: previous?.createdAt ?? timestamp,
      lastRefreshedAt: timestamp,
      cookieCount: filter.keptCookies,
      droppedCookieCount: filter.droppedCookies,
      originCount: filter.keptOrigins,
      localStorageCounts: filter.localStorageCounts,
      earliestCookieExpiry: filter.earliestCookieExpiry,
      carriesDomainCookies: filter.carriesDomainCookies,
      keyBackend: this.#vault.backendId,
    };

    const path = this.metadataPath(name);
    await withFileMutationQueue(path, async () => {
      await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    return { metadata, filter };
  }

  async readMetadata(name: string): Promise<ProfileMetadata> {
    const text = await readFile(this.metadataPath(name), "utf8");
    return JSON.parse(text) as ProfileMetadata;
  }

  async status(name: string): Promise<ProfileStatus> {
    let metadata: ProfileMetadata;
    try {
      metadata = await this.readMetadata(name);
    } catch {
      return { name, state: "absent" };
    }
    if (metadata.formatVersion !== PROFILE_FORMAT_VERSION) {
      return {
        name,
        state: "unreadable",
        metadata,
        reason: `written in format version ${metadata.formatVersion}`,
      };
    }
    if (
      metadata.earliestCookieExpiry !== null &&
      metadata.earliestCookieExpiry * 1000 <= this.#now()
    ) {
      return { name, state: "expired", metadata, reason: "a stored cookie has expired" };
    }
    return { name, state: "saved", metadata };
  }

  /**
   * Fail closed. A profile that cannot be restored never falls back to an
   * anonymous context: a model that believes it is signed in and is not will
   * misread every page that follows.
   */
  async load(name: string): Promise<{ state: StorageState; metadata: ProfileMetadata }> {
    const status = await this.status(name);
    if (status.state === "absent") {
      throw new BrowserRunError(
        "profile_missing",
        `profile ${name} has no saved authentication state. Ask the operator to run /browser-login ${name}.`,
      );
    }
    if (status.state === "expired") {
      throw new BrowserRunError(
        "profile_expired",
        `profile ${name} has expired (${status.reason}). Ask the operator to run /browser-login ${name}.`,
      );
    }
    if (status.state === "unreadable") {
      throw new BrowserRunError(
        "profile_unreadable",
        `profile ${name} is unreadable (${status.reason}). Ask the operator to run /browser-login ${name}.`,
      );
    }
    const plaintext = await this.#vault.load(name);
    return { state: JSON.parse(plaintext) as StorageState, metadata: status.metadata! };
  }

  async list(): Promise<ProfileStatus[]> {
    let files: string[];
    try {
      files = await readdir(this.#paths.profilesDir);
    } catch {
      return [];
    }
    const names = files
      .filter((file) => file.endsWith(".meta.json"))
      .map((file) => file.slice(0, -".meta.json".length))
      .sort();
    return Promise.all(names.map((name) => this.status(name)));
  }

  /** Key destruction is the deletion guarantee; the metadata goes last. */
  async remove(name: string): Promise<void> {
    await this.#vault.destroy(name);
    await rm(this.metadataPath(name), { force: true });
  }
}
