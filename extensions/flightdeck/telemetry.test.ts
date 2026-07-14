import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTaskLifecycleReporter,
  readFlightdeckWorkContext,
  subscribeTaskLifecycle,
} from "./lifecycle.js";
import { FlightdeckTelemetryAdapter } from "./telemetry.js";

async function readEvents(path: string): Promise<Array<Record<string, any>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function reporter(source: "delegate" | "fleet", statusClock: () => Date, lifecycleId = `${source}:run-1:task-1`) {
  return createTaskLifecycleReporter({
    lifecycleId,
    agentId: `${source}:agent-1`,
    runId: "run-1",
    taskId: "task-1",
    provider: source === "delegate" ? "claude" : "codex",
    model: source === "delegate" ? "claude-sonnet-5" : "gpt-5.5",
    source,
    heartbeatIntervalMs: 0,
    now: statusClock,
    context: {
      workId: "github:mtrenker/pi-clean:issue:4",
      projectSlug: "pi-clean",
      repository: "mtrenker/pi-clean",
      worktreePath: "/worktrees/4",
      role: "author",
      workspaceLabel: "pi-clean · #4 · telemetry",
    },
  });
}

test("delegate harness success emits one correlated, replay-safe lifecycle and cumulative usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-flightdeck-"));
  const sink = join(root, "telemetry", "events.jsonl");
  let now = new Date("2026-07-14T10:00:00.000Z");
  const adapter = new FlightdeckTelemetryAdapter({ sinkPath: sink, machineId: "test-machine", now: () => now });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));
  try {
    const task = reporter("delegate", () => now);
    await task.start();
    now = new Date("2026-07-14T10:00:05.000Z");
    task.heartbeat();
    task.usage({ inputTokens: 120, outputTokens: 45, cacheReadTokens: 20, cacheWriteTokens: 5 });
    task.usage({ inputTokens: 120, outputTokens: 45, cacheReadTokens: 20, cacheWriteTokens: 5 });
    now = new Date("2026-07-14T10:00:10.000Z");
    await task.terminal("completed", { exitCode: 0 });

    const events = await readEvents(sink);
    assert.deepEqual(events.map((event) => event.event), [
      "agent.run.started",
      "agent.task.started",
      "agent.run.heartbeat",
      "agent.task.running",
      "agent.tokens.used",
      "agent.run.completed",
      "agent.task.completed",
    ]);
    assert.equal(events.filter((event) => event.event === "agent.tokens.used").length, 1);
    assert.equal(events.find((event) => event.event === "agent.tokens.used")?.attributes.usageKind, "cumulative");
    assert.equal(events.find((event) => event.event === "agent.tokens.used")?.attributes.totalTokens, 190);
    assert.ok(events.every((event) => event.attributes.runId === "run-1" && event.attributes.taskId === "task-1"));
    assert.ok(events.every((event) => typeof event.attributes.eventId === "string"));
    assert.deepEqual(adapter.getStatus().counts, { active: 0, completed: 1, failed: 0, aborted: 0, stale: 0 });
  } finally {
    unsubscribe();
    await rm(root, { recursive: true, force: true });
  }
});

test("failure and abort remain truthful for direct and Fleet task attempts", async () => {
  let now = new Date("2026-07-14T11:00:00.000Z");
  const lines: string[] = [];
  const adapter = new FlightdeckTelemetryAdapter({
    sinkPath: "/virtual/events.jsonl",
    now: () => now,
    append: async (_path, line) => { lines.push(line); },
  });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));
  try {
    const failed = reporter("delegate", () => now, "delegate:failed");
    await failed.start();
    await failed.terminal("failed", { exitCode: 2 });

    const aborted = reporter("fleet", () => now, "fleet:run-1:task-1:attempt-0");
    await aborted.start();
    await aborted.terminal("aborted");

    assert.deepEqual(adapter.getStatus().counts, { active: 0, completed: 0, failed: 1, aborted: 1, stale: 0 });
    const events = lines.map((line) => JSON.parse(line));
    const abortEvents = events.filter((event) => event.attributes.lifecycleId.includes("attempt-0") && event.event.endsWith("failed"));
    assert.equal(abortEvents.length, 2);
    assert.ok(abortEvents.every((event) => event.level === "warn" && event.attributes.status === "aborted"));
    assert.ok(events.some((event) => event.attributes.source === "fleet" && event.attributes.runId === "run-1"));
  } finally {
    unsubscribe();
  }
});

test("stable event identities make replay and repeated progress updates idempotent", async () => {
  const lines: string[] = [];
  const now = () => new Date("2026-07-14T12:00:00.000Z");
  const adapter = new FlightdeckTelemetryAdapter({
    sinkPath: "/virtual/events.jsonl",
    append: async (_path, line) => { lines.push(line); },
  });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));
  try {
    for (let replay = 0; replay < 2; replay++) {
      const task = reporter("fleet", now, "fleet:stable:attempt-0");
      await task.start();
      task.heartbeat();
      task.usage({ inputTokens: 10, outputTokens: 2 });
      await task.terminal("completed");
    }
    const ids = lines.map((line) => JSON.parse(line).attributes.eventId);
    const midpoint = ids.length / 2;
    assert.deepEqual(ids.slice(0, midpoint), ids.slice(midpoint));
  } finally {
    unsubscribe();
  }
});

test("telemetry excludes prompts, output, tools, and broad environment data", async () => {
  const lines: string[] = [];
  const adapter = new FlightdeckTelemetryAdapter({
    sinkPath: "/virtual/events.jsonl",
    append: async (_path, line) => { lines.push(line); },
  });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));
  try {
    const task = reporter("delegate", () => new Date("2026-07-14T13:00:00.000Z"));
    await task.start();
    task.heartbeat();
    await task.terminal("failed", { exitCode: 1 });
    const serialized = lines.join("");
    for (const forbidden of ["prompt", "stdout", "stderr", "raw_output", "tool_result", "file_content", "api_key"]) {
      assert.doesNotMatch(serialized.toLowerCase(), new RegExp(forbidden));
    }
  } finally {
    unsubscribe();
  }
});

test("missing and unwritable sinks are non-fatal and expose health", async () => {
  const disabled = new FlightdeckTelemetryAdapter();
  const task = reporter("delegate", () => new Date("2026-07-14T14:00:00.000Z"), "disabled");
  let unsubscribe = subscribeTaskLifecycle((event) => disabled.handle(event));
  await task.start();
  await task.terminal("completed");
  unsubscribe();
  assert.equal(disabled.getStatus().sink, "disabled");
  assert.equal(disabled.getStatus().counts.completed, 1);

  const broken = new FlightdeckTelemetryAdapter({
    sinkPath: "/unwritable/events.jsonl",
    append: async () => { throw Object.assign(new Error("sensitive path detail"), { code: "EACCES" }); },
  });
  unsubscribe = subscribeTaskLifecycle((event) => broken.handle(event));
  const failedWriteTask = reporter("fleet", () => new Date("2026-07-14T14:05:00.000Z"), "broken");
  await failedWriteTask.start();
  await failedWriteTask.terminal("completed");
  unsubscribe();
  assert.equal(broken.getStatus().sink, "error");
  assert.equal(broken.getStatus().lastError, "telemetry append failed (EACCES)");
});

test("active counts expose stale tasks and launcher context uses only explicit fields", async () => {
  let now = new Date("2026-07-14T15:00:00.000Z");
  const adapter = new FlightdeckTelemetryAdapter({ now: () => now });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));
  try {
    const task = createTaskLifecycleReporter({
      lifecycleId: "stale",
      agentId: "agent",
      runId: "run",
      taskId: "task",
      provider: "claude",
      source: "delegate",
      staleAfterSeconds: 30,
      heartbeatIntervalMs: 0,
      now: () => now,
    });
    await task.start();
    now = new Date("2026-07-14T15:00:31.000Z");
    assert.deepEqual(adapter.getStatus().counts, { active: 1, completed: 0, failed: 0, aborted: 0, stale: 1 });

    const context = readFlightdeckWorkContext("/cwd", {
      FLIGHTDECK_WORK_ID: "github:owner/repo:issue:4",
      FLIGHTDECK_ROLE: "reviewer",
      FLIGHTDECK_REVIEWER: "claude",
      FLIGHTDECK_WORKSPACE_LABEL: "repo · PR #4 · review/claude",
      SECRET_VALUE: "must-not-be-read",
    });
    assert.deepEqual(context, {
      workId: "github:owner/repo:issue:4",
      worktreePath: "/cwd",
      role: "reviewer",
      reviewer: "claude",
      workspaceLabel: "repo · PR #4 · review/claude",
    });
    await task.terminal("aborted");
  } finally {
    unsubscribe();
  }
});
