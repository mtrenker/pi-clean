# Task: Normalize task usage and heartbeat timestamps

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: worker

## Dependencies
- 001
- 002
- 003

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

### Upstream Task 003
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/003-add-append-only-fleet-timeline-events/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/003-add-append-only-fleet-timeline-events/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

## Requirements
Use Task 001's schema notes, Task 002's run metadata, and Task 003's event writer to update `extensions/fleet/engines/types.ts`, `extensions/fleet/task.ts`, `extensions/fleet/state.ts`, and `extensions/fleet/orchestrator.ts` with a stable usage and heartbeat model. Each task state and aggregate task entry must expose `lastHeartbeatAt`, `lastOutputAt`, `lastProgressAt`, `staleAfterSeconds`, and a normalized `usage` envelope with numeric `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `totalTokens`, `source`, and `updatedAt`; acceptance requires old status files with the previous usage shape to still load as zero/default values and live usage updates to persist often enough for Flightdeck to show active token movement.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/task.md`.
- Write progress updates only to `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/004-normalize-task-usage-and-heartbeat-timestamps/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
