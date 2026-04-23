# Task: Add regression tests for widget rendering and progress formatting

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: sonnet
- **thinking**: high
- **agent**: worker

## Dependencies
- 002
- 004

## Requirements
Create `extensions/fleet/widget.test.ts` using the repo’s `node:test` style to cover fixed-width row alignment, long-value truncation, missing-progress fallbacks, and timestamp-plus-message rendering for recent progress updates. Acceptance: the test file fails against the old widget behavior, passes with the new rendering logic, and verifies both the main row width contract and the secondary progress-line formatting contract.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
