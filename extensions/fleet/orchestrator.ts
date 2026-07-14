// Fleet extension — Orchestrator
// Resolves dependencies, schedules agents up to the concurrency cap,
// manages engine processes, and emits typed events.

import { EventEmitter } from "events";
import { access, readFile } from "fs/promises";
import { basename, join } from "path";

import type { FleetConfig } from "./config.js";
import { resolveAgentPrompt } from "./config.js";
import {
  listTasks,
  writeStatus,
  appendProgress,
  taskDir,
  type TaskState,
  type TaskStatus,
  type ProgressEntry,
} from "./task.js";
import {
  buildAggregateState,
  writeAggregateState,
  type AggregateState,
} from "./state.js";
import { createEngineAdapter, createSimulateAdapter } from "./engines/index.js";
import type { EngineProcess } from "./engines/index.js";
import type { EngineUsage } from "./engines/types.js";
import { normalizeUsage } from "./engines/types.js";
import { handleFailure } from "./recovery.js";
import { appendFleetEvent, type FleetEventInput } from "./events.js";
import { updateRunStatus, readRunMetadata } from "./run.js";
import { deriveAllAttentionHints } from "./attention.js";
import {
  createTaskLifecycleReporter,
  readFlightdeckWorkContext,
  stableLocalId,
  type TaskLifecycleReporter,
  type TaskProvider,
} from "../flightdeck/lifecycle.js";

// ── Event payload types ───────────────────────────────────────────────────────

export interface TaskStatusEvent {
  id: string;
  name: string;
  status: TaskStatus;
  prevStatus: TaskStatus;
  state: RuntimeTaskState;
}

export interface TaskProgressEvent {
  id: string;
  name: string;
  latestProgressAt: string;
  latestProgressMessage: string;
  step: string;
  status: "running" | "done" | "error";
}

export interface TaskUsageEvent {
  id: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  source: string;
  updatedAt: string;
}

export interface FleetDoneEvent {
  summary: AggregateState["summary"];
}

export interface RuntimeTaskState extends TaskState {
  latestProgressAt: string | null;
  latestProgressMessage: string | null;
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
  private states = new Map<string, RuntimeTaskState>();

  /** cached progress entries by task id for aggregate updates without disk rereads */
  private progressByTask = new Map<string, ProgressEntry[]>();

  /** live engine processes keyed by task id */
  private processes = new Map<string, EngineProcess>();

  /** best-effort Flightdeck reporters keyed by task id for the active attempt */
  private lifecycleReporters = new Map<string, TaskLifecycleReporter>();

  /** prevents duplicate terminal fleet events when schedule checks repeat */
  private fleetDoneEmitted = false;

  /**
   * Set to true when the operator's plan fails structural validation.
   * Surfaced as a `plan_validation_failed` attention hint on every aggregate
   * state refresh until the fleet is restarted with a valid plan.
   */
  private _planValidationFailed = false;

  constructor(
    private readonly cwd: string,
    private readonly config: FleetConfig,
    private readonly onNotify: (message: string) => void = () => {},
    private readonly simulate: boolean = false,
  ) {
    super();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Load task states from disk, then schedule all eligible tasks.
   * If `taskIds` is provided, only those tasks will be started (deps must still be met).
   */
  async start(taskIds?: string[]): Promise<void> {
    this.fleetDoneEmitted = false;

    // Refresh in-memory state from disk
    const diskStates = await listTasks(this.cwd);
    for (const s of diskStates) {
      const state = this._toRuntimeTaskState(s);
      const progressEntries = await this._readProgressEntriesSafe(s.id, s.name);
      this.progressByTask.set(s.id, progressEntries);
      const latest = progressEntries.length > 0 ? progressEntries[progressEntries.length - 1] : null;
      state.latestProgressAt = latest?.ts || null;
      state.latestProgressMessage = latest?.step ?? null;
      this.states.set(s.id, state);
    }

    await this._refreshAggregateState();
    if (taskIds === undefined || taskIds.length > 0) {
      await this._recordEvent({
        type: "fleet_started",
        data: {
          taskIds: taskIds ?? null,
          taskCount: this.states.size,
          concurrency: this.config.concurrency,
          simulate: this.simulate,
        },
      });
    }
    if (taskIds && taskIds.length === 0) return;
    await this._scheduleReady(taskIds);
  }

  /**
   * Kill a specific running task (by id) or all running tasks.
   * Updates each killed task's status to "failed".
   */
  async stop(taskId?: string): Promise<void> {
    const stoppedIds = taskId !== undefined
      ? (this.processes.has(taskId) ? [taskId] : [])
      : [...this.processes.keys()];
    if (taskId !== undefined) {
      await this._killTask(taskId);
    } else {
      const ids = [...this.processes.keys()];
      for (const id of ids) {
        await this._killTask(id);
      }
    }
    if (stoppedIds.length === 0) return;
    await updateRunStatus(this.cwd, "failed");
    await this._recordEvent({
      type: "fleet_stopped",
      data: {
        taskId: taskId ?? null,
        stoppedTaskIds: stoppedIds,
      },
    });
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
    state.retries += 1;
    state.error = null;
    state.startedAt = null;
    state.completedAt = null;
    state.duration = null;
    state.pid = null;

    await writeStatus(this.cwd, state);
    await this._refreshAggregateState();
    await this._recordEvent({
      type: "task_retried",
      taskId: state.id,
      data: {
        name: state.name,
        prevStatus,
        retries: state.retries,
      },
    });
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
  getSnapshot(): RuntimeTaskState[] {
    return [...this.states.values()];
  }

  /**
   * Mark the current fleet plan as having failed structural validation.
   * This surfaces a `plan_validation_failed` attention hint on every
   * subsequent aggregate state refresh.
   * Call from index.ts when the operator runs `/fleet validate` or
   * `/fleet start` and the plan parser reports errors.
   */
  notifyPlanValidationFailed(): void {
    this._planValidationFailed = true;
  }

  /**
   * Clear the plan-validation-failed flag (e.g. when a new valid plan is loaded).
   */
  clearPlanValidationFailed(): void {
    this._planValidationFailed = false;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Recompute aggregate state from current in-memory data and write state.json.
   * Also derives attention hints (sync + async) and embeds them in the state.
   */
  private async _refreshAggregateState(): Promise<void> {
    const tasks = [...this.states.values()];
    const aggregate = buildAggregateState(tasks, this.progressByTask);

    // Derive attention hints — best-effort; never block state write on errors.
    try {
      const runMeta = await readRunMetadata(this.cwd);
      const runId = runMeta?.runId;
      aggregate.attentionHints = await deriveAllAttentionHints(
        this.cwd,
        aggregate.tasks,
        {
          runId,
          planValidationFailed: this._planValidationFailed,
        },
      );
    } catch (err) {
      console.warn("[fleet/attention] Failed to derive attention hints:", err);
      // attentionHints stays as [] — safe fallback
    }

    await writeAggregateState(this.cwd, aggregate);
  }

  private async _recordEvent(input: FleetEventInput): Promise<void> {
    try {
      await appendFleetEvent(this.cwd, input);
    } catch (error) {
      console.warn("[fleet/events] Failed to append event:", error);
    }
  }

  private _toRuntimeTaskState(state: TaskState): RuntimeTaskState {
    return {
      ...state,
      latestProgressAt: null,
      latestProgressMessage: null,
    };
  }

  private async _readProgressEntriesSafe(id: string, name: string): Promise<ProgressEntry[]> {
    const filePath = join(taskDir(this.cwd, id, name), "progress.jsonl");
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return [];
    }

    const entries: ProgressEntry[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Partial<ProgressEntry>;
        if (typeof parsed.step !== "string" || parsed.step.trim() === "") continue;
        const status =
          parsed.status === "done" || parsed.status === "error"
            ? parsed.status
            : "running";
        entries.push({
          ts: typeof parsed.ts === "string" ? parsed.ts : "",
          step: parsed.step,
          status,
        });
      } catch {
        // ignore malformed JSONL lines
      }
    }

    return entries;
  }

  /**
   * Update in-memory state, write status.json, refresh state.json, emit "task:status".
   */
  private async onStatusChange(
    state: RuntimeTaskState,
    prevStatus: TaskStatus,
  ): Promise<void> {
    this.states.set(state.id, state);
    await writeStatus(this.cwd, state);
    await this._refreshAggregateState();
    await this._recordEvent({
      type: "task_status_changed",
      taskId: state.id,
      data: {
        name: state.name,
        status: state.status,
        prevStatus,
        retries: state.retries,
      },
    });
    if (state.status === "failed") {
      await this._recordEvent({
        type: "task_failed",
        taskId: state.id,
        data: {
          name: state.name,
          error: state.error,
          retries: state.retries,
        },
      });
    }
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
  private async _spawnTask(task: RuntimeTaskState): Promise<void> {
    // Resolve agent prompt
    const agentName = task.agent || this.config.defaults.agent;
    const agentPrompt = resolveAgentPrompt(this.config, agentName);
    const agentTools = this.config.agents[agentName]?.tools ?? null;

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
    // In simulate mode, always use the simulate adapter regardless of task engine
    const adapter = this.simulate
      ? createSimulateAdapter(this.config.simulate)
      : createEngineAdapter(engineName, engineConfig);
    const process = adapter.spawn({
      taskPrompt,
      agentPrompt,
      model,
      thinking: task.thinking,
      tools: agentTools,
      cwd: this.cwd,
      outputJsonlPath,
    });

    this.processes.set(task.id, process);

    let lifecycleReporter: TaskLifecycleReporter | null = null;
    try {
      lifecycleReporter = await this._createLifecycleReporter(task, engineName, model);
      if (lifecycleReporter) {
        this.lifecycleReporters.set(task.id, lifecycleReporter);
        await lifecycleReporter.start();
      }
    } catch {
      // Telemetry is observational; malformed legacy metadata or adapter
      // failures must never prevent the already-spawned task from running.
      lifecycleReporter = null;
    }

    // Update status → running
    const prevStatus = task.status;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.pid = process.pid;

    await this.onStatusChange(task, prevStatus);

    // Wire up callbacks
    process.onProgress((line) => {
      this.lifecycleReporters.get(task.id)?.heartbeat();
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
      const now = new Date().toISOString();
      const entry: ProgressEntry = {
        ts: now,
        step,
        status: progressStatus,
      };

      const state = this.states.get(task.id);
      if (state) {
        state.latestProgressAt = entry.ts;
        state.latestProgressMessage = entry.step;
        // Update heartbeat and output timestamps on every output line
        state.lastOutputAt = now;
        state.lastProgressAt = now;
        state.lastHeartbeatAt = now;
      }
      const existing = this.progressByTask.get(task.id) ?? [];
      existing.push(entry);
      this.progressByTask.set(task.id, existing);

      // Persist to progress.jsonl (fire-and-forget; don't block event loop)
      appendProgress(this.cwd, task.id, task.name, entry).catch(() => {
        // Ignore write errors for progress lines
      });
      this._refreshAggregateState().catch(() => {
        // Ignore state refresh failures from progress updates
      });

      this.emit("task:progress", {
        id: task.id,
        name: task.name,
        latestProgressAt: entry.ts,
        latestProgressMessage: entry.step,
        step,
        status: progressStatus,
      });
      appendFleetEvent(this.cwd, {
        type: "task_progress",
        taskId: task.id,
        data: {
          name: task.name,
          step,
          status: progressStatus,
        },
      }).catch((error) => {
        console.warn("[fleet/events] Failed to append progress event:", error);
      });
    });

    process.onUsageUpdate((engineUsage: EngineUsage) => {
      const now = new Date().toISOString();
      this.lifecycleReporters.get(task.id)?.usage({
        inputTokens: engineUsage.inputTokens,
        outputTokens: engineUsage.outputTokens,
        cacheReadTokens: engineUsage.cacheReadInputTokens,
        cacheWriteTokens: engineUsage.cacheCreationInputTokens,
      }, model);
      // Normalize to full Usage envelope: add totalTokens, source, updatedAt
      const normalized = normalizeUsage(engineUsage, task.engine, now);

      // Update in-memory state
      const current = this.states.get(task.id);
      if (current) {
        current.usage = normalized;
        current.lastHeartbeatAt = now;
      }

      // Persist usage to disk so Flightdeck sees live token movement.
      // Fire-and-forget — don't block the event loop.
      if (current) {
        writeStatus(this.cwd, current).catch(() => {
          // Ignore write errors for usage updates
        });
      }
      this._refreshAggregateState().catch(() => {
        // Ignore state refresh failures from usage updates
      });

      this.emit("task:usage", {
        id: task.id,
        name: task.name,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cacheCreationInputTokens: normalized.cacheCreationInputTokens,
        cacheReadInputTokens: normalized.cacheReadInputTokens,
        totalTokens: normalized.totalTokens,
        source: normalized.source,
        updatedAt: normalized.updatedAt,
      });
      appendFleetEvent(this.cwd, {
        type: "task_usage_updated",
        taskId: task.id,
        data: {
          name: task.name,
          usage: normalized,
        },
      }).catch((error) => {
        console.warn("[fleet/events] Failed to append usage event:", error);
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
    task: RuntimeTaskState,
    result: { success: boolean; exitCode: number; error?: string },
  ): Promise<void> {
    this.processes.delete(task.id);
    const lifecycleReporter = this.lifecycleReporters.get(task.id);
    this.lifecycleReporters.delete(task.id);
    await lifecycleReporter?.terminal(result.success ? "completed" : "failed", { exitCode: result.exitCode });

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
      await this._recordHandoffIfPresent(state);

      // Schedule newly unblocked tasks
      await this._scheduleReady();

      // If nothing is running and nothing pending, we're done
      if (this.processes.size === 0) {
        await this._maybeEmitFleetDone();
      }
    } else if (state.retries < 1) {
      // First failure — move to retrying; recovery.ts will generate recovery.md
      // and call orchestrator.retry(). The retry counter is incremented in retry()
      // when the new attempt is actually scheduled.
      const prevStatus = state.status;
      state.status = "retrying";
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

  private async _createLifecycleReporter(
    task: RuntimeTaskState,
    engineName: string,
    model: string,
  ): Promise<TaskLifecycleReporter | null> {
    if (this.simulate || (engineName !== "claude" && engineName !== "codex")) return null;
    if ((process.env.FLIGHTDECK_FLEET_TELEMETRY_OWNER ?? "extension") === "scanner") return null;

    const run = await readRunMetadata(this.cwd);
    const runId = run?.runId ?? stableLocalId("fleet:legacy", this.cwd);
    const attempt = task.retries;
    const context = readFlightdeckWorkContext(this.cwd);
    context.projectSlug ??= basename(run?.git?.repoRoot ?? this.cwd);
    context.repoRoot ??= run?.git?.repoRoot ?? this.cwd;
    context.worktreePath ??= run?.git?.worktreePath ?? this.cwd;
    context.repository ??= repositoryFromRemote(run?.git?.remote);
    context.branch ??= run?.git?.branch ?? undefined;

    const lifecycleId = `fleet:${runId}:task:${task.id}:attempt:${attempt}`;
    return createTaskLifecycleReporter({
      lifecycleId,
      agentId: lifecycleId,
      runId,
      taskId: task.id,
      provider: engineName as TaskProvider,
      model,
      source: "fleet",
      context,
      staleAfterSeconds: task.staleAfterSeconds,
    });
  }

  private async _recordHandoffIfPresent(state: RuntimeTaskState): Promise<void> {
    const relativePath = `.pi/tasks/${state.id}-${state.name}/handoff.md`;
    try {
      await access(join(taskDir(this.cwd, state.id, state.name), "handoff.md"));
    } catch {
      return;
    }

    await this._recordEvent({
      type: "task_handoff_written",
      taskId: state.id,
      data: {
        name: state.name,
        path: relativePath,
      },
    });
  }

  /**
   * Kill a single running task and mark it as failed.
   */
  private async _killTask(taskId: string): Promise<void> {
    const proc = this.processes.get(taskId);
    if (!proc) return;

    proc.kill();
    this.processes.delete(taskId);
    const lifecycleReporter = this.lifecycleReporters.get(taskId);
    this.lifecycleReporters.delete(taskId);
    await lifecycleReporter?.terminal("aborted");

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
    if (this.fleetDoneEmitted) return;

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
    const aggregate = buildAggregateState(allStates, this.progressByTask);
    this.fleetDoneEmitted = true;
    await updateRunStatus(this.cwd, aggregate.summary.failed > 0 ? "failed" : "done");
    await this._recordEvent({
      type: "fleet_completed",
      data: {
        summary: aggregate.summary,
      },
    });
    this.emit("fleet:done", { summary: aggregate.summary });
  }
}

function repositoryFromRemote(remote: string | null | undefined): string | undefined {
  if (!remote) return undefined;
  const normalized = remote
    .replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^ssh:\/\/git@[^/]+\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  return normalized.includes("/") ? normalized : undefined;
}
