# Task: Design the planner workflow and planning-depth taxonomy

## Configuration
- **engine**: claude
- **profile**: deep
- **model**: sonnet
- **thinking**: high
- **agent**: worker

## Dependencies
- 001

## Requirements
Turn the research findings into a concrete product and architecture spec for the planner. Define the planner's kickoff flow, the refinement loop, and the finalization step that writes `PLAN.md`. Specify the first-question taxonomy in detail: how the workflow detects the task topic, which planning profiles it offers for different classes of work, and how the spectrum should map from "move fast / MVP / skip some details" to "full production-ready / security-first / compliance-aware". Define how the planner should challenge bad assumptions, surface tradeoffs, and ask follow-up questions before locking the final plan.

## Progress Tracking
Append to `progress.jsonl` in this task directory after each significant step:
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
