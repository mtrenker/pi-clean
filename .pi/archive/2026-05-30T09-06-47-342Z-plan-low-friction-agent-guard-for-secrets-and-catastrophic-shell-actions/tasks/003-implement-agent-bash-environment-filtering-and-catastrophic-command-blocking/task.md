# Task: Implement agent bash environment filtering and catastrophic command blocking

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: worker

## Dependencies
- 002

## Requirements
Before coding, read `docs/agent-guard/01-architecture.md` and `extensions/agent-guard/policy.ts`, then implement bash-related behavior in `extensions/agent-guard/index.ts`, `extensions/agent-guard/env.ts`, and `extensions/agent-guard/action-guard.ts`. This task must intercept agent `bash` tool calls and user-triggered `!`/`!!` execution paths, run them with a filtered environment, and block only the configured high-confidence catastrophic commands; if additional helper files are needed, document them in `docs/agent-guard/03-bash-guard-notes.md` so later agents know where the logic landed. Acceptance: ordinary developer commands still work from the home directory, the configured secret environment variables are absent from agent-executed subprocesses, blocked catastrophic commands return a clear reason, and `docs/agent-guard/03-bash-guard-notes.md` points later tasks to the exact files/functions that implement env filtering and command blocking. ⚠ deferred (mvp): full shell parsing and OS-level sandboxing are intentionally skipped in favor of a short, high-confidence blocklist.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/003-implement-agent-bash-environment-filtering-and-catastrophic-command-blocking/task.md`.
- Write progress updates only to `.pi/tasks/003-implement-agent-bash-environment-filtering-and-catastrophic-command-blocking/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/003-implement-agent-bash-environment-filtering-and-catastrophic-command-blocking/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/003-implement-agent-bash-environment-filtering-and-catastrophic-command-blocking/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
