// Fleet extension — task-set summaries and archival

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { dirname, join } from "path";

import { parsePlan, type TaskSpec } from "./plan.js";
import { buildAggregateState, readAggregateState } from "./state.js";
import { listTasks, readProgress, type TaskState } from "./task.js";
import type { Usage } from "./engines/types.js";
import type { AttentionHint } from "./attention.js";
import { appendFleetEvent, fleetEventsPath } from "./events.js";
import { readRunMetadata, runMetadataPath, type RunMetadata } from "./run.js";

export interface PlanTaskSummary {
  id: string;
  slug: string;
  name: string;
  engine: string;
  model: string;
  profile?: string;
  thinking?: string;
  agent: string;
  depends: string[];
  description: string;
}

export interface PlanSummary {
  version: 1;
  title: string;
  overview: string | null;
  splitAt: string;
  sourcePlanPath: string;
  taskCount: number;
  tasks: PlanTaskSummary[];
}

export interface ArchiveSummary {
  version: 1;
  summarizedAt: string;
  run: {
    runId: string | null;
    cwd: string | null;
    repoRoot: string | null;
    branch: string | null;
    planPath: string | null;
    startedAt: string | null;
    completedAt: string | null;
    finalStatus: RunMetadata["status"] | "legacy" | "unknown";
  };
  plan: {
    title: string;
    overview: string | null;
    splitAt: string | null;
    taskCount: number;
  } | null;
  summary: {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
    retrying: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationInputTokens: number;
    totalCacheReadInputTokens: number;
    totalTokens: number;
  };
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  };
  attention: {
    total: number;
    bySeverity: Record<AttentionHint["severity"], number>;
    byCategory: Record<string, number>;
  };
  artifacts: {
    run: {
      sourcePath: string;
      archivePath: string | null;
      copied: boolean;
    };
    events: {
      sourcePath: string;
      archivePath: string | null;
      copied: boolean;
    };
  };
  tasks: Array<{
    id: string;
    name: string;
    agent: string;
    engine: string;
    model: string;
    profile?: string;
    thinking?: string;
    status: TaskState["status"];
    depends: string[];
    retries: number;
    startedAt: string | null;
    completedAt: string | null;
    duration: number | null;
    error: string | null;
    progressEntries: number;
    lastProgress: string | null;
    usage: Usage;
  }>;
}

export interface ArchiveIndexEntry {
  id: string;
  archivedAt: string;
  reason: "split-stale" | "manual";
  title: string;
  taskCount: number;
  archivePath: string;
  taskFolders: string[];
  run: ArchiveSummary["run"];
  summary: ArchiveSummary["summary"];
  totalUsage: ArchiveSummary["totalUsage"];
  attention: ArchiveSummary["attention"];
  artifacts: ArchiveSummary["artifacts"];
}

interface ArchiveIndex {
  version: 1;
  archives: ArchiveIndexEntry[];
}

function tasksRoot(cwd: string): string {
  return join(cwd, ".pi", "tasks");
}

function archiveRoot(cwd: string): string {
  return join(cwd, ".pi", "archive");
}

function planSummaryPath(cwd: string): string {
  return join(tasksRoot(cwd), "plan-summary.json");
}

function archiveSummaryPath(cwd: string): string {
  return join(tasksRoot(cwd), "archive-summary.json");
}

function archiveIndexPath(cwd: string): string {
  return join(archiveRoot(cwd), "index.json");
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await rename(tmp, target);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  try {
    await stat(source);
  } catch {
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

function maxIsoTimestamp(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (present.length === 0) return null;
  return present.sort((a, b) => a.localeCompare(b)).at(-1) ?? null;
}

function summarizeAttention(hints: AttentionHint[]): ArchiveSummary["attention"] {
  const bySeverity: Record<AttentionHint["severity"], number> = {
    info: 0,
    warning: 0,
    error: 0,
  };
  const byCategory: Record<string, number> = {};

  for (const hint of hints) {
    bySeverity[hint.severity] = (bySeverity[hint.severity] ?? 0) + 1;
    byCategory[hint.category] = (byCategory[hint.category] ?? 0) + 1;
  }

  return {
    total: hints.length,
    bySeverity,
    byCategory,
  };
}

function totalUsageFromSummary(summary: ArchiveSummary["summary"]): ArchiveSummary["totalUsage"] {
  return {
    inputTokens: summary.totalInputTokens,
    outputTokens: summary.totalOutputTokens,
    cacheCreationInputTokens: summary.totalCacheCreationInputTokens,
    cacheReadInputTokens: summary.totalCacheReadInputTokens,
    totalTokens: summary.totalTokens,
  };
}

function inferFinalStatus(run: RunMetadata | null, aggregate: ReturnType<typeof buildAggregateState>): ArchiveSummary["run"]["finalStatus"] {
  if (run?.status) return run.status;
  if (aggregate.summary.failed > 0) return "failed";
  if (aggregate.summary.total > 0 && aggregate.summary.done === aggregate.summary.total) return "done";
  return run ? "unknown" : "legacy";
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "plan";
}

function timestampSegment(ts: string): string {
  return ts.replace(/[:.]/g, "-");
}

function extractPlanTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || "Plan";
}

function extractOverview(content: string): string | null {
  const headingMatch = content.match(/^##\s+Overview\s*$/m);
  if (!headingMatch || headingMatch.index === undefined) return null;

  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length);
  const nextTopLevelHeading = afterHeading.match(/^##\s+/m);
  const text = (nextTopLevelHeading ? afterHeading.slice(0, nextTopLevelHeading.index) : afterHeading).trim();
  return text.length > 0 ? text : null;
}

function toPlanTaskSummary(spec: TaskSpec): PlanTaskSummary {
  return {
    id: spec.id,
    slug: spec.slug,
    name: spec.name,
    engine: spec.engine,
    model: spec.model,
    profile: spec.profile,
    thinking: spec.thinking,
    agent: spec.agent,
    depends: [...spec.depends],
    description: spec.description,
  };
}

export async function writePlanSummary(cwd: string, planPath = "PLAN.md", tasksOverride?: TaskSpec[]): Promise<PlanSummary> {
  const resolved = join(cwd, planPath);
  const content = await readFile(resolved, "utf-8");
  const tasks = tasksOverride ?? parsePlan(content);

  const summary: PlanSummary = {
    version: 1,
    title: extractPlanTitle(content),
    overview: extractOverview(content),
    splitAt: new Date().toISOString(),
    sourcePlanPath: planPath,
    taskCount: tasks.length,
    tasks: tasks.map(toPlanTaskSummary),
  };

  await mkdir(tasksRoot(cwd), { recursive: true });
  await writeJsonAtomic(planSummaryPath(cwd), summary);
  return summary;
}

export async function readPlanSummary(cwd: string): Promise<PlanSummary | null> {
  return readJsonFile<PlanSummary>(planSummaryPath(cwd));
}

export async function writeArchiveSummary(cwd: string): Promise<ArchiveSummary> {
  const tasks = await listTasks(cwd);
  const progressMap = new Map<string, Awaited<ReturnType<typeof readProgress>>>();

  for (const task of tasks) {
    const progress = await readProgress(cwd, task.id, task.name);
    progressMap.set(`${task.id}-${task.name}`, progress);
  }

  const aggregate = buildAggregateState(tasks, progressMap);
  const planSummary = await readPlanSummary(cwd);
  const run = await readRunMetadata(cwd);
  const persistedState = await readAggregateState(cwd);
  const attention = summarizeAttention(persistedState?.attentionHints ?? aggregate.attentionHints);
  const stateById = new Map(tasks.map((task) => [task.id, task]));
  const completedAt = maxIsoTimestamp(tasks.map((task) => task.completedAt));

  const summary: ArchiveSummary = {
    version: 1,
    summarizedAt: new Date().toISOString(),
    run: {
      runId: run?.runId ?? null,
      cwd: run?.cwd ?? null,
      repoRoot: run?.git.repoRoot ?? null,
      branch: run?.git.branch ?? null,
      planPath: run?.planPath ?? planSummary?.sourcePlanPath ?? null,
      startedAt: run?.startedAt ?? null,
      completedAt,
      finalStatus: inferFinalStatus(run, aggregate),
    },
    plan: planSummary
      ? {
          title: planSummary.title,
          overview: planSummary.overview,
          splitAt: planSummary.splitAt,
          taskCount: planSummary.taskCount,
        }
      : null,
    summary: aggregate.summary,
    totalUsage: totalUsageFromSummary(aggregate.summary),
    attention,
    artifacts: {
      run: {
        sourcePath: ".pi/tasks/run.json",
        archivePath: null,
        copied: false,
      },
      events: {
        sourcePath: ".pi/tasks/events.jsonl",
        archivePath: null,
        copied: false,
      },
    },
    tasks: aggregate.tasks.map((task) => {
      const full = stateById.get(task.id);
      const progress = progressMap.get(`${task.id}-${task.name}`) ?? [];
      return {
        id: task.id,
        name: task.name,
        agent: task.agent,
        engine: task.engine,
        model: task.model,
        profile: full?.profile,
        thinking: full?.thinking,
        status: task.status,
        depends: full?.depends ?? [],
        retries: full?.retries ?? 0,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        duration: full?.duration ?? null,
        error: full?.error ?? null,
        progressEntries: progress.length,
        lastProgress: task.lastProgress,
        usage: { ...task.usage },
      };
    }),
  };

  await mkdir(tasksRoot(cwd), { recursive: true });
  await writeJsonAtomic(archiveSummaryPath(cwd), summary);
  return summary;
}

export async function clearActiveTaskSummaries(cwd: string): Promise<void> {
  await removeIfExists(planSummaryPath(cwd));
  await removeIfExists(archiveSummaryPath(cwd));
}

export async function listTaskFolders(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(tasksRoot(cwd), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+-.+/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

export async function removeTaskFolders(cwd: string, folders: string[]): Promise<void> {
  for (const folder of folders) {
    await removeIfExists(join(tasksRoot(cwd), folder));
  }
}

async function updateArchiveIndex(cwd: string, entry: ArchiveIndexEntry): Promise<void> {
  await mkdir(archiveRoot(cwd), { recursive: true });
  const current = (await readJsonFile<ArchiveIndex>(archiveIndexPath(cwd))) ?? {
    version: 1,
    archives: [],
  };
  current.archives.push(entry);
  current.archives.sort((a, b) => a.archivedAt.localeCompare(b.archivedAt));
  await writeJsonAtomic(archiveIndexPath(cwd), current);
}

export async function archiveTaskFolders(
  cwd: string,
  folders: string[],
  reason: "split-stale" | "manual",
): Promise<ArchiveIndexEntry> {
  const planSummary = await readPlanSummary(cwd);
  const archiveSummary = await writeArchiveSummary(cwd);
  const archivedAt = new Date().toISOString();
  const archiveId = `${timestampSegment(archivedAt)}-${slugifySegment(planSummary?.title ?? "fleet-history")}`;
  const archivePath = join(archiveRoot(cwd), archiveId);

  await mkdir(join(archivePath, "tasks"), { recursive: true });

  await copyIfExists(planSummaryPath(cwd), join(archivePath, "plan-summary.json"));
  const copiedRun = await copyIfExists(runMetadataPath(cwd), join(archivePath, "run.json"));
  const copiedEvents = await copyIfExists(fleetEventsPath(cwd), join(archivePath, "events.jsonl"));
  archiveSummary.artifacts = {
    run: {
      sourcePath: ".pi/tasks/run.json",
      archivePath: copiedRun ? `.pi/archive/${archiveId}/run.json` : null,
      copied: copiedRun,
    },
    events: {
      sourcePath: ".pi/tasks/events.jsonl",
      archivePath: copiedEvents ? `.pi/archive/${archiveId}/events.jsonl` : null,
      copied: copiedEvents,
    },
  };
  await writeJsonAtomic(archiveSummaryPath(cwd), archiveSummary);
  await copyIfExists(archiveSummaryPath(cwd), join(archivePath, "archive-summary.json"));
  await copyIfExists(join(tasksRoot(cwd), "state.json"), join(archivePath, "state.json"));
  await copyIfExists(join(tasksRoot(cwd), "config.json"), join(archivePath, "config.json"));

  for (const folder of folders) {
    const sourceDir = join(tasksRoot(cwd), folder);
    const targetDir = join(archivePath, "tasks", folder);
    await mkdir(targetDir, { recursive: true });
    await copyIfExists(join(sourceDir, "task.md"), join(targetDir, "task.md"));
    await copyIfExists(join(sourceDir, "status.json"), join(targetDir, "status.json"));
    await copyIfExists(join(sourceDir, "progress.jsonl"), join(targetDir, "progress.jsonl"));
    await copyIfExists(join(sourceDir, "recovery.md"), join(targetDir, "recovery.md"));
  }

  const entry: ArchiveIndexEntry = {
    id: archiveId,
    archivedAt,
    reason,
    title: planSummary?.title ?? "Fleet task archive",
    taskCount: folders.length,
    archivePath: `.pi/archive/${archiveId}`,
    taskFolders: [...folders],
    run: archiveSummary.run,
    summary: archiveSummary.summary,
    totalUsage: archiveSummary.totalUsage,
    attention: archiveSummary.attention,
    artifacts: archiveSummary.artifacts,
  };

  await writeJsonAtomic(join(archivePath, "archive-entry.json"), entry);
  await updateArchiveIndex(cwd, entry);
  await appendFleetEvent(cwd, {
    type: "archive_created",
    data: {
      archiveId,
      reason,
      taskCount: folders.length,
      archivePath: entry.archivePath,
    },
  }).catch((error) => {
    console.warn("[fleet/events] Failed to append archive event:", error);
  });
  await removeTaskFolders(cwd, folders);

  return entry;
}
