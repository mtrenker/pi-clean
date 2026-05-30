# Task: Add regression tests and adversarial smoke cases for the low-friction guardrails

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: sonnet
- **thinking**: high
- **agent**: worker

## Dependencies
- 003
- 004
- 005

## Requirements
Before writing tests, read `docs/agent-guard/03-bash-guard-notes.md`, `docs/agent-guard/04-path-guard-notes.md`, and `docs/agent-guard/05-redaction-notes.md`, then add tests under `extensions/agent-guard/` using the repo’s existing test style, with at minimum `policy.test.ts`, `action-guard.test.ts`, `path-guard.test.ts`, and `redaction.test.ts` unless the implementation landed differently. The tests must cover environment filtering, hard-blocked secret paths, warn-only paths, catastrophic command blocking, and output redaction, and they must leave a short coverage summary in `docs/agent-guard/07-test-matrix.md` so Task 008 knows exactly which cases were automated and which were only manually validated. Acceptance: the tests fail against the unguarded implementation, pass once the extension is complete, and `docs/agent-guard/07-test-matrix.md` documents the exact threat cases this lightweight version claims to handle versus the stronger sandboxing work intentionally left for later. ⚠ deferred (mvp): exhaustive shell obfuscation coverage and formal threat modeling are not part of this test pass.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/007-add-regression-tests-and-adversarial-smoke-cases-for-the-low-friction-guardrails/task.md`.
- Write progress updates only to `.pi/tasks/007-add-regression-tests-and-adversarial-smoke-cases-for-the-low-friction-guardrails/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/007-add-regression-tests-and-adversarial-smoke-cases-for-the-low-friction-guardrails/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/007-add-regression-tests-and-adversarial-smoke-cases-for-the-low-friction-guardrails/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
