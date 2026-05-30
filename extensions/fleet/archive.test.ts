import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveTaskFolders,
  writeArchiveSummary,
  writePlanSummary,
  type ArchiveSummary,
} from "./archive.ts";
import { normalizeUsage } from "./engines/types.ts";
import { createTaskFolder, readStatus, writeStatus } from "./task.ts";
import { writeRunMetadata } from "./run.ts";

async function writePlan(root: string): Promise<void> {
  await writeFile(
    join(root, "PLAN.md"),
    `# Plan: Flightdeck History

## Overview

Capture enough archive metadata for historical fleet views.

## Tasks

### Task 001: Sample task

- **engine**: codex
- **profile**: balanced
- **model**: gpt-5.5
- **thinking**: medium
- **agent**: worker
- **depends**: none
- **description**: Update \`extensions/fleet/archive.ts\` with run metadata and verify archive behavior with tests. Acceptance requires archived history metadata to be present.
`,
    "utf-8",
  );
}

test("writeArchiveSummary includes run, usage, attention, and source artifact metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-archive-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    await writePlan(root);
    await writePlanSummary(root);
    await createTaskFolder(root, {
      id: "001",
      slug: "sample-task",
      name: "Sample task",
      engine: "codex",
      model: "gpt-5.5",
      profile: "balanced",
      thinking: "medium",
      agent: "worker",
      depends: [],
      description: "Update `extensions/fleet/archive.ts` with run metadata and verify archive behavior with tests. Acceptance requires archived history metadata to be present.",
    });

    const task = await readStatus(root, "001", "sample-task");
    await writeStatus(root, {
      ...task,
      status: "done",
      startedAt: "2026-05-30T10:00:00.000Z",
      completedAt: "2026-05-30T10:05:00.000Z",
      duration: 300000,
      usage: normalizeUsage(
        {
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationInputTokens: 30,
          cacheReadInputTokens: 40,
        },
        "codex",
        "2026-05-30T10:04:00.000Z",
      ),
    });

    await writeRunMetadata(root, {
      schemaVersion: 1,
      runId: "run-123",
      startedAt: "2026-05-30T09:59:00.000Z",
      status: "done",
      cwd: root,
      planPath: "PLAN.md",
      configSources: [{ label: "built-in", present: false }],
      concurrency: 2,
      git: {
        repoRoot: root,
        remote: "git@example.com:repo/project.git",
        branch: "main",
        worktreePath: root,
        headSha: "abc123",
        dirtyAtStart: false,
      },
    });
    await writeFile(join(root, ".pi", "tasks", "events.jsonl"), "{\"type\":\"fleet_started\"}\n", "utf-8");
    await writeFile(
      join(root, ".pi", "tasks", "state.json"),
      JSON.stringify(
        {
          attentionHints: [
            {
              category: "missing_handoff",
              severity: "warning",
              message: "Task is done but has no handoff.",
              createdAt: "2026-05-30T10:06:00.000Z",
              taskId: "001",
              taskName: "sample-task",
              runId: "run-123",
              dedupeKey: "missing_handoff:task:001:run-123",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const summary = await writeArchiveSummary(root);

    assert.equal(summary.run.runId, "run-123");
    assert.equal(summary.run.cwd, root);
    assert.equal(summary.run.repoRoot, root);
    assert.equal(summary.run.branch, "main");
    assert.equal(summary.run.planPath, "PLAN.md");
    assert.equal(summary.run.startedAt, "2026-05-30T09:59:00.000Z");
    assert.equal(summary.run.completedAt, "2026-05-30T10:05:00.000Z");
    assert.equal(summary.run.finalStatus, "done");
    assert.equal(summary.totalUsage.totalTokens, 100);
    assert.equal(summary.attention.total, 1);
    assert.equal(summary.attention.bySeverity.warning, 1);
    assert.equal(summary.attention.byCategory.missing_handoff, 1);
    assert.deepEqual(summary.artifacts.run, {
      sourcePath: ".pi/tasks/run.json",
      archivePath: null,
      copied: false,
    });
    assert.equal(summary.artifacts.events.sourcePath, ".pi/tasks/events.jsonl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiveTaskFolders copies run and event files and records their archive paths in index entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-archive-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    await writePlan(root);
    await writePlanSummary(root);
    await createTaskFolder(root, {
      id: "001",
      slug: "sample-task",
      name: "Sample task",
      engine: "codex",
      model: "gpt-5.5",
      agent: "worker",
      depends: [],
      description: "Update `extensions/fleet/archive.ts` with run metadata and verify archive behavior with tests. Acceptance requires archived history metadata to be present.",
    });
    await writeRunMetadata(root, {
      schemaVersion: 1,
      runId: "run-archive",
      startedAt: "2026-05-30T11:00:00.000Z",
      status: "failed",
      cwd: root,
      planPath: "PLAN.md",
      configSources: [{ label: "built-in", present: false }],
      concurrency: 1,
      git: {
        repoRoot: root,
        remote: null,
        branch: "history",
        worktreePath: root,
        headSha: "def456",
        dirtyAtStart: true,
      },
    });
    await writeFile(join(root, ".pi", "tasks", "events.jsonl"), "{\"type\":\"fleet_completed\"}\n", "utf-8");

    const entry = await archiveTaskFolders(root, ["001-sample-task"], "manual");
    const archivedSummary = JSON.parse(
      await readFile(join(root, entry.archivePath, "archive-summary.json"), "utf-8"),
    ) as ArchiveSummary;
    const index = JSON.parse(await readFile(join(root, ".pi", "archive", "index.json"), "utf-8")) as {
      archives: Array<typeof entry>;
    };

    assert.equal(entry.run.runId, "run-archive");
    assert.equal(entry.run.branch, "history");
    assert.equal(entry.run.finalStatus, "failed");
    assert.equal(entry.artifacts.run.copied, true);
    assert.equal(entry.artifacts.run.archivePath, `${entry.archivePath}/run.json`);
    assert.equal(entry.artifacts.events.copied, true);
    assert.equal(entry.artifacts.events.archivePath, `${entry.archivePath}/events.jsonl`);
    assert.equal(archivedSummary.artifacts.run.archivePath, entry.artifacts.run.archivePath);
    assert.equal(archivedSummary.artifacts.events.archivePath, entry.artifacts.events.archivePath);
    assert.equal(index.archives[0]?.artifacts.run.archivePath, entry.artifacts.run.archivePath);
    await readFile(join(root, entry.archivePath, "run.json"), "utf-8");
    await readFile(join(root, entry.archivePath, "events.jsonl"), "utf-8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeArchiveSummary remains compatible with legacy task folders without run metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-archive-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    await createTaskFolder(root, {
      id: "001",
      slug: "legacy-task",
      name: "Legacy task",
      engine: "codex",
      model: "gpt-5.5",
      agent: "worker",
      depends: [],
      description: "Update `extensions/fleet/archive.ts` with legacy archive compatibility. Acceptance requires missing run metadata to be handled.",
    });

    const summary = await writeArchiveSummary(root);

    assert.equal(summary.run.runId, null);
    assert.equal(summary.run.finalStatus, "legacy");
    assert.equal(summary.run.cwd, null);
    assert.equal(summary.totalUsage.totalTokens, 0);
    assert.equal(summary.attention.total, 0);
    assert.equal(summary.artifacts.run.copied, false);
    assert.equal(summary.artifacts.events.copied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
