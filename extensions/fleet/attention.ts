// Fleet extension — human-attention hint derivation
//
// Derives high-confidence attention items from fleet and task state so that
// Flightdeck (or any consumer) can surface actionable signals without owning
// fleet's internal lifecycle.  Every hint carries a stable `dedupeKey` that
// callers can use for deduplication across polls.

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { TaskStatus } from "./task.js";
import type { Usage } from "./engines/types.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type AttentionCategory =
  | "task_failed"
  | "task_retrying"
  | "task_blocked"
  | "missing_handoff"
  | "stale_running_task"
  | "usage_unavailable"
  | "plan_validation_failed"
  | "operator_review_needed";

export type AttentionSeverity = "info" | "warning" | "error";

export interface AttentionHint {
  /** Discriminator for Flightdeck rule matching and UI rendering. */
  category: AttentionCategory;
  severity: AttentionSeverity;
  /** Human-readable description of the issue. */
  message: string;
  /** ISO timestamp when the condition was first observed or the hint was derived. */
  createdAt: string;
  /** Task identifier — present for task-scoped hints; absent for fleet-level hints. */
  taskId?: string;
  /** Human-readable task slug — redundant with taskId but useful for display. */
  taskName?: string;
  /** Run identifier from run.json — scopes Flightdeck deduplication to a single run. */
  runId?: string;
  /**
   * Stable opaque key for Flightdeck deduplication.
   * Format: `<category>:<task|fleet>:<taskId|"fleet">:<runId|"legacy">`
   * The key is stable across polls for the same issue in the same run.
   */
  dedupeKey: string;
}

/**
 * Minimal view of an aggregate task entry needed for attention derivation.
 * Matches the shape of `AggregateState["tasks"][number]` without creating a
 * circular import with state.ts.
 */
export interface AttentionTaskInput {
  id: string;
  name: string;
  status: TaskStatus;
  retries: number;
  error: string | null;
  blockedBy: string[] | null;
  lastHeartbeatAt: string | null;
  staleAfterSeconds: number;
  usage: Usage;
  completedAt: string | null;
  startedAt: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function makeDedupeKey(
  category: AttentionCategory,
  taskId: string | undefined,
  runId: string | undefined,
): string {
  const scope = taskId !== undefined ? `task:${taskId}` : "fleet";
  return `${category}:${scope}:${runId ?? "legacy"}`;
}

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function elapsedMinutes(from: string): number {
  return Math.round((Date.now() - new Date(from).getTime()) / 60_000);
}

// ── Synchronous hint derivation ───────────────────────────────────────────────

/**
 * Derives all attention hints that can be computed without I/O.
 * Covers: task_failed, operator_review_needed, task_retrying, task_blocked,
 * stale_running_task, usage_unavailable, plan_validation_failed.
 *
 * `missing_handoff` requires a disk check — use `deriveMissingHandoffHints`
 * or the combined `deriveAllAttentionHints` helper.
 */
export function deriveSyncHints(
  tasks: AttentionTaskInput[],
  opts: {
    runId?: string;
    planValidationFailed?: boolean;
    now?: string;
  } = {},
): AttentionHint[] {
  const now = opts.now ?? new Date().toISOString();
  const { runId, planValidationFailed = false } = opts;
  const hints: AttentionHint[] = [];

  // Quick lookup: id → status (needed to check if blockers are failed)
  const statusById = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));

  for (const task of tasks) {
    const { id, name, status, retries, error, blockedBy, lastHeartbeatAt, staleAfterSeconds, usage, completedAt } = task;

    // ── task_failed ───────────────────────────────────────────────────────────
    // Permanent failure — the orchestrator only sets status="failed" once all
    // retries are exhausted.
    if (status === "failed") {
      hints.push({
        category: "task_failed",
        severity: "error",
        message:
          retries > 0
            ? `Task ${id}-${name} failed permanently after ${retries} ${pluralize(retries, "retry", "retries")}: ${error ?? "non-zero exit code"}`
            : `Task ${id}-${name} failed: ${error ?? "non-zero exit code"}`,
        createdAt: completedAt ?? now,
        taskId: id,
        taskName: name,
        runId,
        dedupeKey: makeDedupeKey("task_failed", id, runId),
      });
    }

    // ── operator_review_needed ────────────────────────────────────────────────
    // Emitted when a task has permanently failed and needs human intervention.
    // Distinct from task_failed so Flightdeck can route to a separate queue.
    if (status === "failed") {
      hints.push({
        category: "operator_review_needed",
        severity: "error",
        message:
          retries > 0
            ? `Task ${id}-${name} requires manual intervention — permanently failed after ${retries} ${pluralize(retries, "retry", "retries")}`
            : `Task ${id}-${name} requires manual intervention — failed on first attempt`,
        createdAt: completedAt ?? now,
        taskId: id,
        taskName: name,
        runId,
        dedupeKey: makeDedupeKey("operator_review_needed", id, runId),
      });
    }

    // ── task_retrying ─────────────────────────────────────────────────────────
    // Auto-recovery is in progress; a retry run has been scheduled.
    if (status === "retrying") {
      hints.push({
        category: "task_retrying",
        severity: "warning",
        message: `Task ${id}-${name} failed and is being retried automatically (attempt ${retries + 1})`,
        createdAt: now,
        taskId: id,
        taskName: name,
        runId,
        dedupeKey: makeDedupeKey("task_retrying", id, runId),
      });
    }

    // ── task_blocked ──────────────────────────────────────────────────────────
    // A pending task cannot proceed because one or more of its dependencies
    // permanently failed.  Tasks blocked only by incomplete (non-failed) deps
    // are NOT flagged — they are just waiting for normal execution.
    if (status === "pending" && blockedBy && blockedBy.length > 0) {
      const failedBlockers = blockedBy.filter((dep) => statusById.get(dep) === "failed");
      if (failedBlockers.length > 0) {
        hints.push({
          category: "task_blocked",
          severity: "warning",
          message: `Task ${id}-${name} is permanently blocked by failed ${pluralize(failedBlockers.length, "dependency", "dependencies")}: ${failedBlockers.join(", ")}`,
          createdAt: now,
          taskId: id,
          taskName: name,
          runId,
          dedupeKey: makeDedupeKey("task_blocked", id, runId),
        });
      }
    }

    // ── stale_running_task ────────────────────────────────────────────────────
    // A running task has been silent (no heartbeat) for longer than its
    // configured threshold.  Only fired when we have a known lastHeartbeatAt
    // so we don't false-positive on tasks that literally just started.
    if (status === "running" && lastHeartbeatAt !== null) {
      const silentMs = Date.now() - new Date(lastHeartbeatAt).getTime();
      if (silentMs > staleAfterSeconds * 1_000) {
        const mins = elapsedMinutes(lastHeartbeatAt);
        hints.push({
          category: "stale_running_task",
          severity: "warning",
          message: `Task ${id}-${name} has been silent for ${mins} ${pluralize(mins, "minute", "minutes")} (threshold: ${staleAfterSeconds}s)`,
          createdAt: now,
          taskId: id,
          taskName: name,
          runId,
          dedupeKey: makeDedupeKey("stale_running_task", id, runId),
        });
      }
    }

    // ── usage_unavailable ─────────────────────────────────────────────────────
    // A task that has started (or completed) but has no usage data.
    // This is informational — it may indicate a silent engine or a bug in the
    // usage parser, but is not necessarily an error.
    if (
      (status === "running" || status === "done" || status === "failed" || status === "retrying") &&
      usage.source === "" &&
      usage.totalTokens === 0
    ) {
      hints.push({
        category: "usage_unavailable",
        severity: "info",
        message: `Task ${id}-${name} has no token usage data (engine may not report usage)`,
        createdAt: now,
        taskId: id,
        taskName: name,
        runId,
        dedupeKey: makeDedupeKey("usage_unavailable", id, runId),
      });
    }
  }

  // ── plan_validation_failed ────────────────────────────────────────────────
  // Fleet-level: the operator attempted to start a fleet but the plan failed
  // structural validation.  This is set by the caller (orchestrator or
  // index.ts) rather than derived from task state.
  if (planValidationFailed) {
    hints.push({
      category: "plan_validation_failed",
      severity: "error",
      message: "Fleet plan failed validation — review the plan file and task dependencies before continuing",
      createdAt: now,
      runId,
      dedupeKey: makeDedupeKey("plan_validation_failed", undefined, runId),
    });
  }

  return hints;
}

// ── Async hint derivation ─────────────────────────────────────────────────────

/**
 * Checks disk for missing handoff.md files for completed tasks.
 * Only done tasks are checked — failed / retrying tasks are expected to lack handoffs.
 */
export async function deriveMissingHandoffHints(
  cwd: string,
  tasks: AttentionTaskInput[],
  opts: {
    runId?: string;
    now?: string;
  } = {},
): Promise<AttentionHint[]> {
  const now = opts.now ?? new Date().toISOString();
  const { runId } = opts;
  const hints: AttentionHint[] = [];

  const doneTasks = tasks.filter((t) => t.status === "done");

  await Promise.all(
    doneTasks.map(async (task) => {
      const handoffPath = join(cwd, ".pi", "tasks", `${task.id}-${task.name}`, "handoff.md");
      let exists = false;
      try {
        await access(handoffPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        hints.push({
          category: "missing_handoff",
          severity: "warning",
          message: `Task ${task.id}-${task.name} completed successfully but has no handoff.md — downstream tasks may lack context`,
          createdAt: task.completedAt ?? now,
          taskId: task.id,
          taskName: task.name,
          runId,
          dedupeKey: makeDedupeKey("missing_handoff", task.id, runId),
        });
      }
    }),
  );

  return hints;
}

// ── Combined derivation ───────────────────────────────────────────────────────

/**
 * Derive all attention hints — synchronous + async (missing_handoff).
 * This is the primary entry point for orchestrator and state consumers.
 */
export async function deriveAllAttentionHints(
  cwd: string,
  tasks: AttentionTaskInput[],
  opts: {
    runId?: string;
    planValidationFailed?: boolean;
    now?: string;
  } = {},
): Promise<AttentionHint[]> {
  const now = opts.now ?? new Date().toISOString();

  const [syncHints, handoffHints] = await Promise.all([
    Promise.resolve(deriveSyncHints(tasks, { ...opts, now })),
    deriveMissingHandoffHints(cwd, tasks, { runId: opts.runId, now }),
  ]);

  return [...syncHints, ...handoffHints];
}
