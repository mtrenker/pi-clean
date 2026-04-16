# Task: Research pi primitives for planner architecture

## Configuration
- **engine**: pi
- **profile**: balanced
- **model**: anthropic/claude-sonnet-4-6
- **thinking**: medium
- **agent**: scout

## Dependencies
None

## Requirements
Read the relevant pi docs and examples for skills, prompt templates, package resources, interactive extension APIs, and the existing questionnaire example. Summarize which concerns belong in a skill versus an extension command versus an optional prompt template. Identify the cleanest architecture for a dedicated planner workflow that is not a modal toggle, can ask interactive questions, can persist enough state to refine a plan over several turns, and can write a final `PLAN.md` file.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
