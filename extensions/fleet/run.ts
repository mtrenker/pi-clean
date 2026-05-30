// Fleet extension — run metadata (run.json)
//
// Writes `.pi/tasks/run.json` at fleet startup with schema-versioned metadata
// about the current run: identity, config sources, git context, and concurrency.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitContext } from "./git-context.js";
import { captureGitContext } from "./git-context.js";
import type { LoadConfigResult } from "./config.js";

// ── Schema ────────────────────────────────────────────────────────────────────

export const RUN_SCHEMA_VERSION = 1;

export type RunStatus = "running" | "done" | "failed";

export interface ConfigSourceLayer {
  /** Human-readable label: "built-in", user config path, or project config path. */
  label: string;
  /** Whether this layer was actually present on disk (false for built-in). */
  present: boolean;
}

export interface RunMetadata {
  /** Monotonically-increasing schema version for forward-compat guards. */
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  /** UUID v4 uniquely identifying this run. */
  runId: string;
  /** ISO 8601 timestamp of when the run was initiated. */
  startedAt: string;
  /** Overall run status. Set to "running" on write; updated to "done"/"failed" at completion. */
  status: RunStatus;
  /** Absolute path to the working directory from which fleet was launched. */
  cwd: string;
  /** Path to PLAN.md (as configured; may be relative). */
  planPath: string;
  /** Ordered config source layers that produced the effective FleetConfig. */
  configSources: ConfigSourceLayer[];
  /** Effective concurrency limit used for this run. */
  concurrency: number;
  /** Best-effort git project context. All fields null when git is unavailable. */
  git: GitContext;
}

// ── Path helper ───────────────────────────────────────────────────────────────

export function runMetadataPath(cwd: string): string {
  return join(cwd, ".pi", "tasks", "run.json");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write `.pi/tasks/run.json` atomically.
 */
export async function writeRunMetadata(
  cwd: string,
  metadata: RunMetadata,
): Promise<void> {
  const target = runMetadataPath(cwd);
  await mkdir(join(cwd, ".pi", "tasks"), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
  await rename(tmp, target);
}

/**
 * Read `.pi/tasks/run.json`. Returns null if the file is missing.
 */
export async function readRunMetadata(cwd: string): Promise<RunMetadata | null> {
  try {
    const content = await readFile(runMetadataPath(cwd), "utf-8");
    return JSON.parse(content) as RunMetadata;
  } catch {
    return null;
  }
}

/**
 * Capture git context, build initial `RunMetadata`, write `run.json`, and
 * return the metadata object.
 *
 * If git is unavailable all git fields are null and a console warning is emitted
 * — fleet startup is NOT blocked.
 *
 * @param cwd         Working directory of the fleet run.
 * @param configResult The full result from `loadConfigWithStatus(cwd)`.
 */
export async function startRunMetadata(
  cwd: string,
  configResult: LoadConfigResult,
): Promise<RunMetadata> {
  const { git, warnings } = await captureGitContext(cwd);

  for (const w of warnings) {
    console.warn(w);
  }

  // Map raw source strings from loadConfigWithStatus to structured layers.
  const configSources: ConfigSourceLayer[] = configResult.sources.map((src) => ({
    label: src,
    present: src !== "built-in",
  }));

  const metadata: RunMetadata = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: "running",
    cwd,
    planPath: configResult.config.planPath,
    configSources,
    concurrency: configResult.config.concurrency,
    git,
  };

  await writeRunMetadata(cwd, metadata);
  return metadata;
}

/**
 * Update the status field of an existing `run.json` atomically.
 * Silently ignores missing files (run.json may not exist in legacy runs).
 */
export async function updateRunStatus(
  cwd: string,
  status: RunStatus,
): Promise<void> {
  const existing = await readRunMetadata(cwd);
  if (!existing) return;
  await writeRunMetadata(cwd, { ...existing, status });
}
