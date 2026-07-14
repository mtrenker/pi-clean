import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import {
  normalizeTaskUsage,
  type TaskLifecycleEvent,
  type TaskTerminalStatus,
  type TaskUsageSnapshot,
} from "./lifecycle.js";

export type TelemetrySinkHealth = "disabled" | "healthy" | "error";

export interface FlightdeckTaskCounts {
  active: number;
  completed: number;
  failed: number;
  aborted: number;
  stale: number;
}

export interface FlightdeckTelemetryStatus {
  sink: TelemetrySinkHealth;
  sinkPath?: string;
  lastError?: string;
  lastEmittedAt?: string;
  counts: FlightdeckTaskCounts;
}

interface TrackedTask {
  status: "active" | TaskTerminalStatus;
  lastHeartbeatAt: number;
  staleAfterSeconds: number;
}

interface TelemetryEnvelope {
  schemaVersion: 1;
  ts: string;
  service: "pi-clean";
  event: string;
  level: "info" | "warn" | "error";
  message: string;
  durationMs?: number;
  resource: {
    serviceName: "pi-clean";
    serviceInstanceId: string;
    hostName: string;
  };
  attributes: Record<string, unknown>;
}

export interface FlightdeckTelemetryAdapterOptions {
  sinkPath?: string;
  machineId?: string;
  now?: () => Date;
  append?: (path: string, line: string) => Promise<void>;
  onStatus?: (status: FlightdeckTelemetryStatus) => void;
}

/**
 * Converts the private lifecycle hook contract into Flightdeck schema-v1
 * JSONL. The adapter is an observational, best-effort sink and never throws
 * from handle().
 */
export class FlightdeckTelemetryAdapter {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly sinkPath: string | undefined;
  private readonly machineId: string;
  private readonly now: () => Date;
  private readonly append: (path: string, line: string) => Promise<void>;
  private readonly onStatus: ((status: FlightdeckTelemetryStatus) => void) | undefined;
  private writeQueue = Promise.resolve();
  private health: TelemetrySinkHealth;
  private lastError: string | undefined;
  private lastEmittedAt: string | undefined;

  constructor(options: FlightdeckTelemetryAdapterOptions = {}) {
    this.sinkPath = options.sinkPath;
    this.machineId = options.machineId ?? hostname();
    this.now = options.now ?? (() => new Date());
    this.append = options.append ?? appendJsonl;
    this.onStatus = options.onStatus;
    this.health = this.sinkPath ? "healthy" : "disabled";
  }

  async handle(event: TaskLifecycleEvent): Promise<void> {
    this.track(event);
    this.notifyStatus();
    if (!this.sinkPath) return;

    for (const envelope of buildFlightdeckEvents(event, this.machineId)) {
      this.writeQueue = this.writeQueue.then(
        () => this.write(envelope),
        () => this.write(envelope),
      );
    }
    await this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  getStatus(): FlightdeckTelemetryStatus {
    const now = this.now().getTime();
    const counts: FlightdeckTaskCounts = { active: 0, completed: 0, failed: 0, aborted: 0, stale: 0 };
    for (const task of this.tasks.values()) {
      if (task.status === "active") {
        counts.active += 1;
        if (now - task.lastHeartbeatAt > task.staleAfterSeconds * 1000) counts.stale += 1;
      } else {
        counts[task.status] += 1;
      }
    }
    return {
      sink: this.health,
      sinkPath: this.sinkPath,
      lastError: this.lastError,
      lastEmittedAt: this.lastEmittedAt,
      counts,
    };
  }

  private track(event: TaskLifecycleEvent): void {
    const at = Date.parse(event.ts);
    if (event.type === "started") {
      if (!this.tasks.has(event.lifecycleId)) {
        this.tasks.set(event.lifecycleId, {
          status: "active",
          lastHeartbeatAt: Number.isFinite(at) ? at : this.now().getTime(),
          staleAfterSeconds: event.staleAfterSeconds,
        });
      }
      return;
    }

    const current = this.tasks.get(event.lifecycleId);
    if (!current || current.status !== "active") return;
    current.lastHeartbeatAt = Number.isFinite(at) ? at : this.now().getTime();
    if (event.type === "terminal") current.status = event.status;
  }

  private async write(envelope: TelemetryEnvelope): Promise<void> {
    try {
      await this.append(this.sinkPath!, `${JSON.stringify(envelope)}\n`);
      this.health = "healthy";
      this.lastError = undefined;
      this.lastEmittedAt = envelope.ts;
    } catch (error) {
      this.health = "error";
      this.lastError = safeError(error);
    }
    this.notifyStatus();
  }

  private notifyStatus(): void {
    this.onStatus?.(this.getStatus());
  }
}

export function buildFlightdeckEvents(event: TaskLifecycleEvent, machineId = hostname()): TelemetryEnvelope[] {
  const common = compact({
    agentId: event.agentId,
    runId: event.runId,
    taskId: event.taskId,
    engine: event.provider,
    provider: providerName(event.provider),
    model: event.model,
    "gen_ai.system": providerName(event.provider),
    "gen_ai.request.model": event.model,
    source: event.source,
    lifecycleId: event.lifecycleId,
    staleAfterSeconds: event.staleAfterSeconds,
    telemetryOwner: "pi-clean-extension",
    environmentType: "local",
    machineId,
    ...event.context,
  });
  const resource = {
    serviceName: "pi-clean" as const,
    serviceInstanceId: `pi-clean:${machineId}`,
    hostName: machineId,
  };
  const envelope = (
    name: string,
    message: string,
    attributes: Record<string, unknown>,
    level: "info" | "warn" | "error" = "info",
    durationMs?: number,
  ): TelemetryEnvelope => ({
    schemaVersion: 1,
    ts: event.ts,
    service: "pi-clean",
    event: name,
    level,
    message,
    ...(durationMs === undefined ? {} : { durationMs }),
    resource,
    attributes,
  });

  if (event.type === "started") {
    return [
      envelope("agent.run.started", "agent run started", transitionAttributes(common, event, "run", "started", "started")),
      envelope("agent.task.started", "agent task started", transitionAttributes(common, event, "task", "started", "started")),
    ];
  }

  if (event.type === "heartbeat") {
    const suffix = `heartbeat:${event.sequence}`;
    return [
      envelope("agent.run.heartbeat", "agent run heartbeat", transitionAttributes(common, event, "run", suffix, "running", { heartbeatSequence: event.sequence })),
      envelope("agent.task.running", "agent task running", transitionAttributes(common, event, "task", suffix, "running", { heartbeatSequence: event.sequence })),
    ];
  }

  if (event.type === "usage") {
    const usage = normalizeTaskUsage(event.usage);
    const usageKey = usageIdentity(usage);
    return [envelope("agent.tokens.used", "agent tokens used", {
      ...common,
      status: "running",
      usageKind: "cumulative",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadTokens,
      cacheCreationInputTokens: usage.cacheWriteTokens,
      totalTokens: totalTokens(usage),
      "gen_ai.usage.input_tokens": usage.inputTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      eventId: stableEventId(event, `tokens:${usageKey}`),
      dedupeKey: stableDedupeKey(event, `tokens:${usageKey}`),
    })];
  }

  const failed = event.status !== "completed";
  const eventSuffix = event.status;
  const extras = compact({ exitCode: event.exitCode });
  const verb = event.status === "completed" ? "completed" : event.status === "aborted" ? "aborted" : "failed";
  return [
    envelope(
      failed ? "agent.run.failed" : "agent.run.completed",
      `agent run ${verb}`,
      transitionAttributes(common, event, "run", eventSuffix, event.status, extras),
      event.status === "failed" ? "error" : event.status === "aborted" ? "warn" : "info",
      event.durationMs,
    ),
    envelope(
      failed ? "agent.task.failed" : "agent.task.completed",
      `agent task ${verb}`,
      transitionAttributes(common, event, "task", eventSuffix, event.status, extras),
      event.status === "failed" ? "error" : event.status === "aborted" ? "warn" : "info",
      event.durationMs,
    ),
  ];
}

function transitionAttributes(
  common: Record<string, unknown>,
  event: TaskLifecycleEvent,
  scope: "run" | "task",
  transition: string,
  status: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...common,
    ...extras,
    status,
    eventId: stableEventId(event, `${scope}:${transition}`),
    dedupeKey: stableDedupeKey(event, `${scope}:${transition}`),
  };
}

function stableEventId(event: TaskLifecycleEvent, transition: string): string {
  return `pi-clean:${safePart(event.lifecycleId)}:${safePart(transition)}`;
}

function stableDedupeKey(event: TaskLifecycleEvent, transition: string): string {
  return `pi-clean/${safePart(event.lifecycleId)}/${safePart(transition)}`;
}

function usageIdentity(usage: TaskUsageSnapshot): string {
  return `${usage.inputTokens}:${usage.outputTokens}:${usage.cacheReadTokens}:${usage.cacheWriteTokens}`;
}

function totalTokens(usage: TaskUsageSnapshot): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function providerName(provider: "claude" | "codex"): "anthropic" | "openai" {
  return provider === "claude" ? "anthropic" : "openai";
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_");
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

async function appendJsonl(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, "utf8");
}

function safeError(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  return code ? `telemetry append failed (${code})` : "telemetry append failed";
}
