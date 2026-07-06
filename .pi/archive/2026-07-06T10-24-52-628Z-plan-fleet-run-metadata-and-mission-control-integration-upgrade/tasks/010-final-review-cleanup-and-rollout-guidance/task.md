# Task: Final review, cleanup, and rollout guidance

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: claude-opus-4-8
- **thinking**: high
- **agent**: reviewer

## Dependencies
- 008
- 009

## Dependency Handoff
Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task. Do not redo discovery work that an upstream task already completed unless its output is missing or clearly insufficient.

### Upstream Task 008
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/008-add-backward-compatible-tests-and-fixtures-for-old-and-new-fleet-formats/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

### Upstream Task 009
- Read `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/task.md` for the original scope, required deliverable, and any file paths it was supposed to touch.
- Read `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/status.json` to confirm whether the task completed successfully and when.
- Read `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/009-validate-with-simulation-and-document-mission-control-ingestion-expectations/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
- Reuse concrete outputs from this dependency instead of rediscovering context. If it created files, changed APIs, made decisions, or identified constraints, treat those as authoritative inputs for your work and reference them in your own progress updates.

## Requirements
Use Task 008's test results and Task 009's validation document to perform a final review across `extensions/fleet/`, `docs/fleet-mission-control/`, and the generated `.pi/tasks/` state files. Verify backward compatibility, additive schema changes, no accidental transcript persistence in `events.jsonl`, no regressions to widget/inspect/status commands, and clear operator documentation; acceptance requires a final `docs/fleet-mission-control/10-rollout.md` that tells Martin how to reload the git-loaded extension, what files Flightdeck should read first, and which follow-up work belongs in the Hub Flightdeck app rather than pi-clean.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/010-final-review-cleanup-and-rollout-guidance/task.md`.
- Write progress updates only to `.pi/tasks/010-final-review-cleanup-and-rollout-guidance/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/010-final-review-cleanup-and-rollout-guidance/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/010-final-review-cleanup-and-rollout-guidance/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/010-final-review-cleanup-and-rollout-guidance/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
