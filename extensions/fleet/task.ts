// Fleet extension — per-task file management

import { mkdir, readFile, writeFile, rename, readdir, appendFile } from "fs/promises";
import { join } from "path";
import type { TaskSpec } from "./plan.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "running" | "done" | "failed" | "retrying";

export interface TaskState {
  id: string;
  name: string;           // slug, e.g. "refactor-auth"
  status: TaskStatus;
  engine: string;
  model: string;
  agent: string;
  depends: string[];
  startedAt: string | null;    // ISO timestamp
  completedAt: string | null;
  duration: number | null;     // ms
  retries: number;
  pid: number | null;
  error: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ProgressEntry {
  ts: string;    // ISO timestamp
  step: string;
  status: "running" | "done" | "error";
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the task folder path, e.g. `.pi/tasks/001-refactor-auth`
 */
export function taskDir(cwd: string, id: string, name: string): string {
  return join(cwd, ".pi", "tasks", `${id}-${name}`);
}

function statusPath(cwd: string, id: string, name: string): string {
  return join(taskDir(cwd, id, name), "status.json");
}

function progressPath(cwd: string, id: string, name: string): string {
  return join(taskDir(cwd, id, name), "progress.jsonl");
}

// ── task.md template ──────────────────────────────────────────────────────────

function renderTaskMd(spec: TaskSpec): string {
  const depsList =
    spec.depends.length === 0
      ? "None"
      : spec.depends.map((d) => `- ${d}`).join("\n");

  return `# Task: ${spec.name}

## Configuration
- **engine**: ${spec.engine}
- **model**: ${spec.model}
- **agent**: ${spec.agent}

## Dependencies
${depsList}

## Requirements
${spec.description}

## Progress Tracking
Append to \`progress.jsonl\` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Creates the task folder, writes task.md, initial status.json, and empty
 * progress.jsonl / output.jsonl files.
 */
export async function createTaskFolder(cwd: string, spec: TaskSpec): Promise<void> {
  const dir = taskDir(cwd, spec.id, spec.slug);
  await mkdir(dir, { recursive: true });

  // Write task.md
  await writeFile(join(dir, "task.md"), renderTaskMd(spec), "utf-8");

  // Write initial status.json
  const initialState: TaskState = {
    id: spec.id,
    name: spec.slug,
    status: "pending",
    engine: spec.engine,
    model: spec.model,
    agent: spec.agent,
    depends: spec.depends,
    startedAt: null,
    completedAt: null,
    duration: null,
    retries: 0,
    pid: null,
    error: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
  await writeFile(join(dir, "status.json"), JSON.stringify(initialState, null, 2), "utf-8");

  // Create empty progress.jsonl and output.jsonl
  await writeFile(join(dir, "progress.jsonl"), "", "utf-8");
  await writeFile(join(dir, "output.jsonl"), "", "utf-8");
}

/**
 * Reads status.json for the given task.
 */
export async function readStatus(cwd: string, id: string, name: string): Promise<TaskState> {
  const content = await readFile(statusPath(cwd, id, name), "utf-8");
  return JSON.parse(content) as TaskState;
}

/**
 * Writes status.json atomically (write to .tmp then rename).
 */
export async function writeStatus(cwd: string, state: TaskState): Promise<void> {
  const target = statusPath(cwd, state.id, state.name);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, target);
}

/**
 * Appends one JSONL line to progress.jsonl.
 */
export async function appendProgress(
  cwd: string,
  id: string,
  name: string,
  entry: ProgressEntry,
): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  await appendFile(progressPath(cwd, id, name), line, "utf-8");
}

/**
 * Reads all progress entries from progress.jsonl.
 */
export async function readProgress(
  cwd: string,
  id: string,
  name: string,
): Promise<ProgressEntry[]> {
  let content: string;
  try {
    content = await readFile(progressPath(cwd, id, name), "utf-8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProgressEntry);
}

/**
 * Scans `.pi/tasks/` for folders matching `NNN-*`, reads all status.json files,
 * and returns tasks sorted by id.
 */
export async function listTasks(cwd: string): Promise<TaskState[]> {
  const tasksDir = join(cwd, ".pi", "tasks");

  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return [];
  }

  // Filter folders matching NNN-* pattern
  const taskFolderPattern = /^(\d+)-(.+)$/;
  const taskFolders = entries.filter((e) => taskFolderPattern.test(e));

  const results: TaskState[] = [];

  for (const folder of taskFolders) {
    const match = folder.match(taskFolderPattern);
    if (!match) continue;
    const [, id, name] = match;
    try {
      const state = await readStatus(cwd, id, name);
      results.push(state);
    } catch {
      // Skip folders with missing/corrupt status.json
    }
  }

  // Sort by id (numeric)
  results.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  return results;
}
