# Task: Render a second aligned progress line under each task row

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: worker

## Dependencies
- 002
- 003

## Requirements
Extend `extensions/fleet/widget.ts` to render a second line beneath each task row that shows the latest progress timestamp and message, aligned with the main row layout so operators can scan activity by task without opening `/fleet:inspect`. Acceptance: running tasks show fresh progress details, completed or pending tasks fall back gracefully when no progress exists, long messages are truncated safely to preserve widget width, and the widget remains readable during live updates from `task:progress` events.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
