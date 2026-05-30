// Fleet extension — append-only timeline events

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { readRunMetadata } from "./run.js";

export type FleetEventType =
  | "fleet_started"
  | "fleet_completed"
  | "fleet_stopped"
  | "task_status_changed"
  | "task_progress"
  | "task_usage_updated"
  | "task_failed"
  | "task_retried"
  | "task_handoff_written"
  | "archive_created"
  | "plan_validated"
  | "operator_command";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type FleetEventData = Record<string, JsonValue>;

export interface FleetTimelineEvent {
  ts: string;
  runId: string;
  type: FleetEventType;
  taskId?: string;
  data: FleetEventData;
}

export interface FleetEventInput {
  type: FleetEventType;
  taskId?: string;
  data?: Record<string, unknown>;
}

export function fleetEventsPath(cwd: string): string {
  return join(cwd, ".pi", "tasks", "events.jsonl");
}

function sanitizeValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  }

  if (Array.isArray(value)) {
    if (depth >= 3) return "[array]";
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1));
  }

  if (typeof value === "object" && value) {
    if (depth >= 3) return "[object]";
    const result: FleetEventData = {};
    for (const [key, entry] of Object.entries(value).slice(0, 30)) {
      result[key] = sanitizeValue(entry, depth + 1);
    }
    return result;
  }

  return String(value);
}

function sanitizeData(data: Record<string, unknown> | undefined): FleetEventData {
  if (!data) return {};
  const result: FleetEventData = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = sanitizeValue(value);
  }
  return result;
}

export async function appendFleetEvent(
  cwd: string,
  input: FleetEventInput,
): Promise<FleetTimelineEvent> {
  const run = await readRunMetadata(cwd);
  const event: FleetTimelineEvent = {
    ts: new Date().toISOString(),
    runId: run?.runId ?? "legacy",
    type: input.type,
    data: sanitizeData(input.data),
  };

  if (input.taskId) {
    event.taskId = input.taskId;
  }

  await mkdir(join(cwd, ".pi", "tasks"), { recursive: true });
  await appendFile(fleetEventsPath(cwd), `${JSON.stringify(event)}\n`, "utf-8");
  return event;
}
