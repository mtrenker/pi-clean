import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { browserWorkspaceKey } from "./identity.ts";
import { migrateFromV1, REGISTRY_VERSION, WorkspaceRegistry } from "./registry.ts";
import type { WorkspaceRecord } from "./types.ts";

function legacyRecord(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    logicalKey: "legacy-key",
    workspaceId: "legacy-workspace",
    profile: "authenticated-browser",
    trustDomain: "personal",
    sandboxName: "authenticated-browser-legacy",
    sandboxId: "sandbox-1",
    staticFingerprint: "static-1",
    dynamicFingerprint: "dynamic-1",
    providers: [],
    browserProfile: "personal-browser",
    browser: { persistent: true, controllerPort: 3010, noVncPort: 6080, image: "image", imageContract: "contract", basePolicy: "policy.yaml" },
    browserSandboxName: "authenticated-browser-legacy-browser",
    browserSandboxId: "sandbox-2",
    browserControlSecret: "legacy-control-secret",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function registryWith(content: unknown): Promise<WorkspaceRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "openshell-registry-"));
  const path = join(dir, "workspaces.json");
  await writeFile(path, JSON.stringify(content, null, 2));
  return new WorkspaceRegistry(path);
}

test("a legacy browser sandbox is adopted as a shared browser workspace without losing its login", async () => {
  const registry = await registryWith({ version: 1, workspaces: [legacyRecord()] });
  const state = await registry.read();
  const key = browserWorkspaceKey("personal", "personal-browser");
  assert.equal(state.browserWorkspaces.length, 1);
  assert.deepEqual(
    { ...state.browserWorkspaces[0], updatedAt: "stamped" },
    {
      browserWorkspaceKey: key,
      trustDomain: "personal",
      browserProfile: "personal-browser",
      sandboxName: "authenticated-browser-legacy-browser",
      sandboxId: "sandbox-2",
      staticFingerprint: "",
      controlSecret: "legacy-control-secret",
      adoptedFrom: "legacy-key",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "stamped",
    },
  );
  const [record] = state.workspaces;
  assert.equal(record.browserWorkspaceKey, key);
  assert.equal(record.browserControlSecret, undefined, "the control secret moves to the browser workspace");
  assert.equal(record.browserSandboxName, undefined);
  assert.equal(record.browserAdoptionConflict, undefined);
});

test("a safe and an autonomous profile in one trust domain resolve to the same browser workspace", () => {
  const safe = browserWorkspaceKey("personal", "personal-browser");
  const autonomous = browserWorkspaceKey("personal", "personal-browser");
  assert.equal(safe, autonomous, "browser identity excludes the worker profile");
  assert.notEqual(safe, browserWorkspaceKey("client-a", "personal-browser"), "another trust domain is a different workspace");
  assert.notEqual(safe, browserWorkspaceKey("personal", "client-a-browser"));
});

test("two legacy workspaces claiming one browser identity fail closed instead of merging", () => {
  const state = migrateFromV1([
    legacyRecord(),
    legacyRecord({
      logicalKey: "legacy-key-2",
      workspaceId: "legacy-workspace-2",
      profile: "client-browser",
      sandboxName: "client-browser-legacy",
      browserSandboxName: "client-browser-legacy-browser",
      browserControlSecret: "other-control-secret",
    }),
  ]);
  assert.deepEqual(state.browserWorkspaces, []);
  for (const record of state.workspaces) {
    assert.equal(record.browserAdoptionConflict, true);
    assert.equal(record.browserWorkspaceKey, undefined);
    assert.equal(record.browserControlSecret !== undefined, true, "nothing is silently reassigned or deleted");
  }
});

test("a legacy workspace without a control secret is left alone rather than adopted", () => {
  const state = migrateFromV1([legacyRecord({ browserControlSecret: undefined })]);
  assert.deepEqual(state.browserWorkspaces, []);
  assert.equal(state.workspaces[0].browserWorkspaceKey, undefined);
});

test("migration is persisted once and the registry file stays owner-only", async () => {
  const registry = await registryWith({ version: 1, workspaces: [legacyRecord()] });
  await registry.migrate();
  const file = JSON.parse(await readFile(registry.path, "utf8")) as { version: number; browserWorkspaces: unknown[] };
  assert.equal(file.version, REGISTRY_VERSION);
  assert.equal(file.browserWorkspaces.length, 1);
  assert.equal((await stat(registry.path)).mode & 0o777, 0o600);
  const reread = await registry.read();
  assert.equal(reread.browserWorkspaces[0].controlSecret, "legacy-control-secret");
});

test("browser workspace records are addressable, replaceable, and removable", async () => {
  const registry = await registryWith({ version: 1, workspaces: [legacyRecord()] });
  const key = browserWorkspaceKey("personal", "personal-browser");
  const existing = (await registry.findBrowserWorkspace(key))!;
  await registry.putBrowserWorkspace({ ...existing, staticFingerprint: "reconciled" });
  assert.equal((await registry.findBrowserWorkspace(key))!.staticFingerprint, "reconciled");
  await registry.removeBrowserWorkspace(key);
  assert.equal(await registry.findBrowserWorkspace(key), undefined);
  assert.equal((await registry.list())[0].browserWorkspaceKey, undefined, "workspaces stop pointing at a deleted browser");
});

test("an unknown registry version fails closed", async () => {
  const registry = await registryWith({ version: 99, workspaces: [] });
  await assert.rejects(registry.read(), /unsupported registry format/);
});
