# Task: Generate and validate fleet-compatible PLAN.md output

## Configuration
- **engine**: codex
- **profile**: balanced
- **model**: gpt-5.3-codex
- **thinking**: medium
- **agent**: worker

## Dependencies
- 003
- 004

## Requirements
Implement the logic that turns the refined planning state into a high-quality `PLAN.md` document in the fleet task format used by this repository. Ensure the generated output includes a meaningful overview, well-scoped task breakdown, sensible dependency ordering, and explicit enough descriptions that fleet workers can execute them without needing the original planning chat. Add validation or guardrails so malformed tasks, duplicate IDs, broken dependency chains, or vague descriptions are caught before the file is finalized.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
