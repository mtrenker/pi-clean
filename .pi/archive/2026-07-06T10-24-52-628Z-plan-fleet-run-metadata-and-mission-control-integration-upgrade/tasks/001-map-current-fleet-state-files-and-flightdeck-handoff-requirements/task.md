# Task: Map current fleet state files and Flightdeck handoff requirements

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: claude-opus-4-8
- **thinking**: high
- **agent**: scout

## Dependencies
None

## Dependency Handoff
Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task. Do not redo discovery work that an upstream task already completed unless its output is missing or clearly insufficient.

This task has no upstream task dependencies.

## Requirements
Inspect `extensions/fleet/orchestrator.ts`, `extensions/fleet/state.ts`, `extensions/fleet/task.ts`, `extensions/fleet/archive.ts`, `extensions/fleet/inspect.ts`, `extensions/fleet/widget.ts`, `extensions/fleet/config.ts`, and `/home/martin/ai/hub/apps/flightdeck/docs/PI_CLEAN_FLEET_UPGRADE_HANDOFF.md`, then create `docs/fleet-mission-control/01-current-state.md`. The document must name every current `.pi/tasks/` file, summarize the fields Flightdeck can read today, identify where run identity and project context are missing, and define acceptance criteria for the later implementation tasks.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/task.md`.
- Write progress updates only to `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}

## Completion Handoff
Before finishing, write `.pi/tasks/001-map-current-fleet-state-files-and-flightdeck-handoff-requirements/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
