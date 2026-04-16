# Task: Package integration, docs, and end-to-end review

## Configuration
- **engine**: claude
- **model**: opus
- **thinking**: high
- **agent**: reviewer

## Dependencies
- 005

## Requirements
Review the final workflow from a user and package-design perspective. Verify that the questionnaire extension can stay independently enabled, that the new planner resources are packaged cleanly, and that the planner can be invoked without confusing mode semantics. Document how to use the planner, how the planning-depth profiles behave, and how the generated `PLAN.md` is intended to feed fleet. Review the prompts, command UX, and plan quality for gaps in challenge level, missing security considerations, or overengineering at the lightweight end of the spectrum.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
