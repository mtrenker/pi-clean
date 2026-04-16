# Task 003: Task & State Management

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: 001

## Context

You are implementing the `fleet` extension for `pi`. Fleet stores all task state as files under `.pi/tasks/` in the project working directory.

Task 001 has already created `extensions/fleet/index.ts`, `extensions/fleet/config.ts` (with `FleetConfig`, `loadConfig()`), and `extensions/fleet/plan.ts` (with `TaskSpec`, `parsePlan()`). Read those files before starting.

This task creates the file management layer: per-task folders with their `status.json`, and the aggregate `state.json`.

## Directory Structure

Each task lives in `.pi/tasks/NNN-slug/`:
```
.pi/tasks/
├── config.json
├── state.json                  ← aggregate, written by state.ts
└── 001-refactor-auth/
    ├── task.md                 ← self-contained agent prompt
    ├── status.json             ← per-task machine-readable state
    ├── progress.jsonl          ← append-only progress entries
    ├── recovery.md             ← written on failure (by recovery.ts)
    └── output.jsonl            ← raw engine output stream
```

## Files to Create

### `extensions/fleet/task.ts`

Types to export:

```typescript
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
```

Functions to export:

- `taskDir(cwd: string, id: string, name: string): string` — returns the task folder path, e.g. `.pi/tasks/001-refactor-auth`
- `createTaskFolder(cwd: string, spec: TaskSpec): Promise<void>` — creates the task folder, writes `task.md` (formatted from spec), writes initial `status.json` with status `"pending"`, creates empty `progress.jsonl` and `output.jsonl`
- `readStatus(cwd: string, id: string, name: string): Promise<TaskState>` — reads `status.json`
- `writeStatus(cwd: string, state: TaskState): Promise<void>` — writes `status.json` atomically (write to `.tmp` then rename)
- `appendProgress(cwd: string, id: string, name: string, entry: ProgressEntry): Promise<void>` — appends one JSONL line to `progress.jsonl`
- `readProgress(cwd: string, id: string, name: string): Promise<ProgressEntry[]>` — reads all progress entries
- `listTasks(cwd: string): Promise<TaskState[]>` — scans `.pi/tasks/` for folders matching `NNN-*`, reads all `status.json` files, returns sorted by id

The `task.md` written by `createTaskFolder` should use this template:
```markdown
# Task: {spec.name}

## Configuration
- **engine**: {spec.engine}
- **model**: {spec.model}
- **agent**: {spec.agent}

## Dependencies
{spec.depends.length === 0 ? "None" : spec.depends.map(d => `- ${d}`).join("\n")}

## Requirements
{spec.description}

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```

### `extensions/fleet/state.ts`

Types to export:

```typescript
export interface AggregateState {
  updatedAt: string;   // ISO timestamp
  tasks: Array<{
    id: string;
    name: string;
    agent: string;
    engine: string;
    model: string;
    status: TaskStatus;
    startedAt: string | null;
    completedAt: string | null;
    lastProgress: string | null;   // last progress entry step text
    blockedBy: string[] | null;    // task IDs blocking this one (if status=pending and deps not done)
    usage: { inputTokens: number; outputTokens: number };
  }>;
  summary: {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
    retrying: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
}
```

Functions to export:

- `buildAggregateState(tasks: TaskState[], progressMap: Map<string, ProgressEntry[]>): AggregateState` — builds the aggregate object from current task states and progress entries. `blockedBy` is set when status is `pending` and some dependencies are not `done`.
- `writeAggregateState(cwd: string, state: AggregateState): Promise<void>` — writes `.pi/tasks/state.json` atomically
- `readAggregateState(cwd: string): Promise<AggregateState | null>` — reads state.json, returns null if missing

## Acceptance Criteria
- `createTaskFolder()` creates the correct directory structure with all files
- `writeStatus()` is atomic (no partial writes)
- `listTasks()` returns tasks sorted by ID
- `buildAggregateState()` correctly computes `blockedBy` and `summary` counts
- `writeAggregateState()` writes atomically
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
