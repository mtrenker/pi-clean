# Task: Validate real-world workflow impact and document next-step upgrades

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: reviewer

## Dependencies
- 006
- 007

## Requirements
Before validating, read `extensions/agent-guard/README.md` and `docs/agent-guard/07-test-matrix.md`, then run the extension in a realistic pi session from the home directory and record the results in `docs/agent-guard/08-validation.md`. The validation note must state which workflows were exercised, what friction or false positives were observed, where the audit log and operator command helped during testing, and which future upgrades remain for password-manager-backed on-demand secret injection and optional stronger bash sandboxing. Acceptance: `docs/agent-guard/08-validation.md` exists as the final handoff artifact, common coding and shell workflows still succeed without new prompts, secret env vars are stripped, dangerous secret reads and catastrophic commands are handled as designed, and `extensions/agent-guard/README.md` links to the validation note and summarizes the extension’s goals, defaults, and limitations.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/008-validate-real-world-workflow-impact-and-document-next-step-upgrades/task.md`.
- Write progress updates only to `.pi/tasks/008-validate-real-world-workflow-impact-and-document-next-step-upgrades/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/008-validate-real-world-workflow-impact-and-document-next-step-upgrades/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/008-validate-real-world-workflow-impact-and-document-next-step-upgrades/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
