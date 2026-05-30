# Task: Audit pi extension hooks and define the exact guard architecture

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: sonnet
- **thinking**: high
- **agent**: scout

## Dependencies
None

## Requirements
Read `docs/extensions.md` and the example extensions `examples/extensions/tool-override.ts`, `examples/extensions/permission-gate.ts`, `examples/extensions/protected-paths.ts`, and `examples/extensions/sandbox/index.ts`, then create `docs/agent-guard/01-architecture.md` as the canonical handoff artifact for Tasks 002–006. That file must name the planned extension files under `extensions/agent-guard/` (at minimum `index.ts`, `policy.ts`, `env.ts`, `path-guard.ts`, `action-guard.ts`, and `redaction.ts` unless the audit recommends a better split), identify the exact hooks to use for environment filtering, path checks, command blocking, output redaction, and status UI, and clearly separate `secretGuard` behavior from `actionGuard` behavior. Acceptance: `docs/agent-guard/01-architecture.md` exists, lists the exact source files and responsibilities, and is explicit enough that later agents know both what to build and where to look for the design decisions instead of relying on this conversation.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/001-audit-pi-extension-hooks-and-define-the-exact-guard-architecture/task.md`.
- Write progress updates only to `.pi/tasks/001-audit-pi-extension-hooks-and-define-the-exact-guard-architecture/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/001-audit-pi-extension-hooks-and-define-the-exact-guard-architecture/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/001-audit-pi-extension-hooks-and-define-the-exact-guard-architecture/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
