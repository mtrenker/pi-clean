# Task: Implement the interactive planner entrypoint

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: sonnet
- **thinking**: high
- **agent**: worker

## Dependencies
- 002

## Requirements
Build a new extension-based planner entrypoint, likely as a dedicated command such as `/planner`, that owns the interactive interview and plan-authoring flow. The very first interaction must ask the user to choose a planning depth/profile tailored to the topic. The planner should then continue with targeted questionnaires, free-text prompts, and challenge-oriented follow-ups until it has enough information to propose a strong plan. Keep this extension independent from fleet and from the standalone questionnaire extension by using pi extension UI primitives directly where appropriate. The result of the flow should be a generated `PLAN.md`, with a preview/refinement opportunity before the final write.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
