# Task: Implement minimal secret path protection with hard-block and warn-only buckets

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: worker

## Dependencies
- 002

## Requirements
Before coding, read `docs/agent-guard/01-architecture.md` and `extensions/agent-guard/policy.ts`, then implement file-tool path handling in `extensions/agent-guard/path-guard.ts` and wire it through `extensions/agent-guard/index.ts`. This task must add `tool_call` enforcement for `read`, `write`, and `edit`, classify accesses into hard-block versus warn-only buckets using the shared policy, and write any implementation-specific caveats or normalization decisions to `docs/agent-guard/04-path-guard-notes.md` so Task 005 and Task 007 know exactly which paths and helper functions to inspect. Acceptance: path handling resolves absolute paths safely enough for normal filesystem usage, hard-blocked locations are denied consistently across file tools, warn-only locations remain usable without confirmation prompts, and `docs/agent-guard/04-path-guard-notes.md` identifies the exact exported functions and files that later tasks should reuse.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/004-implement-minimal-secret-path-protection-with-hard-block-and-warn-only-buckets/task.md`.
- Write progress updates only to `.pi/tasks/004-implement-minimal-secret-path-protection-with-hard-block-and-warn-only-buckets/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/004-implement-minimal-secret-path-protection-with-hard-block-and-warn-only-buckets/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/004-implement-minimal-secret-path-protection-with-hard-block-and-warn-only-buckets/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
