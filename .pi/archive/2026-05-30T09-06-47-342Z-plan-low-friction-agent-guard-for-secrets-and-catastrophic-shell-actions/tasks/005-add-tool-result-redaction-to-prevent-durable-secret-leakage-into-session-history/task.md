# Task: Add tool-result redaction to prevent durable secret leakage into session history

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: sonnet
- **thinking**: high
- **agent**: worker

## Dependencies
- 002
- 003
- 004

## Requirements
Before coding, read `extensions/agent-guard/policy.ts`, `docs/agent-guard/03-bash-guard-notes.md`, and `docs/agent-guard/04-path-guard-notes.md`, then implement redaction in `extensions/agent-guard/redaction.ts` and connect it from `extensions/agent-guard/index.ts`. The redaction logic must process text output from guarded tools at minimum `bash`, `read`, `write`, and `edit`, use the shared policy patterns where possible, and record any intentionally supported or unsupported redaction categories in `docs/agent-guard/05-redaction-notes.md` so Task 006 and Task 007 know what behavior to surface and test. Acceptance: the redaction layer preserves normal command usefulness for non-secret output, clearly marks redacted spans with stable placeholders, prevents straightforward secret material from being copied verbatim into session transcripts, compaction summaries, or exported shares, and leaves behind a discoverable note in `docs/agent-guard/05-redaction-notes.md` for downstream agents.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/005-add-tool-result-redaction-to-prevent-durable-secret-leakage-into-session-history/task.md`.
- Write progress updates only to `.pi/tasks/005-add-tool-result-redaction-to-prevent-durable-secret-leakage-into-session-history/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/005-add-tool-result-redaction-to-prevent-durable-secret-leakage-into-session-history/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/005-add-tool-result-redaction-to-prevent-durable-secret-leakage-into-session-history/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
