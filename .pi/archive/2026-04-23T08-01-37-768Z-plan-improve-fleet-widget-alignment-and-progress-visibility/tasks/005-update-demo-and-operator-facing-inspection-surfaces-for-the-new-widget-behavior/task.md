# Task: Update demo and operator-facing inspection surfaces for the new widget behavior

## Configuration
- **engine**: pi
- **profile**: balanced
- **model**: anthropic/claude-sonnet-4-6
- **thinking**: medium
- **agent**: worker

## Dependencies
- 002
- 004

## Requirements
Update `extensions/fleet/demo.ts` so `/fleet:demo` and related simulation flows emit realistic progress messages that exercise the new two-line widget layout, and adjust `extensions/fleet/inspect.ts` if needed so operators can confirm the same latest-progress timestamp and message from task files during debugging. Acceptance: a team member can run the demo, observe wrapped and truncated progress cases in the widget, and verify that the inspector view matches the underlying recorded progress data for a selected task.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
