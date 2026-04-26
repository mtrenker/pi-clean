// Fleet extension — PLAN.md parsing, rendering, and validation

import { readFile } from "fs/promises";
import { join } from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaskSpec {
  id: string;          // e.g. "001"
  slug: string;        // e.g. "refactor-auth"
  name: string;        // e.g. "Refactor auth middleware"
  engine: string;      // e.g. "claude"
  model: string;       // optional model override from PLAN.md; may be empty before split-time resolution
  profile?: string;    // optional execution profile alias, e.g. "balanced"
  thinking?: string;   // engine-native thinking/effort after resolution
  agent: string;       // e.g. "worker"
  depends: string[];   // e.g. ["001", "002"]
  description: string; // full description text
}

export interface PlanDocument {
  title: string;
  overview: string;
  tasks: TaskSpec[];
}

export interface LoadedValidatedPlan {
  planPath: string;
  sourceContent: string;
  normalizedContent: string;
  document: PlanDocument;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Convert a task name into a URL-friendly slug.
 * e.g. "Refactor Auth Middleware" → "refactor-auth-middleware"
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parse the `depends` field value into an array of task IDs.
 * "none"       → []
 * "001"        → ["001"]
 * "001, 002"   → ["001", "002"]
 */
function parseDepends(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(content: string, heading: string): string {
  const headingRegex = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "m");
  const match = content.match(headingRegex);
  if (!match || match.index === undefined) return "";

  const afterHeading = content.slice(match.index + match[0].length);
  const nextTopLevelHeading = afterHeading.match(/^##\s+/m);
  const section = nextTopLevelHeading
    ? afterHeading.slice(0, nextTopLevelHeading.index)
    : afterHeading;

  return section.trim();
}

function parseTaskBlock(rawId: string, rawName: string, body: string): TaskSpec {
  const fields: Record<string, string> = {};
  let currentField: string | null = null;

  const lines = body.split("\n");
  for (const line of lines) {
    const fieldMatch = line.match(/^-\s+\*\*([A-Za-z][\w-]*)\*\*\s*:\s*(.*)$/);
    if (fieldMatch) {
      currentField = fieldMatch[1].toLowerCase();
      fields[currentField] = fieldMatch[2].trim();
      continue;
    }

    if (currentField && /^\s+/.test(line)) {
      const continuation = line.trim();
      if (continuation) {
        fields[currentField] = `${fields[currentField] ?? ""} ${continuation}`.trim();
      }
      continue;
    }

    if (line.trim() === "") {
      continue;
    }

    currentField = null;
  }

  const id = rawId.trim();
  const name = rawName.trim();

  return {
    id,
    slug: slugify(name),
    name,
    engine: normalizeWhitespace(fields.engine ?? ""),
    model: normalizeWhitespace(fields.model ?? ""),
    profile: fields.profile ? normalizeWhitespace(fields.profile) : undefined,
    thinking: fields.thinking ? normalizeWhitespace(fields.thinking) : undefined,
    agent: normalizeWhitespace(fields.agent ?? ""),
    depends: parseDepends(fields.depends ?? "none"),
    description: normalizeWhitespace(fields.description ?? ""),
  };
}

function sentenceCount(value: string): number {
  const matches = value.match(/[.!?](?=\s|$)/g);
  return matches ? matches.length : 0;
}

function looksVague(description: string): boolean {
  return [
    /\b(tbd|todo|placeholder)\b/i,
    /\b(as needed|etc\.?|and so on|various things|misc(?:ellaneous)?)\b/i,
    /^(implement|build|fix|update|refactor|handle|work on)\b\.?$/i,
  ].some((pattern) => pattern.test(description));
}

function mentionsConcreteSurface(description: string): boolean {
  return (
    /`[^`]+`/.test(description) ||
    /\b[\w./-]+\.(ts|tsx|js|jsx|json|md|ya?ml|sql|sh)\b/i.test(description) ||
    /\b(module|service|component|endpoint|schema|table|workflow|pipeline|api|cli|class|function|extension)\b/i.test(description)
  );
}

function hasAcceptanceLanguage(description: string): boolean {
  return /\b(acceptance|definition of done|done when|verify|verified|validation|tests?|must pass|should pass|success when)\b/i.test(
    description,
  );
}

function referencesDependencyOutputs(description: string, depends: string[]): boolean {
  if (depends.length === 0) return true;

  const mentionsDependencyId = depends.some((dep) => {
    const patterns = [
      new RegExp(`\\b${escapeRegex(dep)}\\b`),
      new RegExp(`\\btask\\s+${escapeRegex(dep)}\\b`, "i"),
    ];
    return patterns.some((pattern) => pattern.test(description));
  });

  if (!mentionsDependencyId) return false;

  return /\b(use|reuse|build on|based on|consume|apply|carry forward|take as input|using the output|using output|using findings|using context|upstream|artifact|handoff|from task)\b/i.test(
    description,
  );
}

function compareTaskId(a: TaskSpec, b: TaskSpec): number {
  const an = Number.parseInt(a.id, 10);
  const bn = Number.parseInt(b.id, 10);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
    return an - bn;
  }
  return a.id.localeCompare(b.id);
}

function orderTasksByDependencies(tasks: TaskSpec[]): TaskSpec[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    indegree.set(task.id, 0);
    adjacency.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.depends) {
      if (!byId.has(dep)) continue;
      adjacency.get(dep)!.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = [...tasks]
    .filter((task) => (indegree.get(task.id) ?? 0) === 0)
    .sort(compareTaskId)
    .map((task) => task.id);

  const orderedIds: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    orderedIds.push(id);
    const next = adjacency.get(id) ?? [];
    for (const childId of next) {
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) {
        queue.push(childId);
      }
    }
    queue.sort((left, right) => compareTaskId(byId.get(left)!, byId.get(right)!));
  }

  if (orderedIds.length !== tasks.length) {
    return [...tasks].sort(compareTaskId);
  }

  return orderedIds.map((id) => byId.get(id)!);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse PLAN.md content into an array of TaskSpec objects.
 *
 * Expected format inside a `## Tasks` section:
 *
 *   ### Task 001: Name of task
 *
 *   - **engine**: claude
 *   - **profile**: balanced
 *   - **model**: sonnet
 *   - **thinking**: high
 *   - **agent**: worker
 *   - **depends**: none
 *   - **description**: Full description text that may
 *     continue on subsequent indented lines.
 */
export function parsePlan(content: string): TaskSpec[] {
  const tasksSection = extractSection(content, "Tasks");
  if (!tasksSection) return [];

  const headingRegex = /^###\s+Task\s+([^:\s]+)\s*:\s*(.+)$/gm;
  const matches = [...tasksSection.matchAll(headingRegex)];
  if (matches.length === 0) return [];

  const tasks: TaskSpec[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const next = matches[index + 1];

    const headingStart = match.index ?? 0;
    const bodyStart = headingStart + match[0].length;
    const bodyEnd = next?.index ?? tasksSection.length;
    const body = tasksSection.slice(bodyStart, bodyEnd).trimEnd();

    const rawId = match[1] ?? "";
    const rawName = match[2] ?? "";
    tasks.push(parseTaskBlock(rawId, rawName, body));
  }

  return tasks;
}

export function parsePlanDocument(content: string): PlanDocument {
  const titleMatch = content.match(/^#\s*Plan\s*:\s*(.+)$/m);
  return {
    title: normalizeWhitespace(titleMatch?.[1] ?? ""),
    overview: extractSection(content, "Overview"),
    tasks: parsePlan(content),
  };
}

export function renderPlanDocument(document: PlanDocument): string {
  const title = document.title.trim() || "Untitled Plan";
  const overview = document.overview.trim();
  const tasks = orderTasksByDependencies(document.tasks);

  const taskBlocks = tasks.map((task) => {
    const lines = [
      `### Task ${task.id}: ${task.name}`,
      "",
      `- **engine**: ${task.engine}`,
    ];

    if (task.profile) lines.push(`- **profile**: ${task.profile}`);
    if (task.model) lines.push(`- **model**: ${task.model}`);
    if (task.thinking) lines.push(`- **thinking**: ${task.thinking}`);
    lines.push(`- **agent**: ${task.agent}`);
    lines.push(`- **depends**: ${task.depends.length === 0 ? "none" : task.depends.join(", ")}`);
    lines.push(`- **description**: ${normalizeWhitespace(task.description)}`);

    return lines.join("\n");
  });

  const sections = [
    `# Plan: ${title}`,
    "",
    "## Overview",
    "",
    overview || "Overview unavailable.",
    "",
    "## Tasks",
    "",
    taskBlocks.join("\n\n"),
    "",
  ];

  return sections.join("\n");
}

/**
 * Read PLAN.md from the given working directory and parse it.
 */
export async function loadPlan(cwd: string, planPath?: string): Promise<TaskSpec[]> {
  const resolvedPath = planPath ? join(cwd, planPath) : join(cwd, "PLAN.md");
  const content = await readFile(resolvedPath, "utf-8");
  return parsePlan(content);
}

/**
 * Validate a parsed plan document for structure, clarity, and dependency hygiene.
 * Throws a single Error containing all detected issues.
 */
export function validatePlanDocument(document: PlanDocument): void {
  const errors: string[] = [];
  const { title, overview, tasks } = document;

  if (!title) {
    errors.push(`Missing or empty '# Plan: <title>' header.`);
  }

  const overviewWords = overview.trim().split(/\s+/).filter(Boolean).length;
  if (!overview.trim()) {
    errors.push("Missing '## Overview' section content.");
  } else {
    if (overviewWords < 40) {
      errors.push("Overview is too short; provide enough context for independent execution (>= 40 words).");
    }
    if (sentenceCount(overview) < 2) {
      errors.push("Overview should contain at least 2 sentences.");
    }
  }

  if (tasks.length === 0) {
    errors.push("No tasks found under '## Tasks'. Expected one or more '### Task NNN: <name>' sections.");
  }

  const idToTask = new Map<string, TaskSpec>();
  for (const task of tasks) {
    if (!/^\d{3}$/.test(task.id)) {
      errors.push(`Task ID '${task.id}' must be a zero-padded 3-digit number (e.g. 001).`);
    }
    if (idToTask.has(task.id)) {
      errors.push(`Duplicate task ID '${task.id}'.`);
    }
    idToTask.set(task.id, task);
  }

  for (const task of tasks) {
    const prefix = `Task ${task.id} (\"${task.name}\")`;

    if (!task.name.trim()) {
      errors.push(`${prefix}: missing task name.`);
    }
    if (!task.engine.trim()) {
      errors.push(`${prefix}: missing required field 'engine'.`);
    }
    if (!task.agent.trim()) {
      errors.push(`${prefix}: missing required field 'agent'.`);
    }

    const depSet = new Set<string>();
    for (const dep of task.depends) {
      if (depSet.has(dep)) {
        errors.push(`${prefix}: duplicate dependency '${dep}'.`);
      }
      depSet.add(dep);

      if (dep === task.id) {
        errors.push(`${prefix}: cannot depend on itself.`);
      }
      if (!/^\d{3}$/.test(dep)) {
        errors.push(`${prefix}: dependency '${dep}' must be a zero-padded 3-digit task ID.`);
      }
      if (!idToTask.has(dep)) {
        errors.push(`${prefix}: dependency '${dep}' does not exist.`);
      }
    }

    if (!task.description.trim()) {
      errors.push(`${prefix}: missing description.`);
      continue;
    }

    if (task.description.length < 80) {
      errors.push(`${prefix}: description is too short; provide implementation details and acceptance criteria.`);
    }

    if (sentenceCount(task.description) < 2) {
      errors.push(`${prefix}: description should be at least 2 sentences.`);
    }

    if (looksVague(task.description)) {
      errors.push(`${prefix}: description is too vague; replace placeholders/generic wording with concrete actions.`);
    }

    if (!mentionsConcreteSurface(task.description)) {
      errors.push(`${prefix}: description should name concrete files/modules/systems to touch.`);
    }

    if (!hasAcceptanceLanguage(task.description)) {
      errors.push(`${prefix}: description should include explicit acceptance criteria or test/verification language.`);
    }

    if (!referencesDependencyOutputs(task.description, task.depends)) {
      errors.push(
        `${prefix}: description must explain how it uses upstream dependency outputs and reference at least one dependency ID explicitly.`,
      );
    }
  }

  // Existing dependency checks (missing IDs + cycles).
  try {
    validateDependencies(tasks);
  } catch (error) {
    errors.push((error as Error).message);
  }

  // Ensure declared dependency ordering is executable as listed.
  const indexById = new Map(tasks.map((task, index) => [task.id, index]));
  for (const task of tasks) {
    for (const dep of task.depends) {
      const depIndex = indexById.get(dep);
      const taskIndex = indexById.get(task.id);
      if (depIndex === undefined || taskIndex === undefined) continue;
      if (depIndex > taskIndex) {
        errors.push(
          `Task ${task.id} depends on ${dep}, but appears before it in PLAN.md. Reorder tasks so dependencies come first.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`PLAN.md validation failed:\n- ${errors.join("\n- ")}`);
  }
}

/**
 * Parse + validate + normalize plan markdown into canonical fleet format.
 */
export function normalizePlanMarkdown(content: string): string {
  const document = parsePlanDocument(content);
  validatePlanDocument(document);
  return renderPlanDocument(document);
}

/**
 * Read, validate, and normalize PLAN.md from disk.
 */
export async function loadValidatedPlan(cwd: string, planPath?: string): Promise<LoadedValidatedPlan> {
  const resolvedPath = planPath ? join(cwd, planPath) : join(cwd, "PLAN.md");
  const sourceContent = await readFile(resolvedPath, "utf-8");
  const document = parsePlanDocument(sourceContent);
  validatePlanDocument(document);
  const normalizedContent = renderPlanDocument(document);

  return {
    planPath: resolvedPath,
    sourceContent,
    normalizedContent,
    document: {
      ...document,
      tasks: orderTasksByDependencies(document.tasks),
    },
  };
}

/**
 * Validate that:
 * 1. All dependency IDs reference tasks that exist in the list.
 * 2. There are no circular dependencies.
 *
 * Throws a descriptive Error on the first problem found.
 */
export function validateDependencies(tasks: TaskSpec[]): void {
  const idSet = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    for (const dep of task.depends) {
      if (!idSet.has(dep)) {
        throw new Error(
          `Task ${task.id} (\"${task.name}\") depends on \"${dep}\" which does not exist.`,
        );
      }
    }
  }

  const adjacency = new Map<string, string[]>(tasks.map((task) => [task.id, task.depends]));
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of idSet) color.set(id, 0);

  function dfs(id: string, stack: string[]): void {
    color.set(id, 1);
    stack.push(id);

    for (const dep of adjacency.get(id) ?? []) {
      if (color.get(dep) === 1) {
        const cycleStart = stack.indexOf(dep);
        const cycle = [...stack.slice(cycleStart), dep].join(" -> ");
        throw new Error(`Circular dependency detected: ${cycle}`);
      }
      if (color.get(dep) === 0) {
        dfs(dep, stack);
      }
    }

    stack.pop();
    color.set(id, 2);
  }

  for (const task of tasks) {
    if (color.get(task.id) === 0) {
      dfs(task.id, []);
    }
  }
}
