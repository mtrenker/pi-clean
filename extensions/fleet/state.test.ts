import test from "node:test";
import assert from "node:assert/strict";

import { buildAggregateState } from "./state.ts";
import type { ProgressEntry, TaskState } from "./task.ts";

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
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
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
