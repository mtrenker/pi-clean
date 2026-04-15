// Fleet extension — aggregate state management

import { readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import type { TaskStatus, TaskState, ProgressEntry } from "./task.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AggregateState {
  updatedAt: string;   // ISO timestamp
  tasks: Array<{
    id: string;
    name: string;
    agent: string;
    engine: string;
    model: string;
    status: TaskStatus;
    startedAt: string | null;
    completedAt: string | null;
    lastProgress: string | null;   // last progress entry step text
    blockedBy: string[] | null;    // task IDs blocking this one (if status=pending and deps not done)
    usage: { inputTokens: number; outputTokens: number };
  }>;
  summary: {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
    retrying: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function statePath(cwd: string): string {
  return join(cwd, ".pi", "tasks", "state.json");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the aggregate state from current task states and progress entries.
 * `blockedBy` is set when status is `pending` and some dependencies are not `done`.
 */
export function buildAggregateState(
  tasks: TaskState[],
  progressMap: Map<string, ProgressEntry[]>,
): AggregateState {
  // Build a quick lookup: id → status
  const statusById = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));

  const summary = {
    total: tasks.length,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    retrying: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  const aggregateTasks: AggregateState["tasks"] = tasks.map((task) => {
    // Count status totals
    summary[task.status] = (summary[task.status] ?? 0) + 1;
    summary.totalInputTokens += task.usage.inputTokens;
    summary.totalOutputTokens += task.usage.outputTokens;

    // Determine blockedBy
    let blockedBy: string[] | null = null;
    if (task.status === "pending" && task.depends.length > 0) {
      const blocking = task.depends.filter((depId) => statusById.get(depId) !== "done");
      blockedBy = blocking.length > 0 ? blocking : null;
    }

    // Last progress entry
    const progressKey = `${task.id}-${task.name}`;
    const entries = progressMap.get(progressKey) ?? progressMap.get(task.id) ?? [];
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastProgress = lastEntry ? lastEntry.step : null;

    return {
      id: task.id,
      name: task.name,
      agent: task.agent,
      engine: task.engine,
      model: task.model,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      lastProgress,
      blockedBy,
      usage: { ...task.usage },
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    tasks: aggregateTasks,
    summary,
  };
}

/**
 * Writes `.pi/tasks/state.json` atomically (write to .tmp then rename).
 */
export async function writeAggregateState(cwd: string, state: AggregateState): Promise<void> {
  const target = statePath(cwd);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, target);
}

/**
 * Reads state.json. Returns null if the file is missing.
 */
export async function readAggregateState(cwd: string): Promise<AggregateState | null> {
  try {
    const content = await readFile(statePath(cwd), "utf-8");
    return JSON.parse(content) as AggregateState;
  } catch {
    return null;
  }
}
