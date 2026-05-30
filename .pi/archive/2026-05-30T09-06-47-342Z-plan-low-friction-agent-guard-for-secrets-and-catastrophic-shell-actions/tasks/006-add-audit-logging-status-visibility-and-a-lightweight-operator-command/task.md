# Task: Add audit logging, status visibility, and a lightweight operator command

## Configuration
- **engine**: pi
- **profile**: balanced
- **model**: anthropic/claude-sonnet-4-6
- **thinking**: medium
- **agent**: worker

## Dependencies
- 003
- 004
- 005

## Requirements
Before coding, read `docs/agent-guard/03-bash-guard-notes.md`, `docs/agent-guard/04-path-guard-notes.md`, and `docs/agent-guard/05-redaction-notes.md`, then implement audit/status behavior in `extensions/agent-guard/index.ts` plus any small helper file needed for logging. This task must choose and implement one canonical operator command name, write the audit log to a single documented path, and update `extensions/agent-guard/README.md` with a “How to inspect guard activity” section that tells later agents and operators where to find the command, status indicator, and audit log. Acceptance: a user can confirm the extension is active without reading source code, inspect recent sensitive-access and blocked-command events, understand which policy bucket caused an intervention, and find all of that documented in `extensions/agent-guard/README.md`.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/006-add-audit-logging-status-visibility-and-a-lightweight-operator-command/task.md`.
- Write progress updates only to `.pi/tasks/006-add-audit-logging-status-visibility-and-a-lightweight-operator-command/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/006-add-audit-logging-status-visibility-and-a-lightweight-operator-command/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/006-add-audit-logging-status-visibility-and-a-lightweight-operator-command/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
