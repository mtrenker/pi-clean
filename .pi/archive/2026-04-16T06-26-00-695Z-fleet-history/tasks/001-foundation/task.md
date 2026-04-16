# Task 001: Foundation

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: none

## Context

You are implementing the `fleet` extension for `pi`, a coding agent. Fleet orchestrates work across `pi`, `claude`, and `codex` CLI engines. You are working in the repository `/home/martin/dev/pi-clean`.

The extension will live at `extensions/fleet/`. The project uses TypeScript with `@mariozechner/pi-coding-agent` (the pi extension API), `@sinclair/typebox` for schema definitions, and Node.js built-ins. Extensions are loaded via jiti so no compilation step is needed.

This task creates the foundational modules that all other tasks depend on.

## Files to Create

### `extensions/fleet/index.ts`
The extension entry point. Must export a default function `(pi: ExtensionAPI) => void`. For now, register all commands as stubs (they will be implemented in task 007). Register the `fleet_status` tool as a stub too. Import and re-export the types other modules need.

Commands to register (all as stubs that call `ctx.ui.notify("not yet implemented", "info")`):
- `/fleet:groom`
- `/fleet:split`
- `/fleet:start`
- `/fleet:stop`
- `/fleet:status`
- `/fleet:retry`
- `/fleet:reset`

### `extensions/fleet/config.ts`
Loads `.pi/tasks/config.json` and provides typed access.

Types to export:
```typescript
export interface AgentConfig {
  prompt: string;
  tools: string[] | null;
}

export interface EngineConfig {
  command: string;
  args: string[];
}

export interface FleetConfig {
  concurrency: number;
  defaults: {
    engine: string;
    model: string;
    agent: string;
  };
  engines: Record<string, EngineConfig>;
  agents: Record<string, AgentConfig>;
}
```

Functions to export:
- `loadConfig(cwd: string): Promise<FleetConfig>` — reads `.pi/tasks/config.json`, merges with hardcoded defaults if file missing
- `resolveAgentPrompt(config: FleetConfig, agentName: string): string` — returns the system prompt for a given agent name, throws if agent not found

Hardcoded defaults (used when config.json is missing):
```json
{
  "concurrency": 2,
  "defaults": { "engine": "claude", "model": "sonnet", "agent": "worker" },
  "engines": {
    "pi": { "command": "pi", "args": ["-p", "--output-format", "stream-json"] },
    "claude": { "command": "claude", "args": ["-p", "--output-format", "stream-json", "--dangerously-skip-permissions"] },
    "codex": { "command": "codex", "args": ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox"] }
  },
  "agents": {
    "worker": { "prompt": "You are a worker agent. Implement the requested changes. Write clean, tested code. Track your progress in progress.jsonl after each significant step.", "tools": null },
    "scout": { "prompt": "You are a scout agent. Your job is read-only reconnaissance. Explore the codebase, gather context, and report your findings. Do NOT modify any files. Write your findings to the task's progress.jsonl.", "tools": ["read","grep","find","ls","bash"] },
    "reviewer": { "prompt": "You are a reviewer agent. Review the changes made by previous tasks. Check for correctness, style, edge cases, and test coverage. Write your review to progress.jsonl.", "tools": ["read","grep","find","ls","bash"] }
  }
}
```

### `extensions/fleet/plan.ts`
Parses `PLAN.md` markdown into typed task specs.

Types to export:
```typescript
export interface TaskSpec {
  id: string;           // e.g. "001"
  slug: string;         // e.g. "refactor-auth"
  name: string;         // e.g. "Refactor auth middleware"
  engine: string;       // e.g. "claude"
  model: string;        // e.g. "sonnet"
  agent: string;        // e.g. "worker"
  depends: string[];    // e.g. ["001", "002"]
  description: string;  // full description text
}
```

Functions to export:
- `parsePlan(content: string): TaskSpec[]` — parses PLAN.md content, extracts tasks from `## Tasks` section. Each `### Task NNN: Name` heading starts a task. Fields are parsed from `- **field**: value` lines. `depends: none` maps to empty array.
- `loadPlan(cwd: string): Promise<TaskSpec[]>` — reads `.pi/tasks/PLAN.md` and calls parsePlan()
- `validateDependencies(tasks: TaskSpec[]): void` — throws if any dependency ID doesn't exist in the task list, or if there are circular dependencies

## Acceptance Criteria
- `extensions/fleet/index.ts` loads in pi without errors (test with `pi -e ./extensions/fleet/index.ts`)
- All 7 commands are registered and respond with "not yet implemented"
- `loadConfig()` returns defaults when `.pi/tasks/config.json` doesn't exist
- `parsePlan()` correctly parses the PLAN.md format described above
- `validateDependencies()` detects missing IDs and cycles
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
