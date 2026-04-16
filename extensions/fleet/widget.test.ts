import test from "node:test";
import assert from "node:assert/strict";

import type { TaskState } from "./task.ts";
import type { Orchestrator, TaskProgressEvent } from "./orchestrator.ts";
import { FleetWidget } from "./widget.ts";

const COL = {
  prefix: 2,
  taskName: 20,
  sep1: 1,
  agent: 9,
  sep2: 1,
  engineModel: 15,
  sep3: 1,
  bar: 8,
  barTrail: 2,
  status: 9,
  tokensPad: 1,
  tokens: 5,
};

const LINE_WIDTH =
  COL.prefix +
  COL.taskName +
  COL.sep1 +
  COL.agent +
  COL.sep2 +
  COL.engineModel +
  COL.sep3 +
  COL.bar +
  COL.barTrail +
  COL.status +
  COL.tokensPad +
  COL.tokens;

function makeTask(partial: Partial<TaskState> & Pick<TaskState, "id" | "name" | "status">): TaskState {
  return {
    id: partial.id,
    name: partial.name,
    status: partial.status,
    engine: partial.engine ?? "codex",
    model: partial.model ?? "gpt-5.3-codex",
    profile: partial.profile,
    thinking: partial.thinking,
    agent: partial.agent ?? "worker",
    depends: partial.depends ?? [],
    startedAt: partial.startedAt ?? null,
    completedAt: partial.completedAt ?? null,
    duration: partial.duration ?? null,
    retries: partial.retries ?? 0,
    pid: partial.pid ?? null,
    error: partial.error ?? null,
    usage: partial.usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}

class FakeOrchestrator {
  private snapshot: TaskState[];

  constructor(snapshot: TaskState[]) {
    this.snapshot = snapshot;
  }

  getSnapshot(): TaskState[] {
    return this.snapshot.map((task) => ({ ...task, usage: { ...task.usage } }));
  }

  on(): void {}

  off(): void {}
}

/** Fake orchestrator that can actually emit events to registered listeners. */
class FakeOrchestratorWithEvents {
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  private snapshot: TaskState[];

  constructor(snapshot: TaskState[]) {
    this.snapshot = snapshot;
  }

  getSnapshot(): TaskState[] {
    return this.snapshot.map((task) => ({ ...task, usage: { ...task.usage } }));
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  off(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

test("fleet widget renders fixed-width rows with deterministic truncation", () => {
  const snapshot: TaskState[] = [
    makeTask({
      id: "001",
      name: "short",
      status: "done",
      agent: "worker",
      engine: "codex",
      model: "gpt-5.3-codex",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    makeTask({
      id: "002",
      name: "extremely-long-task-name-that-must-truncate",
      status: "running",
      startedAt: new Date().toISOString(),
      agent: "subagent-with-a-very-long-name",
      engine: "engine-with-a-very-long-name",
      model: "model-with-a-very-long-name",
      usage: { inputTokens: 1_500_000, outputTokens: 499_999 },
    }),
  ];

  let lines: string[] = [];
  const widget = new FleetWidget(
    new FakeOrchestrator(snapshot) as unknown as Orchestrator,
    (_id, nextLines) => {
      lines = nextLines;
    },
    () => {},
  );

  widget.attach();

  const rows = lines.slice(0, 2);
  const separator = lines[2];

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.length, LINE_WIDTH);
  assert.equal(rows[1]?.length, LINE_WIDTH);
  assert.equal(separator?.length, LINE_WIDTH);
  assert.equal(separator, "─".repeat(LINE_WIDTH));

  // Columns remain fixed-width and aligned regardless of content length.
  assert.equal(rows[0]?.slice(22, 23), " ");
  assert.equal(rows[0]?.slice(32, 33), " ");
  assert.equal(rows[0]?.slice(48, 49), " ");

  assert.equal(rows[1]?.slice(2, 22).endsWith("..."), true);
  assert.equal(rows[1]?.slice(23, 32).endsWith("..."), true);
  assert.equal(rows[1]?.slice(33, 48).endsWith("..."), true);

  // Token column is always present as fixed width; overflow is truncated.
  assert.equal(rows[0]?.slice(69, 74), "     ");
  assert.equal(rows[1]?.slice(69, 74).endsWith("..."), true);

  widget.detach();
});

test("fleet widget status column renders blocked/pending/running/done/failed/retrying and keeps summary intact", () => {
  const now = new Date().toISOString();
  const snapshot: TaskState[] = [
    makeTask({ id: "001", name: "pending-open", status: "pending" }),
    makeTask({ id: "002", name: "running", status: "running", startedAt: now }),
    makeTask({ id: "003", name: "done", status: "done" }),
    makeTask({ id: "004", name: "failed", status: "failed" }),
    makeTask({ id: "005", name: "retrying", status: "retrying" }),
    makeTask({ id: "006", name: "pending-blocked", status: "pending", depends: ["004"] }),
  ];

  let lines: string[] = [];
  const widget = new FleetWidget(
    new FakeOrchestrator(snapshot) as unknown as Orchestrator,
    (_id, nextLines) => {
      lines = nextLines;
    },
    () => {},
  );

  widget.attach();

  const rows = lines.slice(0, 6);
  const separator = lines[6];
  const summary = lines[7];

  assert.deepEqual(
    rows.map((row) => row.slice(59, 68).trim()),
    ["pending", "running", "done", "failed", "retrying", "blocked"],
  );

  for (const row of rows) {
    assert.equal(row.length, LINE_WIDTH);
  }

  assert.equal(separator, "─".repeat(LINE_WIDTH));
  assert.match(summary ?? "", /^Running: 1  Done: 1  Failed: 1  Blocked: 2  Retrying: 1  │  Total tokens: 0$/);

  widget.detach();
});

test("fleet widget renders progress sub-line beneath task row on task:progress event", () => {
  const now = new Date().toISOString();
  const snapshot: TaskState[] = [
    makeTask({ id: "001", name: "alpha", status: "running", startedAt: now }),
    makeTask({ id: "002", name: "beta", status: "pending" }),
  ];

  let lines: string[] = [];
  const orch = new FakeOrchestratorWithEvents(snapshot);
  const widget = new FleetWidget(
    orch as unknown as Orchestrator,
    (_id, nextLines) => { lines = nextLines; },
    () => {},
  );

  widget.attach();

  // Before any progress event: no sub-lines, structure is [row, row, sep, summary]
  assert.equal(lines.length, 4);
  assert.equal(lines[0]?.length, LINE_WIDTH);
  assert.equal(lines[1]?.length, LINE_WIDTH);
  assert.equal(lines[2], "─".repeat(LINE_WIDTH));

  // Emit a progress event for task 001
  const progressTs = "2026-04-16T09:42:15.000Z";
  const progressEvent: TaskProgressEvent = {
    id: "001",
    name: "alpha",
    latestProgressAt: progressTs,
    latestProgressMessage: "building the widget sub-line feature",
    step: "building the widget sub-line feature",
    status: "running",
  };
  orch.emit("task:progress", progressEvent);

  // After progress: task 001 row + sub-line, task 002 row, sep, summary = 5 lines
  assert.equal(lines.length, 5);

  const taskRow = lines[0]!;
  const progressLine = lines[1]!;
  const task002Row = lines[2]!;
  const separator = lines[3]!;

  // Main row unchanged and still LINE_WIDTH
  assert.equal(taskRow.length, LINE_WIDTH);

  // Progress line is also LINE_WIDTH
  assert.equal(progressLine.length, LINE_WIDTH, `progress line length: ${progressLine.length}`);

  // Progress line starts with prefix-width spaces
  assert.equal(progressLine.slice(0, 2), "  ");

  // Progress line contains the formatted timestamp (HH:MM:SS in local time)
  const d = new Date(progressTs);
  const expectedTs = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  assert.equal(progressLine.slice(2, 10), expectedTs);

  // Progress line contains a space gap after the timestamp
  assert.equal(progressLine[10], " ");

  // Progress line message area starts at position 11
  assert.ok(progressLine.slice(11).startsWith("building the widget sub-line feature"));

  // Task 002 (no progress) is a single row without sub-line
  assert.equal(task002Row.length, LINE_WIDTH);
  assert.equal(separator, "─".repeat(LINE_WIDTH));

  widget.detach();
});

test("fleet widget truncates long progress messages to preserve LINE_WIDTH", () => {
  const now = new Date().toISOString();
  const snapshot: TaskState[] = [
    makeTask({ id: "001", name: "alpha", status: "running", startedAt: now }),
  ];

  let lines: string[] = [];
  const orch = new FakeOrchestratorWithEvents(snapshot);
  const widget = new FleetWidget(
    orch as unknown as Orchestrator,
    (_id, nextLines) => { lines = nextLines; },
    () => {},
  );

  widget.attach();

  const longMessage = "a".repeat(200); // far exceeds available width
  orch.emit("task:progress", {
    id: "001",
    name: "alpha",
    latestProgressAt: now,
    latestProgressMessage: longMessage,
    step: longMessage,
    status: "running",
  } as TaskProgressEvent);

  const progressLine = lines[1]!;
  assert.equal(progressLine.length, LINE_WIDTH, `truncated line must be exactly LINE_WIDTH=${LINE_WIDTH}, got ${progressLine.length}`);
  assert.ok(progressLine.endsWith("..."), "truncated message should end with ellipsis");

  widget.detach();
});

test("fleet widget seeds progress from snapshot RuntimeTaskState and renders sub-line immediately", () => {
  const progressTs = "2026-04-16T08:00:00.000Z";
  // Simulate a RuntimeTaskState snapshot with latestProgressAt already set
  const snapshot = [
    {
      ...makeTask({ id: "001", name: "seeded", status: "running", startedAt: new Date().toISOString() }),
      latestProgressAt: progressTs,
      latestProgressMessage: "progress from snapshot",
    },
  ];

  let lines: string[] = [];
  const widget = new FleetWidget(
    new FakeOrchestrator(snapshot as unknown as TaskState[]) as unknown as Orchestrator,
    (_id, nextLines) => { lines = nextLines; },
    () => {},
  );

  widget.attach();

  // Should have: task row, progress sub-line, separator, summary = 4 lines
  assert.equal(lines.length, 4);

  const progressLine = lines[1]!;
  assert.equal(progressLine.length, LINE_WIDTH);
  assert.equal(progressLine.slice(0, 2), "  ");
  assert.ok(progressLine.includes("progress from snapshot"));

  widget.detach();
});

test("fleet widget collapses done tasks to a single row even when progress exists", () => {
  const progressTs = "2026-04-16T08:00:00.000Z";
  const snapshot = [
    {
      ...makeTask({ id: "001", name: "done-task", status: "done" }),
      latestProgressAt: progressTs,
      latestProgressMessage: "Task completed successfully",
    },
    {
      ...makeTask({ id: "002", name: "running-task", status: "running", startedAt: new Date().toISOString() }),
      latestProgressAt: progressTs,
      latestProgressMessage: "still working",
    },
  ];

  let lines: string[] = [];
  const widget = new FleetWidget(
    new FakeOrchestrator(snapshot as unknown as TaskState[]) as unknown as Orchestrator,
    (_id, nextLines) => { lines = nextLines; },
    () => {},
  );

  widget.attach();

  // done row, running row, running sub-line, separator, summary
  assert.equal(lines.length, 5);
  assert.equal(lines[0]?.length, LINE_WIDTH);
  assert.equal(lines[1]?.length, LINE_WIDTH);
  assert.equal(lines[2]?.length, LINE_WIDTH);
  assert.equal(lines[3], "─".repeat(LINE_WIDTH));
  assert.ok(lines[2]?.includes("still working"));
  assert.ok(!lines[1]?.includes("Task completed successfully"));

  widget.detach();
});

test("fleet widget shows no progress sub-line for tasks with no progress data", () => {
  const snapshot: TaskState[] = [
    makeTask({ id: "001", name: "pending-task", status: "pending" }),
    makeTask({ id: "002", name: "done-task", status: "done" }),
  ];

  let lines: string[] = [];
  const widget = new FleetWidget(
    new FakeOrchestrator(snapshot) as unknown as Orchestrator,
    (_id, nextLines) => { lines = nextLines; },
    () => {},
  );

  widget.attach();

  // [row001, row002, separator, summary] — no sub-lines
  assert.equal(lines.length, 4);
  assert.equal(lines[0]?.length, LINE_WIDTH);
  assert.equal(lines[1]?.length, LINE_WIDTH);
  assert.equal(lines[2], "─".repeat(LINE_WIDTH));

  widget.detach();
});
