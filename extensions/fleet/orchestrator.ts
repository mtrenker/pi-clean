// Fleet extension — Orchestrator
// Resolves dependencies, schedules agents up to the concurrency cap,
// manages engine processes, and emits typed events.

import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import { join } from "path";

import type { FleetConfig } from "./config.js";
import { resolveAgentPrompt } from "./config.js";
import {
  listTasks,
  writeStatus,
  appendProgress,
  taskDir,
  type TaskState,
  type TaskStatus,
} from "./task.js";
import {
  buildAggregateState,
  writeAggregateState,
  type AggregateState,
} from "./state.js";
import { createEngineAdapter } from "./engines/index.js";
import type { EngineProcess } from "./engines/index.js";
import { handleFailure } from "./recovery.js";

// ── Event payload types ───────────────────────────────────────────────────────

export interface TaskStatusEvent {
  id: string;
  name: string;
  status: TaskStatus;
  prevStatus: TaskStatus;
  state: TaskState;
}

export interface TaskProgressEvent {
  id: string;
  name: string;
  step: string;
  status: "running" | "done" | "error";
}

export interface TaskUsageEvent {
  id: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FleetDoneEvent {
  summary: AggregateState["summary"];
}

// ── Typed EventEmitter interface ──────────────────────────────────────────────

export interface OrchestratorEvents {
  "task:status": (event: TaskStatusEvent) => void;
  "task:progress": (event: TaskProgressEvent) => void;
  "task:usage": (event: TaskUsageEvent) => void;
  "fleet:done": (event: FleetDoneEvent) => void;
}

// Augment EventEmitter with typed overloads via declaration merging
export declare interface Orchestrator {
  on<K extends keyof OrchestratorEvents>(
    event: K,
    listener: OrchestratorEvents[K],
  ): this;
  once<K extends keyof OrchestratorEvents>(
    event: K,
    listener: OrchestratorEvents[K],
  ): this;
  emit<K extends keyof OrchestratorEvents>(
    event: K,
    ...args: Parameters<OrchestratorEvents[K]>
  ): boolean;
  off<K extends keyof OrchestratorEvents>(
    event: K,
    listener: OrchestratorEvents[K],
  ): this;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class Orchestrator extends EventEmitter {
  /** in-memory task states; the canonical view during a run */
  private states = new Map<string, TaskState>();

  /** live engine processes keyed by task id */
  private processes = new Map<string, EngineProcess>();

  constructor(
    private readonly cwd: string,
    private readonly config: FleetConfig,
    private readonly onNotify: (message: string) => void = () => {},
  ) {
    super();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Load task states from disk, then schedule all eligible tasks.
   * If `taskIds` is provided, only those tasks will be started (deps must still be met).
   */
  async start(taskIds?: string[]): Promise<void> {
    // Refresh in-memory state from disk
    const diskStates = await listTasks(this.cwd);
    for (const s of diskStates) {
      this.states.set(s.id, s);
    }

    await this._scheduleReady(taskIds);
  }

  /**
   * Kill a specific running task (by id) or all running tasks.
   * Updates each killed task's status to "failed".
   */
  async stop(taskId?: string): Promise<void> {
    if (taskId !== undefined) {
      await this._killTask(taskId);
    } else {
      const ids = [...this.processes.keys()];
      for (const id of ids) {
        await this._killTask(id);
      }
    }
  }

  /**
   * Retry a specific task that is in "failed" or "retrying" status.
   * Resets the task back to pending-equivalent state, then schedules it.
   */
  async retry(taskId: string): Promise<void> {
    const state = this.states.get(taskId);
    if (!state) {
      throw new Error(`Task ${taskId} not found in orchestrator state`);
    }

    const prevStatus = state.status;
    state.status = "pending";
    state.error = null;
    state.startedAt = null;
    state.completedAt = null;
    state.duration = null;
    state.pid = null;

    await writeStatus(this.cwd, state);
    await this._refreshAggregateState();
    this.emit("task:status", {
      id: state.id,
      name: state.name,
      status: state.status,
      prevStatus,
      state: { ...state },
    });

    await this._scheduleReady([taskId]);
  }

  /**
   * Return a snapshot of all in-memory task states.
   */
  getSnapshot(): TaskState[] {
    return [...this.states.values()];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Recompute aggregate state from current in-memory data and write state.json.
   */
  private async _refreshAggregateState(): Promise<void> {
    const tasks = [...this.states.values()];
    const aggregate = buildAggregateState(tasks, new Map());
    await writeAggregateState(this.cwd, aggregate);
  }

  /**
   * Update in-memory state, write status.json, refresh state.json, emit "task:status".
   */
  private async onStatusChange(
    state: TaskState,
    prevStatus: TaskStatus,
  ): Promise<void> {
    this.states.set(state.id, state);
    await writeStatus(this.cwd, state);
    await this._refreshAggregateState();
    this.emit("task:status", {
      id: state.id,
      name: state.name,
      status: state.status,
      prevStatus,
      state: { ...state },
    });
  }

  /**
   * Determine which tasks are ready (pending + all deps done) and spawn them
   * up to the concurrency cap.
   */
  private async _scheduleReady(filterIds?: string[]): Promise<void> {
    const allStates = [...this.states.values()];

    // Build quick lookup: id → status
    const statusById = new Map<string, TaskStatus>(
      allStates.map((s) => [s.id, s.status]),
    );

    // Ready = pending AND all depends are "done"
    let readyTasks = allStates.filter(
      (s) =>
        s.status === "pending" &&
        s.depends.every((dep) => statusById.get(dep) === "done"),
    );

    // If caller specified particular IDs, validate and filter
    if (filterIds && filterIds.length > 0) {
      const filterSet = new Set(filterIds);
      // Validate: requested tasks must actually be ready
      for (const id of filterIds) {
        const s = this.states.get(id);
        if (!s) {
          throw new Error(`Task ${id} not found`);
        }
        if (s.status !== "pending") {
          throw new Error(
            `Task ${id} cannot be started: status is "${s.status}" (expected "pending")`,
          );
        }
        const blocking = s.depends.filter(
          (dep) => statusById.get(dep) !== "done",
        );
        if (blocking.length > 0) {
          throw new Error(
            `Task ${id} cannot be started: waiting on dependencies [${blocking.join(", ")}]`,
          );
        }
      }
      readyTasks = readyTasks.filter((s) => filterSet.has(s.id));
    }

    // Sort for deterministic ordering
    readyTasks.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );

    const runningCount = this.processes.size;
    const cap = this.config.concurrency;
    let available = cap - runningCount;

    while (available > 0 && readyTasks.length > 0) {
      const task = readyTasks.shift()!;
      await this._spawnTask(task);
      available--;
    }

    // Nothing started and nothing running → fleet is done
    if (this.processes.size === 0) {
      await this._maybeEmitFleetDone();
    }
  }

  /**
   * Spawn an engine process for a task.
   */
  private async _spawnTask(task: TaskState): Promise<void> {
    // Resolve agent prompt
    const agentName = task.agent || this.config.defaults.agent;
    const agentPrompt = resolveAgentPrompt(this.config, agentName);

    // Read task.md content
    const taskMdPath = join(taskDir(this.cwd, task.id, task.name), "task.md");
    const taskPrompt = await readFile(taskMdPath, "utf-8");

    // Resolve engine config
    const engineName = task.engine || this.config.defaults.engine;
    const engineConfig = this.config.engines[engineName];
    if (!engineConfig) {
      throw new Error(
        `Engine "${engineName}" not found in config for task ${task.id}`,
      );
    }

    // Output jsonl path
    const outputJsonlPath = join(
      taskDir(this.cwd, task.id, task.name),
      "output.jsonl",
    );

    // Resolve model
    const model = task.model || this.config.defaults.model;

    // Create adapter and spawn process
    const adapter = createEngineAdapter(engineName, engineConfig);
    const process = adapter.spawn({
      taskPrompt,
      agentPrompt,
      model,
      cwd: this.cwd,
      outputJsonlPath,
    });

    this.processes.set(task.id, process);

    // Update status → running
    const prevStatus = task.status;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.pid = process.pid;

    await this.onStatusChange(task, prevStatus);

    // Wire up callbacks
    process.onProgress((line) => {
      // Best-effort parse; fall back to raw line as step text
      let step = line.trim();
      let progressStatus: "running" | "done" | "error" = "running";
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed["step"] === "string") step = parsed["step"];
        if (
          parsed["status"] === "done" ||
          parsed["status"] === "error"
        ) {
          progressStatus = parsed["status"] as "done" | "error";
        }
      } catch {
        // raw text line — keep defaults
      }

      // Persist to progress.jsonl (fire-and-forget; don't block event loop)
      appendProgress(this.cwd, task.id, task.name, {
        ts: new Date().toISOString(),
        step,
        status: progressStatus,
      }).catch(() => {
        // Ignore write errors for progress lines
      });

      this.emit("task:progress", {
        id: task.id,
        name: task.name,
        step,
        status: progressStatus,
      });
    });

    process.onUsageUpdate((usage) => {
      // Update in-memory usage counters
      const current = this.states.get(task.id);
      if (current) {
        current.usage.inputTokens = usage.inputTokens;
        current.usage.outputTokens = usage.outputTokens;
      }

      this.emit("task:usage", {
        id: task.id,
        name: task.name,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    });

    process.onComplete((result) => {
      // Run async completion handler; catch unhandled rejections
      this._handleComplete(task, result).catch((err) => {
        console.error(`[fleet] Error handling completion for task ${task.id}:`, err);
      });
    });
  }

  /**
   * Handle task process completion.
   */
  private async _handleComplete(
    task: TaskState,
    result: { success: boolean; exitCode: number; error?: string },
  ): Promise<void> {
    this.processes.delete(task.id);

    // Re-read the latest in-memory state (usage may have been updated)
    const state = this.states.get(task.id) ?? task;
    const now = new Date().toISOString();
    const startedAt = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
    state.completedAt = now;
    state.duration = Date.now() - startedAt;

    if (result.success) {
      const prevStatus = state.status;
      state.status = "done";
      state.error = null;

      await this.onStatusChange(state, prevStatus);

      // Schedule newly unblocked tasks
      await this._scheduleReady();

      // If nothing is running and nothing pending, we're done
      if (this.processes.size === 0) {
        await this._maybeEmitFleetDone();
      }
    } else if (state.retries < 1) {
      // First failure — move to retrying; recovery.ts will generate recovery.md
      // and call orchestrator.retry()
      const prevStatus = state.status;
      state.status = "retrying";
      state.retries += 1;
      state.error = result.error ?? `Process exited with code ${result.exitCode}`;

      await this.onStatusChange(state, prevStatus);

      // Delegate to recovery module: writes recovery.md, then calls this.retry()
      await handleFailure({
        cwd: this.cwd,
        taskState: state,
        orchestrator: this,
        onNotify: this.onNotify,
      });
    } else {
      // Second failure — mark as permanently failed
      const prevStatus = state.status;
      state.status = "failed";
      state.error = result.error ?? `Process exited with code ${result.exitCode}`;

      await this.onStatusChange(state, prevStatus);

      // Notify via recovery module (handles retries >= 1 case)
      await handleFailure({
        cwd: this.cwd,
        taskState: state,
        orchestrator: this,
        onNotify: this.onNotify,
      });

      // Check if fleet is done (nothing running, nothing pending can proceed)
      if (this.processes.size === 0) {
        await this._maybeEmitFleetDone();
      }
    }
  }

  /**
   * Kill a single running task and mark it as failed.
   */
  private async _killTask(taskId: string): Promise<void> {
    const proc = this.processes.get(taskId);
    if (!proc) return;

    proc.kill();
    this.processes.delete(taskId);

    const state = this.states.get(taskId);
    if (state) {
      const prevStatus = state.status;
      state.status = "failed";
      state.error = "Killed by stop()";
      state.completedAt = new Date().toISOString();
      if (state.startedAt) {
        state.duration = Date.now() - new Date(state.startedAt).getTime();
      }

      await this.onStatusChange(state, prevStatus);
    }
  }

  /**
   * Check whether all tasks are terminal (done or failed) and emit "fleet:done"
   * if so. Called after each process completion or kill.
   */
  private async _maybeEmitFleetDone(): Promise<void> {
    const allStates = [...this.states.values()];

    // If there are still running processes, we are not done
    if (this.processes.size > 0) return;

    // If there are tasks that are pending AND could eventually unblock, keep waiting.
    // "Could unblock" means all its deps are either done or will become done.
    // For simplicity: if any task is still "running" (in-memory) or "pending" with
    // a possible future (none of deps are permanently failed), defer.
    const failedIds = new Set(
      allStates.filter((s) => s.status === "failed").map((s) => s.id),
    );
    const hasPendingReachable = allStates.some((s) => {
      if (s.status !== "pending") return false;
      // If any dependency is failed, this task can never run
      const blockedByFailed = s.depends.some((dep) => failedIds.has(dep));
      if (blockedByFailed) return false;
      // Pending but still could run
      const allDepsDone = s.depends.every(
        (dep) => this.states.get(dep)?.status === "done",
      );
      // If all deps are done but it's still pending it just hasn't been scheduled yet
      // (shouldn't happen if _scheduleReady was called), treat as not reachable for done
      if (allDepsDone) return true;
      // Has unfinished but not-failed deps — could still run
      return true;
    });

    if (hasPendingReachable) return;

    // All tasks are done, failed, or permanently blocked → emit fleet:done
    const aggregate = buildAggregateState(allStates, new Map());
    this.emit("fleet:done", { summary: aggregate.summary });
  }
}
