# Task: Validate with simulation and document Mission Control ingestion expectations

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: reviewer

## Dependencies
- 003
- 004
- 005
- 006
- 007
- 008

## Dependency Handoff
Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task. Do not redo discovery work that an upstream task already completed unless its output is missing or clearly insufficient.

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

### Upstream Task 006
- Read `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/006-strengthen-archive-summaries-with-run-history-metadata/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 007
- Read `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/007-update-operator-surfaces-for-run-metadata-events-and-attention/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 008
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

## Requirements
Use Task 003's event stream, Task 004's heartbeat/usage model, Task 005's attention hints, Task 006's archive metadata, Task 007's operator surfaces, and Task 008's fixtures to run `/fleet:validate`, `/fleet:split`, and `/fleet:simulate` against a small safe plan. Create `docs/fleet-mission-control/09-validation.md` with commands run, files produced, sample `run.json` and `events.jsonl` snippets, Flightdeck ingestion notes, and known limitations; acceptance requires the validation document to prove that a read-only dashboard can consume both current active state and archive history without needing a live pi session.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/task.md`.
- Write progress updates only to `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
