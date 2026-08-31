/**
 * Profile tests - DESIGN.md acceptance criteria AC-P1, AC-P2, AC-P3, AC-P5, AC-P8.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureStateDir, statePaths, type ProfileDefinition } from "./config.ts";
import { BrowserRunError } from "./errors.ts";
import {
  domainCovers,
  filterStorageState,
  ProfileStore,
  PROFILE_FORMAT_VERSION,
  type StorageState,
} from "./profiles.ts";
import { createEnvBackend, ProfileVault, PROFILE_KEY_ENV } from "./vault.ts";

const NOW = Date.UTC(2026, 0, 1) ;
const FUTURE = Math.floor(NOW / 1000) + 86_400;
const PAST = Math.floor(NOW / 1000) - 86_400;

const DEFINITION: ProfileDefinition = {
  origins: ["https://www.example.com"],
  allowNavigationOutsideProfile: false,
};

function state(overrides: Partial<StorageState> = {}): StorageState {
  return {
    cookies: [
      { name: "sid", value: "host-only", domain: "www.example.com", path: "/", expires: FUTURE },
      { name: "pref", value: "domain-wide", domain: ".example.com", path: "/", expires: FUTURE + 10 },
      { name: "other", value: "elsewhere", domain: "www.other.com", path: "/", expires: FUTURE },
      { name: "wildcard", value: "elsewhere", domain: ".other.com", path: "/", expires: FUTURE },
      { name: "bare", value: "bare-host", domain: "example.com", path: "/", expires: FUTURE },
      { name: "session", value: "no-expiry", domain: "www.example.com", path: "/", expires: -1 },
      { name: "stale", value: "expired", domain: "www.example.com", path: "/", expires: PAST },
    ],
    origins: [
      { origin: "https://www.example.com", localStorage: [{ name: "token", value: "abc" }] },
      { origin: "https://example.com", localStorage: [{ name: "other", value: "def" }] },
      { origin: "https://www.other.com", localStorage: [{ name: "x", value: "y" }] },
    ],
    ...overrides,
  };
}

test("AC-P1 only exactly allowlisted origins survive", () => {
  const result = filterStorageState(state(), DEFINITION.origins, NOW);
  assert.deepEqual(
    result.state.origins.map((entry) => entry.origin),
    ["https://www.example.com"],
  );
  assert.equal(result.droppedOrigins, 2, "the bare domain and the unrelated host are dropped");
  assert.deepEqual(result.localStorageCounts, { "https://www.example.com": 1 });
});

test("AC-P2 host-only and covering domain cookies are kept, everything else dropped", () => {
  const result = filterStorageState(state(), DEFINITION.origins, NOW);
  const names = result.state.cookies.map((cookie) => cookie.name).sort();
  assert.deepEqual(names, ["pref", "session", "sid"]);
  assert.equal(result.keptCookies, 3);
  assert.equal(result.droppedCookies, 4);
});

test("AC-P3 a retained domain cookie is recorded as broader than the allowlist", () => {
  const withDomain = filterStorageState(state(), DEFINITION.origins, NOW);
  assert.equal(withDomain.carriesDomainCookies, true);

  const hostOnly = filterStorageState(
    {
      cookies: [{ name: "sid", value: "v", domain: "www.example.com", path: "/", expires: FUTURE }],
      origins: [],
    },
    DEFINITION.origins,
    NOW,
  );
  assert.equal(hostOnly.carriesDomainCookies, false);
});

test("an already-expired cookie is dropped and does not skew the reported expiry", () => {
  const result = filterStorageState(state(), DEFINITION.origins, NOW);
  assert.ok(!result.state.cookies.some((cookie) => cookie.name === "stale"));
  assert.equal(result.earliestCookieExpiry, FUTURE, "session cookies do not count as an expiry");
});

test("domain coverage matches the host and its subdomains only", () => {
  assert.equal(domainCovers(".example.com", "www.example.com"), true);
  assert.equal(domainCovers(".example.com", "example.com"), true);
  assert.equal(domainCovers("example.com", "deep.sub.example.com"), true);
  assert.equal(domainCovers(".example.com", "notexample.com"), false);
  assert.equal(domainCovers(".example.com", "example.com.evil.net"), false);
});

test("a malformed storage state yields an empty filter rather than throwing", () => {
  const result = filterStorageState(undefined, DEFINITION.origins, NOW);
  assert.equal(result.keptCookies, 0);
  assert.equal(result.keptOrigins, 0);
  assert.equal(result.earliestCookieExpiry, null);
});

async function makeStore(t: { after: (fn: () => Promise<void>) => void }, now = NOW) {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-profiles-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const paths = statePaths(dir);
  await ensureStateDir(paths);
  const vault = new ProfileVault(paths, {
    backend: createEnvBackend({ [PROFILE_KEY_ENV]: Buffer.alloc(48, 9).toString("base64") }),
    canMintKeys: false,
  });
  return { store: new ProfileStore(paths, vault, () => now), paths, vault };
}

test("AC-P5 metadata records counts and never a cookie name or value", async (t) => {
  const { store } = await makeStore(t);
  const { metadata } = await store.save("example-site", DEFINITION, state());

  assert.equal(metadata.cookieCount, 3);
  assert.equal(metadata.droppedCookieCount, 4);
  assert.equal(metadata.originCount, 1);
  assert.equal(metadata.carriesDomainCookies, true);
  assert.equal(metadata.keyBackend, "env");
  assert.equal(metadata.formatVersion, PROFILE_FORMAT_VERSION);

  const serialized = await readFile(store.metadataPath("example-site"), "utf8");
  for (const forbidden of ["sid", "pref", "host-only", "domain-wide", "abc", "top-secret"]) {
    assert.ok(!serialized.includes(forbidden), `metadata leaked ${forbidden}`);
  }
  assert.equal((await stat(store.metadataPath("example-site"))).mode & 0o777, 0o600);
});

test("a saved profile restores exactly the filtered state", async (t) => {
  const { store } = await makeStore(t);
  await store.save("example-site", DEFINITION, state());
  const loaded = await store.load("example-site");
  assert.deepEqual(
    loaded.state.cookies.map((cookie) => cookie.name).sort(),
    ["pref", "session", "sid"],
  );
  assert.deepEqual(loaded.state.origins[0]?.origin, "https://www.example.com");
});

test("saving a profile whose sign-in matched nothing is refused", async (t) => {
  const { store } = await makeStore(t);
  await assert.rejects(
    () => store.save("example-site", DEFINITION, { cookies: [], origins: [] }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_missing" &&
      /no cookies or local storage matched/.test(error.detail),
  );
});

test("AC-P8 expired and missing profiles fail closed with the recovery step", async (t) => {
  const { store, paths, vault } = await makeStore(t);
  await store.save("example-site", DEFINITION, state());
  assert.equal((await store.status("example-site")).state, "saved");

  // The same stored profile, read after its earliest cookie expiry has passed.
  const later = new ProfileStore(paths, vault, () => (FUTURE + 1) * 1000);
  const status = await later.status("example-site");
  assert.equal(status.state, "expired");
  assert.match(status.reason ?? "", /a stored cookie has expired/);

  await assert.rejects(
    () => later.load("example-site"),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_expired" &&
      /\/browser-login example-site/.test(error.detail),
  );

  await assert.rejects(
    () => store.load("never-created"),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_missing" &&
      /\/browser-login never-created/.test(error.detail),
  );
});

test("status and list report every declared profile without decrypting", async (t) => {
  const { store } = await makeStore(t);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.status("nothing"), { name: "nothing", state: "absent" });

  await store.save("example-site", DEFINITION, state());
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "example-site");
  assert.equal(listed[0]?.state, "saved");
});

test("removal destroys the key before the metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-profiles-rm-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const paths = statePaths(dir);
  await ensureStateDir(paths);

  const order: string[] = [];
  const vault = new ProfileVault(paths, {
    backend: {
      id: "keyring",
      describe: () => "double",
      async get() {
        return Buffer.alloc(32, 4);
      },
      async set() {
        order.push("set");
      },
      async clear() {
        order.push("clear");
      },
    },
    canMintKeys: true,
  });
  const store = new ProfileStore(paths, vault, () => NOW);
  await store.save("example-site", DEFINITION, state());

  await store.remove("example-site");
  assert.deepEqual(order, ["clear"]);
  assert.equal((await store.status("example-site")).state, "absent");
});

test("a profile written by a future format version is unreadable rather than misread", async (t) => {
  const { store } = await makeStore(t);
  await store.save("example-site", DEFINITION, state());
  const metadata = JSON.parse(await readFile(store.metadataPath("example-site"), "utf8")) as Record<
    string,
    unknown
  >;
  metadata["formatVersion"] = PROFILE_FORMAT_VERSION + 1;
  await (await import("node:fs/promises")).writeFile(
    store.metadataPath("example-site"),
    JSON.stringify(metadata),
    "utf8",
  );

  const status = await store.status("example-site");
  assert.equal(status.state, "unreadable");
  await assert.rejects(
    () => store.load("example-site"),
    (error: unknown) =>
      error instanceof BrowserRunError && error.errorClass === "profile_unreadable",
  );
});
