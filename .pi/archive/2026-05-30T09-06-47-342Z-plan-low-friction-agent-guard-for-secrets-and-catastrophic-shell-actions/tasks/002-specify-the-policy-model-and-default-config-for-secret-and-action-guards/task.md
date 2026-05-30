# Task: Specify the policy model and default config for secret and action guards

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: worker

## Dependencies
- 001

## Requirements
Before making changes, read `docs/agent-guard/01-architecture.md`, then define the config contract in two places: `docs/agent-guard/02-policy.md` for the human-readable policy spec and `extensions/agent-guard/policy.ts` for the typed default policy/config exported to the extension. The policy must cover `secretGuard` and `actionGuard`, including preserved environment variables, stripped environment-variable patterns, hard-block paths, warn-only paths, redaction patterns, the catastrophic-command blocklist, and the expected audit-log location. Acceptance: `docs/agent-guard/02-policy.md` and `extensions/agent-guard/policy.ts` agree on exact field names and defaults, both files explicitly mark password-manager secret injection and stronger bash sandboxing as future work, and Tasks 003–007 can use `policy.ts` as the single source of truth instead of inventing their own constants. ⚠ deferred (mvp): per-project approval workflows and broad command risk scoring are not part of the initial policy model.

## Workspace Rules
- Work only inside the current working directory.
- Use relative paths from cwd; do not assume absolute paths like `/root/project`.
- Your task instructions are in `.pi/tasks/002-specify-the-policy-model-and-default-config-for-secret-and-action-guards/task.md`.
- Write progress updates only to `.pi/tasks/002-specify-the-policy-model-and-default-config-for-secret-and-action-guards/progress.jsonl`; never create or append to a repo-root `progress.jsonl`.
- Raw engine output is captured separately in `.pi/tasks/002-specify-the-policy-model-and-default-config-for-secret-and-action-guards/output.jsonl`.
- Prefer targeted searches with exclusions (exclude `node_modules`, `.git`, and `.pi/archive` unless the task explicitly needs them).
- Avoid broad repo-wide scans such as `**/*.md` when a narrower path or pattern will do.
- If you already have enough context, stop exploring and produce the deliverable.

## Progress Tracking
Append one JSON line to `.pi/tasks/002-specify-the-policy-model-and-default-config-for-secret-and-action-guards/progress.jsonl` after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
