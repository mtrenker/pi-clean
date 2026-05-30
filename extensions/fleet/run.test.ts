import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import {
  RUN_SCHEMA_VERSION,
  readRunMetadata,
  runMetadataPath,
  startRunMetadata,
  updateRunStatus,
  writeRunMetadata,
  type RunMetadata,
} from "./run.ts";
import { captureGitContext } from "./git-context.ts";
import { loadConfigWithStatus } from "./config.ts";

const execFile = promisify(execFileCb);

function makeRunMetadata(cwd: string, overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: "run-fixed",
    startedAt: "2026-05-30T09:00:00.000Z",
    status: "running",
    cwd,
    planPath: "PLAN.md",
    configSources: [{ label: "built-in", present: false }],
    concurrency: 2,
    git: {
      repoRoot: null,
      remote: null,
      branch: null,
      worktreePath: null,
      headSha: null,
      dirtyAtStart: null,
    },
    ...overrides,
  };
}

async function withSilencedWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

// ── run.json round-trip (fresh run) ─────────────────────────────────────────────

test("writeRunMetadata + readRunMetadata round-trips a fresh run.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-run-"));
  try {
    const metadata = makeRunMetadata(root, {
      runId: "run-001",
      git: {
        repoRoot: root,
        remote: "git@example.com:acme/widgets.git",
        branch: "main",
        worktreePath: root,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        dirtyAtStart: false,
      },
    });
    await writeRunMetadata(root, metadata);

    const onDisk = JSON.parse(await readFile(runMetadataPath(root), "utf-8"));
    assert.equal(onDisk.schemaVersion, 1);

    const loaded = await readRunMetadata(root);
    assert.deepEqual(loaded, metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRunMetadata returns null for a legacy run with no run.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-run-"));
  try {
    assert.equal(await readRunMetadata(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateRunStatus patches status and is a no-op when run.json is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-run-"));
  try {
    // No-op: must not throw or create a file when run.json is missing (legacy run).
    await updateRunStatus(root, "done");
    assert.equal(await readRunMetadata(root), null);

    await writeRunMetadata(root, makeRunMetadata(root, { status: "running" }));
    await updateRunStatus(root, "failed");

    const loaded = await readRunMetadata(root);
    assert.equal(loaded?.status, "failed");
    // Every other field is preserved untouched.
    assert.equal(loaded?.runId, "run-fixed");
    assert.equal(loaded?.startedAt, "2026-05-30T09:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startRunMetadata writes schema-versioned run.json from a config result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-run-"));
  const previousUserConfig = process.env.PI_FLEET_USER_CONFIG;
  process.env.PI_FLEET_USER_CONFIG = join(root, "user-fleet.json");
  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    const configResult = await loadConfigWithStatus(root);

    const metadata = await withSilencedWarnings(() => startRunMetadata(root, configResult));

    assert.equal(metadata.schemaVersion, RUN_SCHEMA_VERSION);
    assert.equal(metadata.status, "running");
    assert.equal(metadata.cwd, root);
    assert.equal(metadata.planPath, "PLAN.md");
    assert.equal(metadata.concurrency, configResult.config.concurrency);
    assert.match(metadata.runId, /^[0-9a-f-]{36}$/);
    assert.match(metadata.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(metadata.configSources, [{ label: "built-in", present: false }]);

    // The metadata is persisted and readable back.
    const loaded = await readRunMetadata(root);
    assert.deepEqual(loaded, metadata);
  } finally {
    if (previousUserConfig === undefined) delete process.env.PI_FLEET_USER_CONFIG;
    else process.env.PI_FLEET_USER_CONFIG = previousUserConfig;
    await rm(root, { recursive: true, force: true });
  }
});

// ── git-context fallback (legacy / non-git environment) ─────────────────────────

test("captureGitContext returns all-null fields and a warning outside a git work tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-nogit-"));
  try {
    const { git, warnings } = await captureGitContext(root);
    assert.deepEqual(git, {
      repoRoot: null,
      remote: null,
      branch: null,
      worktreePath: null,
      headSha: null,
      dirtyAtStart: null,
    });
    assert.ok(warnings.length >= 1);
    assert.match(warnings[0]!, /not inside a git work tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startRunMetadata tolerates a non-git cwd by writing null git fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-nogit-"));
  const previousUserConfig = process.env.PI_FLEET_USER_CONFIG;
  process.env.PI_FLEET_USER_CONFIG = join(root, "user-fleet.json");
  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    const configResult = await loadConfigWithStatus(root);
    const metadata = await withSilencedWarnings(() => startRunMetadata(root, configResult));
    assert.equal(metadata.git.repoRoot, null);
    assert.equal(metadata.git.headSha, null);
    assert.equal(metadata.git.dirtyAtStart, null);
  } finally {
    if (previousUserConfig === undefined) delete process.env.PI_FLEET_USER_CONFIG;
    else process.env.PI_FLEET_USER_CONFIG = previousUserConfig;
    await rm(root, { recursive: true, force: true });
  }
});

// ── git-context capture (fresh run inside a real git repo) ──────────────────────

test("captureGitContext populates fields inside a real git repo", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-git-"));
  try {
    try {
      await execFile("git", ["init", "-b", "main"], { cwd: root });
      await execFile("git", ["config", "user.email", "fleet-test@example.com"], { cwd: root });
      await execFile("git", ["config", "user.name", "Fleet Test"], { cwd: root });
      await execFile("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root });
    } catch {
      t.skip("git not available for repo-context test");
      return;
    }

    const { git } = await captureGitContext(root);
    assert.notEqual(git.repoRoot, null);
    assert.equal(git.branch, "main");
    assert.match(git.headSha ?? "", /^[0-9a-f]{40}$/);
    assert.notEqual(git.worktreePath, null);
    // No "origin" remote configured in this fixture.
    assert.equal(git.remote, null);
    // Known limitation (Task 002 handoff): `git status --porcelain` output is
    // coerced to null by the `stdout.trim() || null` helper, so a *clean* tree
    // is reported as dirtyAtStart === null (undetermined) rather than false.
    assert.equal(git.dirtyAtStart, null);

    // Introduce an uncommitted change → status --porcelain is non-empty → dirty.
    await writeFile(join(root, "scratch.txt"), "uncommitted\n", "utf-8");
    const dirty = await captureGitContext(root);
    assert.equal(dirty.git.dirtyAtStart, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureGitContext reports detached HEAD as a null branch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-git-"));
  try {
    try {
      await execFile("git", ["init", "-b", "main"], { cwd: root });
      await execFile("git", ["config", "user.email", "fleet-test@example.com"], { cwd: root });
      await execFile("git", ["config", "user.name", "Fleet Test"], { cwd: root });
      await execFile("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root });
      const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
      await execFile("git", ["checkout", stdout.trim()], { cwd: root });
    } catch {
      t.skip("git not available for detached-HEAD test");
      return;
    }

    const { git } = await captureGitContext(root);
    assert.equal(git.branch, null);
    assert.match(git.headSha ?? "", /^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
