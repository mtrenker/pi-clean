// Tests for extensions/fleet/attention.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveSyncHints,
  deriveMissingHandoffHints,
  deriveAllAttentionHints,
  type AttentionTaskInput,
} from "./attention.ts";
import { normalizeUsage } from "./engines/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<AttentionTaskInput> = {}): AttentionTaskInput {
  return {
    id: "001",
    name: "sample-task",
    status: "pending",
    retries: 0,
    error: null,
    blockedBy: null,
    lastHeartbeatAt: null,
    staleAfterSeconds: 300,
    usage: normalizeUsage(undefined),
    completedAt: null,
    startedAt: null,
    ...overrides,
  };
}

async function makeTmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fleet-attention-test-"));
}

async function makeTaskFolder(
  cwd: string,
  id: string,
  name: string,
  withHandoff = true,
): Promise<void> {
  const dir = join(cwd, ".pi", "tasks", `${id}-${name}`);
  await mkdir(dir, { recursive: true });
  if (withHandoff) {
    await writeFile(join(dir, "handoff.md"), "# Handoff\nDone.", "utf-8");
  }
}

// ── task_failed ───────────────────────────────────────────────────────────────

test("deriveSyncHints emits task_failed for failed task", () => {
  const tasks = [makeTask({ status: "failed", error: "exit 1" })];
  const hints = deriveSyncHints(tasks);
  const failed = hints.filter((h) => h.category === "task_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.severity, "error");
  assert.ok(failed[0]!.message.includes("001-sample-task"));
  assert.ok(failed[0]!.message.includes("exit 1"));
  assert.ok(typeof failed[0]!.createdAt === "string" && failed[0]!.createdAt.length > 0);
  assert.ok(failed[0]!.dedupeKey.startsWith("task_failed:task:001:"));
});

test("deriveSyncHints does NOT emit task_failed for pending task", () => {
  const tasks = [makeTask({ status: "pending" })];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "task_failed").length, 0);
});

test("deriveSyncHints includes retry count in task_failed message", () => {
  const tasks = [makeTask({ status: "failed", retries: 2, error: "timeout" })];
  const hints = deriveSyncHints(tasks);
  const failed = hints.find((h) => h.category === "task_failed")!;
  assert.ok(failed.message.includes("2 retries"));
});

// ── operator_review_needed ────────────────────────────────────────────────────

test("deriveSyncHints emits operator_review_needed for failed task", () => {
  const tasks = [makeTask({ status: "failed" })];
  const hints = deriveSyncHints(tasks);
  const review = hints.filter((h) => h.category === "operator_review_needed");
  assert.equal(review.length, 1);
  assert.equal(review[0]!.severity, "error");
  assert.ok(review[0]!.dedupeKey.startsWith("operator_review_needed:task:001:"));
});

test("deriveSyncHints does NOT emit operator_review_needed for done task", () => {
  const tasks = [makeTask({ status: "done" })];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "operator_review_needed").length, 0);
});

// ── task_retrying ─────────────────────────────────────────────────────────────

test("deriveSyncHints emits task_retrying for retrying task", () => {
  const tasks = [makeTask({ status: "retrying", retries: 0 })];
  const hints = deriveSyncHints(tasks);
  const retrying = hints.filter((h) => h.category === "task_retrying");
  assert.equal(retrying.length, 1);
  assert.equal(retrying[0]!.severity, "warning");
  assert.ok(retrying[0]!.message.includes("001-sample-task"));
});

test("deriveSyncHints does NOT emit task_retrying for running task", () => {
  const tasks = [makeTask({ status: "running" })];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "task_retrying").length, 0);
});

// ── task_blocked ──────────────────────────────────────────────────────────────

test("deriveSyncHints emits task_blocked when a dependency is failed", () => {
  const tasks = [
    makeTask({ id: "001", name: "first", status: "failed" }),
    makeTask({ id: "002", name: "second", status: "pending", blockedBy: ["001"] }),
  ];
  const hints = deriveSyncHints(tasks);
  const blocked = hints.filter((h) => h.category === "task_blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.taskId, "002");
  assert.ok(blocked[0]!.message.includes("001"));
});

test("deriveSyncHints does NOT emit task_blocked when blocker is still running", () => {
  const tasks = [
    makeTask({ id: "001", name: "first", status: "running" }),
    makeTask({ id: "002", name: "second", status: "pending", blockedBy: ["001"] }),
  ];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "task_blocked").length, 0);
});

test("deriveSyncHints does NOT emit task_blocked when blockedBy is null", () => {
  const tasks = [makeTask({ status: "pending", blockedBy: null })];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "task_blocked").length, 0);
});

// ── stale_running_task ────────────────────────────────────────────────────────

test("deriveSyncHints emits stale_running_task when heartbeat is beyond threshold", () => {
  // lastHeartbeatAt 10 minutes ago, threshold 5 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const tasks = [
    makeTask({ status: "running", lastHeartbeatAt: tenMinutesAgo, staleAfterSeconds: 300 }),
  ];
  const hints = deriveSyncHints(tasks);
  const stale = hints.filter((h) => h.category === "stale_running_task");
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.severity, "warning");
  assert.ok(stale[0]!.message.includes("minutes"));
});

test("deriveSyncHints does NOT emit stale_running_task when within threshold", () => {
  // lastHeartbeatAt 1 minute ago, threshold 5 minutes
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const tasks = [
    makeTask({ status: "running", lastHeartbeatAt: oneMinuteAgo, staleAfterSeconds: 300 }),
  ];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "stale_running_task").length, 0);
});

test("deriveSyncHints does NOT emit stale_running_task when lastHeartbeatAt is null", () => {
  const tasks = [makeTask({ status: "running", lastHeartbeatAt: null })];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "stale_running_task").length, 0);
});

test("deriveSyncHints does NOT emit stale_running_task for done tasks", () => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const tasks = [
    makeTask({ status: "done", lastHeartbeatAt: tenMinutesAgo, staleAfterSeconds: 60 }),
  ];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "stale_running_task").length, 0);
});

// ── usage_unavailable ─────────────────────────────────────────────────────────

test("deriveSyncHints emits usage_unavailable for running task with no usage", () => {
  const tasks = [makeTask({ status: "running", usage: normalizeUsage(undefined) })];
  const hints = deriveSyncHints(tasks);
  const ua = hints.filter((h) => h.category === "usage_unavailable");
  assert.equal(ua.length, 1);
  assert.equal(ua[0]!.severity, "info");
});

test("deriveSyncHints does NOT emit usage_unavailable when usage has tokens", () => {
  const tasks = [
    makeTask({
      status: "running",
      usage: normalizeUsage({ inputTokens: 100, outputTokens: 50 }, "claude", new Date().toISOString()),
    }),
  ];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "usage_unavailable").length, 0);
});

test("deriveSyncHints does NOT emit usage_unavailable for pending task", () => {
  const tasks = [makeTask({ status: "pending", usage: normalizeUsage(undefined) })];
  const hints = deriveSyncHints(tasks);
  assert.equal(hints.filter((h) => h.category === "usage_unavailable").length, 0);
});

// ── plan_validation_failed ────────────────────────────────────────────────────

test("deriveSyncHints emits plan_validation_failed when flag is set", () => {
  const hints = deriveSyncHints([], { planValidationFailed: true });
  const pvf = hints.filter((h) => h.category === "plan_validation_failed");
  assert.equal(pvf.length, 1);
  assert.equal(pvf[0]!.severity, "error");
  assert.equal(pvf[0]!.taskId, undefined);
  assert.ok(pvf[0]!.dedupeKey.startsWith("plan_validation_failed:fleet:"));
});

test("deriveSyncHints does NOT emit plan_validation_failed by default", () => {
  const hints = deriveSyncHints([]);
  assert.equal(hints.filter((h) => h.category === "plan_validation_failed").length, 0);
});

// ── missing_handoff ───────────────────────────────────────────────────────────

test("deriveMissingHandoffHints emits missing_handoff when handoff.md is absent", async () => {
  const cwd = await makeTmpCwd();
  await makeTaskFolder(cwd, "001", "no-handoff-task", false);

  const tasks = [makeTask({ id: "001", name: "no-handoff-task", status: "done", completedAt: new Date().toISOString() })];
  const hints = await deriveMissingHandoffHints(cwd, tasks);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.category, "missing_handoff");
  assert.equal(hints[0]!.severity, "warning");
  assert.ok(hints[0]!.message.includes("001-no-handoff-task"));
});

test("deriveMissingHandoffHints does NOT emit missing_handoff when handoff.md exists", async () => {
  const cwd = await makeTmpCwd();
  await makeTaskFolder(cwd, "001", "has-handoff-task", true);

  const tasks = [makeTask({ id: "001", name: "has-handoff-task", status: "done" })];
  const hints = await deriveMissingHandoffHints(cwd, tasks);
  assert.equal(hints.length, 0);
});

test("deriveMissingHandoffHints skips failed tasks (no handoff expected)", async () => {
  const cwd = await makeTmpCwd();
  // No folder created — if we checked failed tasks, this would fail

  const tasks = [makeTask({ status: "failed" })];
  const hints = await deriveMissingHandoffHints(cwd, tasks);
  assert.equal(hints.length, 0);
});

// ── dedupeKey stability ───────────────────────────────────────────────────────

test("dedupeKey is stable across repeated calls with the same inputs", () => {
  const tasks = [makeTask({ status: "failed" })];
  const hints1 = deriveSyncHints(tasks, { runId: "run-abc", now: "2026-01-01T00:00:00.000Z" });
  const hints2 = deriveSyncHints(tasks, { runId: "run-abc", now: "2026-01-01T01:00:00.000Z" });

  const key1 = hints1.find((h) => h.category === "task_failed")!.dedupeKey;
  const key2 = hints2.find((h) => h.category === "task_failed")!.dedupeKey;
  assert.equal(key1, key2);
});

test("dedupeKey differs across runs", () => {
  const tasks = [makeTask({ status: "failed" })];
  const hints1 = deriveSyncHints(tasks, { runId: "run-aaa" });
  const hints2 = deriveSyncHints(tasks, { runId: "run-bbb" });

  const key1 = hints1.find((h) => h.category === "task_failed")!.dedupeKey;
  const key2 = hints2.find((h) => h.category === "task_failed")!.dedupeKey;
  assert.notEqual(key1, key2);
});

// ── deriveAllAttentionHints (combined) ────────────────────────────────────────

test("deriveAllAttentionHints combines sync and async hints", async () => {
  const cwd = await makeTmpCwd();
  await makeTaskFolder(cwd, "001", "no-handoff", false);

  const tasks = [
    makeTask({ id: "001", name: "no-handoff", status: "done", completedAt: new Date().toISOString() }),
  ];
  const hints = await deriveAllAttentionHints(cwd, tasks, {});
  // usage_unavailable for done task with no usage
  assert.ok(hints.some((h) => h.category === "usage_unavailable"));
  // missing_handoff from async check
  assert.ok(hints.some((h) => h.category === "missing_handoff"));
});

// ── Required fields present ───────────────────────────────────────────────────

test("all hints have required fields: category, severity, message, createdAt, dedupeKey", () => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const tasks = [
    makeTask({ id: "001", name: "failed-task", status: "failed", error: "crash" }),
    makeTask({ id: "002", name: "retrying-task", status: "retrying" }),
    makeTask({
      id: "003",
      name: "stale-task",
      status: "running",
      lastHeartbeatAt: tenMinutesAgo,
      staleAfterSeconds: 60,
    }),
  ];
  const hints = deriveSyncHints(tasks, { runId: "test-run", planValidationFailed: true });

  for (const hint of hints) {
    assert.ok(typeof hint.category === "string" && hint.category.length > 0, `category missing on ${hint.category}`);
    assert.ok(["info", "warning", "error"].includes(hint.severity), `invalid severity: ${hint.severity}`);
    assert.ok(typeof hint.message === "string" && hint.message.length > 0, `message missing on ${hint.category}`);
    assert.ok(typeof hint.createdAt === "string" && hint.createdAt.length > 0, `createdAt missing on ${hint.category}`);
    assert.ok(typeof hint.dedupeKey === "string" && hint.dedupeKey.length > 0, `dedupeKey missing on ${hint.category}`);
  }
});
