// Fleet extension — PLAN.md parsing, dependency validation

import { readFile } from "fs/promises";
import { join } from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaskSpec {
  id: string;          // e.g. "001"
  slug: string;        // e.g. "refactor-auth"
  name: string;        // e.g. "Refactor auth middleware"
  engine: string;      // e.g. "claude"
  model: string;       // e.g. "sonnet"
  agent: string;       // e.g. "worker"
  depends: string[];   // e.g. ["001", "002"]
  description: string; // full description text
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
    .replace(/[^\w\s-]/g, "")   // strip non-word chars (except hyphens)
    .replace(/[\s_]+/g, "-")    // spaces/underscores → hyphens
    .replace(/-+/g, "-")        // collapse multiple hyphens
    .replace(/^-|-$/g, "");     // trim leading/trailing hyphens
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
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
 *   - **model**: sonnet
 *   - **agent**: worker
 *   - **depends**: none
 *   - **description**: Full description text that may
 *     continue on subsequent indented lines.
 */
export function parsePlan(content: string): TaskSpec[] {
  // ── 1. Isolate the ## Tasks section ──────────────────────────────
  const tasksSectionMatch = content.match(/^##\s+Tasks\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  const tasksSection = tasksSectionMatch ? tasksSectionMatch[1] : content;

  // ── 2. Split by task headings ─────────────────────────────────────
  // Pattern: ### Task NNN: Name
  const taskBlockRegex = /^###\s+Task\s+(\d+)\s*:\s*(.+)$/m;
  const parts = tasksSection.split(/^(?=###\s+Task\s+\d+\s*:)/m);

  const tasks: TaskSpec[] = [];

  for (const part of parts) {
    const headingMatch = part.match(/^###\s+Task\s+(\d+)\s*:\s*(.+)/);
    if (!headingMatch) continue;

    const id = headingMatch[1].trim();
    const name = headingMatch[2].trim();
    const slug = slugify(name);

    // ── 3. Parse field lines ────────────────────────────────────────
    // Collect all lines after the heading
    const bodyLines = part.split("\n").slice(1);

    const fields: Record<string, string> = {};
    let currentField: string | null = null;
    let descriptionLines: string[] = [];

    for (const line of bodyLines) {
      // Match `- **field**: value`
      const fieldMatch = line.match(/^-\s+\*\*(\w+)\*\*\s*:\s*(.*)/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1].toLowerCase();
        const fieldValue = fieldMatch[2].trim();
        currentField = fieldName;
        if (fieldName === "description") {
          descriptionLines = fieldValue ? [fieldValue] : [];
        } else {
          fields[fieldName] = fieldValue;
        }
        continue;
      }

      // Continuation lines for description (indented or blank inside block)
      if (currentField === "description") {
        // Blank lines end the description block if followed by a new field
        // For now: accumulate indented continuation lines
        const stripped = line.trimEnd();
        if (/^\s{1,}/.test(stripped) || stripped === "") {
          // Continuation indent (2+ spaces) or blank line — part of description
          descriptionLines.push(stripped.trimStart());
        } else if (/^-\s+\*\*/.test(stripped)) {
          // New field — handled by next iteration
          currentField = null;
        }
      }
    }

    // Build description from collected lines, trimming trailing blanks
    let description = descriptionLines
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const task: TaskSpec = {
      id,
      slug,
      name,
      engine: fields["engine"] ?? "",
      model: fields["model"] ?? "",
      agent: fields["agent"] ?? "",
      depends: parseDepends(fields["depends"] ?? "none"),
      description,
    };

    tasks.push(task);
  }

  // Suppress unused variable warning for taskBlockRegex
  void taskBlockRegex;

  return tasks;
}

/**
 * Read `.pi/tasks/PLAN.md` from the given working directory and parse it.
 */
export async function loadPlan(cwd: string, planPath?: string): Promise<TaskSpec[]> {
  const resolvedPath = planPath ?? join(cwd, "PLAN.md");
  const content = await readFile(resolvedPath, "utf-8");
  return parsePlan(content);
}

/**
 * Validate that:
 * 1. All dependency IDs reference tasks that exist in the list.
 * 2. There are no circular dependencies.
 *
 * Throws a descriptive Error on the first problem found.
 */
export function validateDependencies(tasks: TaskSpec[]): void {
  const idSet = new Set(tasks.map((t) => t.id));

  // ── 1. Check all dependency IDs exist ─────────────────────────────
  for (const task of tasks) {
    for (const dep of task.depends) {
      if (!idSet.has(dep)) {
        throw new Error(
          `Task ${task.id} ("${task.name}") depends on "${dep}" which does not exist.`,
        );
      }
    }
  }

  // ── 2. Detect cycles via DFS ───────────────────────────────────────
  // Build adjacency map: task.id → depends[]
  const adj = new Map<string, string[]>(tasks.map((t) => [t.id, t.depends]));

  // Three-color DFS: white (0) = unvisited, grey (1) = in stack, black (2) = done
  const color = new Map<string, 0 | 1 | 2>();
  for (const id of idSet) color.set(id, 0);

  function dfs(id: string, stack: string[]): void {
    color.set(id, 1);
    stack.push(id);
    for (const dep of adj.get(id) ?? []) {
      if (color.get(dep) === 1) {
        // Back edge — cycle found
        const cycleStart = stack.indexOf(dep);
        const cycle = [...stack.slice(cycleStart), dep].join(" → ");
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
