import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendFleetEvent, fleetEventsPath } from "./events.ts";
import { writeRunMetadata } from "./run.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fleet-events-"));
}

test("appendFleetEvent writes append-only JSONL with runId and small data", async () => {
  const cwd = await makeTempRoot();
  await writeRunMetadata(cwd, {
    schemaVersion: 1,
    runId: "run-123",
    startedAt: "2026-05-30T10:00:00.000Z",
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
  });

  await appendFleetEvent(cwd, {
    type: "task_progress",
    taskId: "001",
    data: {
      step: "Implemented timeline writer",
      rawTranscript: "x".repeat(800),
      nested: { ok: true },
    },
  });
  await appendFleetEvent(cwd, {
    type: "fleet_completed",
    data: { summary: { done: 1, failed: 0 } },
  });

  const lines = (await readFile(fleetEventsPath(cwd), "utf-8")).trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]!);
  assert.equal(first.runId, "run-123");
  assert.equal(first.type, "task_progress");
  assert.equal(first.taskId, "001");
  assert.equal(first.data.step, "Implemented timeline writer");
  assert.equal(first.data.rawTranscript.length, 500);
  assert.equal(first.data.rawTranscript.endsWith("..."), true);
  assert.equal(first.data.nested.ok, true);

  const second = JSON.parse(lines[1]!);
  assert.equal(second.runId, "run-123");
  assert.equal(second.type, "fleet_completed");
  assert.deepEqual(second.data.summary, { done: 1, failed: 0 });
});

test("appendFleetEvent uses a legacy runId when run metadata is absent", async () => {
  const cwd = await makeTempRoot();
  const event = await appendFleetEvent(cwd, {
    type: "operator_command",
    data: { command: "fleet:validate" },
  });

  assert.equal(event.runId, "legacy");
  const line = (await readFile(fleetEventsPath(cwd), "utf-8")).trim();
  assert.equal(JSON.parse(line).runId, "legacy");
});
