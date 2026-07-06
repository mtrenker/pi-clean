# Task: Update operator surfaces for run metadata, events, and attention

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
Use Task 002's run metadata, Task 003's event stream, Task 004's heartbeat/usage fields, and Task 005's attention hints to update `extensions/fleet/index.ts`, `extensions/fleet/inspect.ts`, `extensions/fleet/widget.ts`, and `extensions/fleet/README.md`. `/fleet:status`, `/fleet:inspect`, the widget, and the `fleet_status` tool should remain compact but surface run id, stale/running indicators, attention warnings, and normalized token totals where useful; acceptance requires old `.pi/tasks/state.json` files to render without crashes and the README to explain how a human can inspect `run.json`, `events.jsonl`, and attention hints.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/task.md`.
- Write progress updates only to `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
