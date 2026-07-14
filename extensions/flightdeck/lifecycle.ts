import { createHash } from "node:crypto";

export type TaskProvider = "claude" | "codex";
export type TaskLifecycleSource = "delegate" | "fleet";
export type TaskTerminalStatus = "completed" | "failed" | "aborted";

export interface TaskUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TaskWorkContext {
  workId?: string;
  projectSlug?: string;
  repoRoot?: string;
  repository?: string;
  worktreePath?: string;
  role?: "author" | "reviewer";
  reviewer?: string;
  runtime?: string;
  workspaceLabel?: string;
  branch?: string;
}

interface TaskIdentity {
  lifecycleId: string;
  agentId: string;
  runId: string;
  taskId: string;
  provider: TaskProvider;
  model?: string;
  source: TaskLifecycleSource;
  staleAfterSeconds: number;
  context: TaskWorkContext;
}

export type TaskLifecycleEvent =
  | (TaskIdentity & { type: "started"; ts: string })
  | (TaskIdentity & { type: "heartbeat"; ts: string; sequence: number })
  | (TaskIdentity & { type: "usage"; ts: string; usage: TaskUsageSnapshot })
  | (TaskIdentity & { type: "terminal"; ts: string; status: TaskTerminalStatus; durationMs?: number; exitCode?: number });

export type TaskLifecycleListener = (event: TaskLifecycleEvent) => void | Promise<void>;

interface TaskLifecycleRegistry {
  listeners: Set<TaskLifecycleListener>;
}

// Pi loads each extension through a separate jiti instance with module caching
// disabled. Anchor the trusted in-process registry on the shared JS realm so
// harness-delegate, Fleet, and the Flightdeck adapter see the same listeners.
const registryKey = Symbol.for("pi-clean.flightdeck.task-lifecycle.v1");
const globalRegistry = globalThis as typeof globalThis & { [registryKey]?: TaskLifecycleRegistry };
const registry = globalRegistry[registryKey] ??= { listeners: new Set<TaskLifecycleListener>() };

export function subscribeTaskLifecycle(listener: TaskLifecycleListener): () => void {
  registry.listeners.add(listener);
  return () => registry.listeners.delete(listener);
}

/**
 * Dispatch lifecycle signals to trusted in-process adapters. Listener failures
 * are intentionally isolated: observability must never alter task execution.
 */
export async function emitTaskLifecycle(event: TaskLifecycleEvent): Promise<void> {
  await Promise.allSettled([...registry.listeners].map((listener) => listener(event)));
}

export interface TaskLifecycleReporterOptions {
  lifecycleId: string;
  agentId: string;
  runId: string;
  taskId: string;
  provider: TaskProvider;
  model?: string;
  source: TaskLifecycleSource;
  context?: TaskWorkContext;
  staleAfterSeconds?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

export interface TaskLifecycleReporter {
  start(): Promise<void>;
  heartbeat(): void;
  usage(usage: Partial<TaskUsageSnapshot>, model?: string): void;
  terminal(status: TaskTerminalStatus, details?: { exitCode?: number }): Promise<void>;
  flush(): Promise<void>;
}

/**
 * A single-use reporter. It guarantees one start and at most one terminal
 * transition, serializes updates, periodically heartbeats quiet processes,
 * and coalesces identical cumulative usage snapshots.
 */
export function createTaskLifecycleReporter(options: TaskLifecycleReporterOptions): TaskLifecycleReporter {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let started = false;
  let terminal = false;
  let sequence = 0;
  let model = options.model;
  let lastUsage: TaskUsageSnapshot | undefined;
  let lastUsageKey: string | undefined;
  let queue = Promise.resolve();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const identity = (): TaskIdentity => ({
    lifecycleId: options.lifecycleId,
    agentId: options.agentId,
    runId: options.runId,
    taskId: options.taskId,
    provider: options.provider,
    model,
    source: options.source,
    staleAfterSeconds: options.staleAfterSeconds ?? 90,
    context: options.context ?? {},
  });

  const enqueue = (event: TaskLifecycleEvent): void => {
    queue = queue.then(() => emitTaskLifecycle(event), () => emitTaskLifecycle(event));
  };

  const reporter: TaskLifecycleReporter = {
    async start() {
      if (started) return queue;
      started = true;
      enqueue({ ...identity(), type: "started", ts: startedAt.toISOString() });

      const interval = options.heartbeatIntervalMs ?? 30_000;
      if (interval > 0) {
        heartbeatTimer = setInterval(() => reporter.heartbeat(), interval);
        heartbeatTimer.unref?.();
      }
      return queue;
    },

    heartbeat() {
      if (!started || terminal) return;
      sequence += 1;
      enqueue({ ...identity(), type: "heartbeat", ts: now().toISOString(), sequence });
    },

    usage(rawUsage, resolvedModel) {
      if (!started || terminal) return;
      if (resolvedModel) model = resolvedModel;
      const normalized = normalizeTaskUsage(rawUsage);
      const usage: TaskUsageSnapshot = lastUsage
        ? {
            inputTokens: Math.max(lastUsage.inputTokens, normalized.inputTokens),
            outputTokens: Math.max(lastUsage.outputTokens, normalized.outputTokens),
            cacheReadTokens: Math.max(lastUsage.cacheReadTokens, normalized.cacheReadTokens),
            cacheWriteTokens: Math.max(lastUsage.cacheWriteTokens, normalized.cacheWriteTokens),
          }
        : normalized;
      if (!lastUsage && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) return;
      const key = `${usage.inputTokens}:${usage.outputTokens}:${usage.cacheReadTokens}:${usage.cacheWriteTokens}`;
      if (key === lastUsageKey) return;
      lastUsage = usage;
      lastUsageKey = key;
      enqueue({ ...identity(), type: "usage", ts: now().toISOString(), usage });
    },

    async terminal(status, details = {}) {
      if (!started || terminal) return queue;
      terminal = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      const endedAt = now();
      enqueue({
        ...identity(),
        type: "terminal",
        ts: endedAt.toISOString(),
        status,
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        exitCode: details.exitCode,
      });
      return queue;
    },

    flush() {
      return queue;
    },
  };

  return reporter;
}

export function normalizeTaskUsage(usage: Partial<TaskUsageSnapshot>): TaskUsageSnapshot {
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
  };
}

export function readFlightdeckWorkContext(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): TaskWorkContext {
  const role: TaskWorkContext["role"] = env.FLIGHTDECK_ROLE === "author" || env.FLIGHTDECK_ROLE === "reviewer"
    ? env.FLIGHTDECK_ROLE
    : undefined;
  return compact({
    workId: env.FLIGHTDECK_WORK_ID,
    projectSlug: env.FLIGHTDECK_PROJECT_SLUG,
    repoRoot: env.FLIGHTDECK_REPO_ROOT,
    repository: env.FLIGHTDECK_REPOSITORY,
    worktreePath: env.FLIGHTDECK_WORKTREE_PATH || cwd,
    role,
    reviewer: env.FLIGHTDECK_REVIEWER,
    runtime: env.FLIGHTDECK_RUNTIME,
    workspaceLabel: env.FLIGHTDECK_WORKSPACE_LABEL,
    branch: env.FLIGHTDECK_BRANCH,
  });
}

export function stableLocalId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function tokenCount(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : 0;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")) as T;
}
