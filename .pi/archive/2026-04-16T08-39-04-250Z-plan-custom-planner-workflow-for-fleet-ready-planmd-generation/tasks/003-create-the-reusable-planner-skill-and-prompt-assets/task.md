# Task: Create the reusable planner skill and prompt assets

## Configuration
- **engine**: claude
- **profile**: balanced
- **model**: sonnet
- **thinking**: medium
- **agent**: worker

## Dependencies
- 002

## Requirements
Implement a planner-oriented skill under `skills/` that captures the reusable planning doctrine: ask clarifying questions, challenge weak ideas, reason about risks, and aim for a concrete implementation plan. Add any supporting references or prompt assets needed so the planner can adapt to different project types such as product features, refactors, migrations, bug fixes, infrastructure, and security-sensitive work. If helpful, add a prompt template that gives humans a quick way to launch the planner workflow, but keep the primary experience centered on the dedicated planner entrypoint rather than a classic mode switch.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
