# Task: Strengthen archive summaries with run history metadata

## Configuration
- **engine**: codex
- **profile**: balanced
- **model**: gpt-5.5
- **thinking**: medium
- **agent**: worker

## Dependencies
- 002
- 003
- 004
- 005

## Dependency Handoff
Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task. Do not redo discovery work that an upstream task already completed unless its output is missing or clearly insufficient.

### Upstream Task 002
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 003
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/003-add-append-only-fleet-timeline-events/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 004
- Read `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 005
- Read `.pi/tasks/005-add-human-attention-hint-derivation-to-fleet-state/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/005-add-human-attention-hint-derivation-to-fleet-state/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/005-add-human-attention-hint-derivation-to-fleet-state/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/005-add-human-attention-hint-derivation-to-fleet-state/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/005-add-human-attention-hint-derivation-to-fleet-state/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

## Requirements
Use Task 002's `run.json`, Task 003's `events.jsonl`, Task 004's usage totals, and Task 005's attention hints to update `extensions/fleet/archive.ts` and any archive-related tests. Archive summaries and `.pi/archive/index.json` entries must preserve `runId`, cwd, repo root, branch, plan path, started/completed timestamps, final status, total usage, attention counts, and paths to copied run/event files; acceptance requires existing archive behavior to keep working for old task folders while new archives contain enough metadata for Flightdeck history views.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/task.md`.
- Write progress updates only to `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
