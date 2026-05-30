import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAggregateState } from "./state.ts";
import { listTasks, readStatus, type ProgressEntry, type TaskState } from "./task.ts";
import { normalizeUsage } from "./engines/types.ts";

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "001",
    name: "sample-task",
    status: "running",
    engine: "codex",
    model: "gpt-5.3-codex",
    agent: "worker",
    depends: [],
    startedAt: null,
    completedAt: null,
    duration: null,
    retries: 0,
    pid: null,
    error: null,
    lastHeartbeatAt: null,
    lastOutputAt: null,
    lastProgressAt: null,
    staleAfterSeconds: 300,
    usage: normalizeUsage(undefined),
    ...overrides,
  };
}

test("buildAggregateState exposes latest progress timestamp and message", () => {
  const tasks = [makeTask()];
  const progressMap = new Map<string, ProgressEntry[]>([
    [
      "001-sample-task",
      [
        { ts: "2026-04-16T10:00:00.000Z", step: "Start", status: "running" },
        { ts: "2026-04-16T10:01:00.000Z", step: "Finish", status: "done" },
      ],
    ],
  ]);

  const aggregate = buildAggregateState(tasks, progressMap);
  const task = aggregate.tasks[0]!;

  assert.equal(task.latestProgressAt, "2026-04-16T10:01:00.000Z");
  assert.equal(task.latestProgressMessage, "Finish");
  assert.equal(task.lastProgress, "Finish");
  assert.equal(task.lastProgressAt, "2026-04-16T10:01:00.000Z");
});

test("buildAggregateState totals cache-aware usage", () => {
  const tasks = [
    makeTask({
      usage: normalizeUsage({
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 1000,
      }),
    }),
  ];
  const aggregate = buildAggregateState(tasks, new Map());

  assert.equal(aggregate.summary.totalInputTokens, 10);
  assert.equal(aggregate.summary.totalOutputTokens, 5);
  assert.equal(aggregate.summary.totalCacheCreationInputTokens, 100);
  assert.equal(aggregate.summary.totalCacheReadInputTokens, 1000);
  assert.equal(aggregate.summary.totalTokens, 1115);
});

test("buildAggregateState ignores malformed trailing entries", () => {
  const tasks = [makeTask()];
  const progressMap = new Map<string, ProgressEntry[]>([
    [
      "001",
      [
        { ts: "2026-04-16T10:00:00.000Z", step: "Valid", status: "running" },
        { ts: "", step: "", status: "running" } as ProgressEntry,
        { ts: "bad", step: "" } as unknown as ProgressEntry,
      ],
    ],
  ]);

  const aggregate = buildAggregateState(tasks, progressMap);
  const task = aggregate.tasks[0]!;

  assert.equal(task.latestProgressAt, "2026-04-16T10:00:00.000Z");
  assert.equal(task.latestProgressMessage, "Valid");
});

test("buildAggregateState exposes heartbeat and stale fields", () => {
  const tasks = [
    makeTask({
      lastHeartbeatAt: "2026-04-16T10:02:00.000Z",
      lastOutputAt: "2026-04-16T10:02:00.000Z",
      lastProgressAt: "2026-04-16T10:01:30.000Z",
      staleAfterSeconds: 120,
    }),
  ];
  const aggregate = buildAggregateState(tasks, new Map());
  const task = aggregate.tasks[0]!;

  assert.equal(task.lastHeartbeatAt, "2026-04-16T10:02:00.000Z");
  assert.equal(task.lastOutputAt, "2026-04-16T10:02:00.000Z");
  assert.equal(task.staleAfterSeconds, 120);
});

test("buildAggregateState exposes normalized usage fields (totalTokens, source, updatedAt)", () => {
  const tasks = [
    makeTask({
      usage: normalizeUsage(
        { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 10, cacheReadInputTokens: 5 },
        "claude",
        "2026-04-16T10:03:00.000Z",
      ),
    }),
  ];
  const aggregate = buildAggregateState(tasks, new Map());
  const task = aggregate.tasks[0]!;

  assert.equal(task.usage.totalTokens, 85);
  assert.equal(task.usage.source, "claude");
  assert.equal(task.usage.updatedAt, "2026-04-16T10:03:00.000Z");
});

test("normalizeUsage defaults new fields for legacy usage shape", () => {
  // Simulates loading an old status.json that only has {inputTokens, outputTokens}
  const legacy = normalizeUsage({ inputTokens: 10, outputTokens: 5 } as Parameters<typeof normalizeUsage>[0]);

  assert.equal(legacy.inputTokens, 10);
  assert.equal(legacy.outputTokens, 5);
  assert.equal(legacy.cacheCreationInputTokens, 0);
  assert.equal(legacy.cacheReadInputTokens, 0);
  assert.equal(legacy.totalTokens, 15);
  assert.equal(legacy.source, "");
  assert.equal(legacy.updatedAt, "");
});

test("buildAggregateState handles a mix of legacy and modern tasks", () => {
  const tasks = [
    // Legacy task: loaded from a 2-field usage shape, no heartbeat data.
    makeTask({
      id: "001",
      name: "legacy-task",
      status: "done",
      usage: normalizeUsage({ inputTokens: 120, outputTokens: 30 } as Parameters<typeof normalizeUsage>[0]),
      completedAt: "2026-01-01T00:05:00.000Z",
    }),
    // Modern task: full normalized usage and heartbeat fields.
    makeTask({
      id: "002",
      name: "modern-task",
      status: "running",
      lastHeartbeatAt: "2026-05-30T10:02:00.000Z",
      staleAfterSeconds: 120,
      usage: normalizeUsage(
        { inputTokens: 200, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 5 },
        "claude",
        "2026-05-30T10:02:00.000Z",
      ),
    }),
    // Pending task blocked by the legacy (done) task — not blocked, deps satisfied.
    makeTask({ id: "003", name: "pending-task", status: "pending", depends: ["001"] }),
  ];

  const aggregate = buildAggregateState(tasks, new Map());

  assert.equal(aggregate.summary.total, 3);
  assert.equal(aggregate.summary.done, 1);
  assert.equal(aggregate.summary.running, 1);
  assert.equal(aggregate.summary.pending, 1);
  // 150 (legacy) + 265 (modern) = 415
  assert.equal(aggregate.summary.totalTokens, 415);
  // attentionHints always present as an array (empty until orchestrator fills it).
  assert.deepEqual(aggregate.attentionHints, []);

  const legacy = aggregate.tasks.find((t) => t.id === "001")!;
  assert.equal(legacy.lastHeartbeatAt, null);
  assert.equal(legacy.staleAfterSeconds, 300);
  assert.equal(legacy.usage.source, "");

  // Deps satisfied (001 is done) → not blocked.
  const pending = aggregate.tasks.find((t) => t.id === "003")!;
  assert.equal(pending.blockedBy, null);
});

test("buildAggregateState consumes legacy task folders loaded from disk via listTasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-state-"));
  try {
    // Materialize a historical task folder that predates the heartbeat/usage schema.
    const dir = join(root, ".pi", "tasks", "001-historical");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify(
        {
          id: "001",
          name: "historical",
          status: "done",
          engine: "codex",
          model: "gpt-5.3-codex",
          agent: "worker",
          depends: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:10:00.000Z",
          duration: 600000,
          retries: 0,
          pid: null,
          error: null,
          usage: { inputTokens: 500, outputTokens: 100 },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tasks = await listTasks(root);
    assert.equal(tasks.length, 1);

    const aggregate = buildAggregateState(tasks, new Map());
    const task = aggregate.tasks[0]!;

    assert.equal(task.id, "001");
    assert.equal(task.status, "done");
    assert.equal(task.lastHeartbeatAt, null);
    assert.equal(task.staleAfterSeconds, 300);
    assert.equal(task.usage.totalTokens, 600);
    assert.equal(aggregate.summary.totalTokens, 600);
    // Sanity: readStatus path and listTasks path agree.
    const direct = await readStatus(root, "001", "historical");
    assert.equal(direct.usage.totalTokens, 600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
