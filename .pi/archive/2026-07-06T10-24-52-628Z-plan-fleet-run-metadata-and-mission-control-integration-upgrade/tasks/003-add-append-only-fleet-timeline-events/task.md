# Task: Add append-only fleet timeline events

## Configuration
- **engine**: codex
- **profile**: balanced
- **model**: gpt-5.5
- **thinking**: medium
- **agent**: worker

## Dependencies
- 001
- 002

## Dependency Handoff
Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task. Do not redo discovery work that an upstream task already completed unless its output is missing or clearly insufficient.

### Upstream Task 001
- Read `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 002
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/002-add-run-metadata-config-source-tracking-and-git-project-context/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

## Requirements
Use Task 001's file inventory and Task 002's `runId` output to add an append-only event writer, likely `extensions/fleet/events.ts`, and integrate it with `extensions/fleet/orchestrator.ts`, `extensions/fleet/task.ts`, and archive flows. The new `.pi/tasks/events.jsonl` stream must record `fleet_started`, `fleet_completed`, `fleet_stopped`, `task_status_changed`, `task_progress`, `task_usage_updated`, `task_failed`, `task_retried`, `task_handoff_written` when detectable, `archive_created`, `plan_validated`, and `operator_command` where practical; acceptance requires each event to include `ts`, `runId`, `type`, optional `taskId`, and a small `data` object without storing full raw agent transcripts.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/003-add-append-only-fleet-timeline-events/task.md`.
- Write progress updates only to `.pi/tasks/003-add-append-only-fleet-timeline-events/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/003-add-append-only-fleet-timeline-events/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/003-add-append-only-fleet-timeline-events/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/003-add-append-only-fleet-timeline-events/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
