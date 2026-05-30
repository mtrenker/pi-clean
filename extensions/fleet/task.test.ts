import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskFolder, listTasks, readStatus, writeStatus } from "./task.ts";

/**
 * Writes a pre-004 / pre-005 status.json fixture: only the fields that existed
 * before heartbeat timestamps and normalized usage were introduced. Used to
 * verify historical task folders keep loading after the schema grew.
 */
async function writeLegacyStatus(
  root: string,
  folder: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(root, ".pi", "tasks", folder);
  await mkdir(dir, { recursive: true });
  const legacy = {
    id: "001",
    name: "legacy-task",
    status: "done",
    engine: "codex",
    model: "gpt-5.3-codex",
    agent: "worker",
    depends: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    duration: 300000,
    retries: 0,
    pid: null,
    error: null,
    // Old two-field usage shape; no cache/total/source/updatedAt fields.
    usage: { inputTokens: 120, outputTokens: 30 },
    // Intentionally omits lastHeartbeatAt / lastOutputAt / lastProgressAt / staleAfterSeconds.
    ...overrides,
  };
  await writeFile(join(dir, "status.json"), JSON.stringify(legacy, null, 2), "utf-8");
}

test("createTaskFolder writes task.md with explicit task-local progress and output paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });

    await createTaskFolder(root, {
      id: "001",
      slug: "audit-widget",
      name: "Audit widget",
      engine: "claude",
      model: "sonnet",
      profile: "deep",
      agent: "scout",
      depends: [],
      description: "Read `extensions/fleet/widget.ts` and verify the current rendering behavior. Acceptance: write findings and confirm the exact files involved.",
    });

    const taskMd = await readFile(join(root, ".pi", "tasks", "001-audit-widget", "task.md"), "utf-8");

    assert.match(taskMd, /Your task instructions are in `\.pi\/tasks\/001-audit-widget\/task\.md`\./);
    assert.match(taskMd, /Write progress updates only to `\.pi\/tasks\/001-audit-widget\/progress\.jsonl`/);
    assert.match(taskMd, /Raw engine output is captured separately in `\.pi\/tasks\/001-audit-widget\/output\.jsonl`\./);
    assert.match(taskMd, /never create or append to a repo-root `progress\.jsonl`/);
    assert.match(taskMd, /Before finishing, write `\.pi\/tasks\/001-audit-widget\/handoff\.md`/);
    assert.match(taskMd, /This task has no upstream task dependencies\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createTaskFolder writes explicit upstream handoff references for dependent tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });

    await createTaskFolder(root, {
      id: "001",
      slug: "discover-context",
      name: "Discover context",
      engine: "codex",
      model: "gpt-5.3-codex",
      agent: "scout",
      depends: [],
      description: "Inspect the auth flow and summarize the relevant files. Acceptance: identify the modules that downstream implementation work must touch.",
    });

    await createTaskFolder(root, {
      id: "002",
      slug: "implement-fix",
      name: "Implement fix",
      engine: "codex",
      model: "gpt-5.3-codex",
      agent: "worker",
      depends: ["001"],
      description: "Use the discovery task output to implement the auth fix. Acceptance: update the relevant files and preserve the upstream constraints.",
    });

    const taskMd = await readFile(join(root, ".pi", "tasks", "002-implement-fix", "task.md"), "utf-8");

    assert.match(taskMd, /Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task\./);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/task\.md` for the original scope/);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/handoff\.md` first if it exists/);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/status\.json` to confirm whether the task completed successfully/);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/progress\.jsonl` only if the handoff is missing or unclear/);
    assert.match(taskMd, /Do not read `\.pi\/tasks\/001-discover-context\/output\.jsonl` unless debugging a failed task/);
    assert.match(taskMd, /Reuse concrete outputs from this dependency instead of rediscovering context\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readStatus normalizes a legacy status.json missing heartbeat and total/source usage fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await writeLegacyStatus(root, "001-legacy-task");

    const state = await readStatus(root, "001", "legacy-task");

    // New heartbeat / staleness fields default rather than throwing.
    assert.equal(state.lastHeartbeatAt, null);
    assert.equal(state.lastOutputAt, null);
    assert.equal(state.lastProgressAt, null);
    assert.equal(state.staleAfterSeconds, 300);

    // Old two-field usage is upgraded to the full normalized envelope.
    assert.equal(state.usage.inputTokens, 120);
    assert.equal(state.usage.outputTokens, 30);
    assert.equal(state.usage.cacheCreationInputTokens, 0);
    assert.equal(state.usage.cacheReadInputTokens, 0);
    assert.equal(state.usage.totalTokens, 150);
    assert.equal(state.usage.source, "");
    assert.equal(state.usage.updatedAt, "");

    // Pre-existing fields are preserved as-is.
    assert.equal(state.status, "done");
    assert.equal(state.engine, "codex");
    assert.equal(state.completedAt, "2026-01-01T00:05:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readStatus round-trips a fresh status.json with heartbeat and normalized usage fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    await createTaskFolder(root, {
      id: "001",
      slug: "fresh-task",
      name: "Fresh task",
      engine: "claude",
      model: "sonnet",
      agent: "worker",
      depends: [],
      description: "Implement the feature and verify with tests. Acceptance: all heartbeat fields persist round-trip.",
    });

    const initial = await readStatus(root, "001", "fresh-task");
    // A brand-new task folder already carries the new fields with defaults.
    assert.equal(initial.staleAfterSeconds, 300);
    assert.equal(initial.lastHeartbeatAt, null);
    assert.equal(initial.usage.totalTokens, 0);

    await writeStatus(root, {
      ...initial,
      status: "running",
      startedAt: "2026-05-30T10:00:00.000Z",
      lastHeartbeatAt: "2026-05-30T10:02:00.000Z",
      lastOutputAt: "2026-05-30T10:02:00.000Z",
      lastProgressAt: "2026-05-30T10:01:30.000Z",
      staleAfterSeconds: 120,
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        cacheCreationInputTokens: 40,
        cacheReadInputTokens: 60,
        totalTokens: 1350,
        source: "claude",
        updatedAt: "2026-05-30T10:02:00.000Z",
      },
    });

    const reloaded = await readStatus(root, "001", "fresh-task");
    assert.equal(reloaded.lastHeartbeatAt, "2026-05-30T10:02:00.000Z");
    assert.equal(reloaded.lastProgressAt, "2026-05-30T10:01:30.000Z");
    assert.equal(reloaded.staleAfterSeconds, 120);
    assert.equal(reloaded.usage.totalTokens, 1350);
    assert.equal(reloaded.usage.source, "claude");
    assert.equal(reloaded.usage.updatedAt, "2026-05-30T10:02:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listTasks reads a mix of legacy and new task folders and skips corrupt status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });

    // Legacy folder (old schema).
    await writeLegacyStatus(root, "001-legacy-task", { id: "001", name: "legacy-task" });

    // New folder (current schema).
    await createTaskFolder(root, {
      id: "002",
      slug: "modern-task",
      name: "Modern task",
      engine: "claude",
      model: "sonnet",
      agent: "worker",
      depends: ["001"],
      description: "Build on the legacy task output. Acceptance: status.json is created with the full schema.",
    });

    // Corrupt folder — must be skipped, not crash the scan.
    const corruptDir = join(root, ".pi", "tasks", "003-corrupt-task");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "status.json"), "{ not valid json", "utf-8");

    const tasks = await listTasks(root);

    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map((t) => t.id), ["001", "002"]);

    const legacy = tasks.find((t) => t.id === "001")!;
    assert.equal(legacy.staleAfterSeconds, 300);
    assert.equal(legacy.usage.totalTokens, 150);
    assert.equal(legacy.usage.source, "");

    const modern = tasks.find((t) => t.id === "002")!;
    assert.equal(modern.staleAfterSeconds, 300);
    assert.equal(modern.usage.totalTokens, 0);
    assert.deepEqual(modern.depends, ["001"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
