# Fleet Usage Investigation — Claude Cache Token Burn

Date: 2026-05-07

## Context

During the finance fleet run in `/home/martin/ai/hub/apps/finance`, the fleet widget/status made Claude usage look modest, while the Claude subscription dashboard reported near-exhaustion. Codex usage looked low in the dashboard even though fleet showed millions of Codex tokens.

## What was verified

The labels were not the primary issue:

- Codex-labelled tasks were confirmed in `~/.codex/state_5.sqlite` with `model_provider = openai` and `model = gpt-5.3-codex`.
- Claude-labelled tasks were confirmed in `.pi/tasks/*/output.jsonl` and `~/.claude/projects/-home-martin-ai-hub-apps-finance/*.jsonl` with `model = claude-sonnet-4-6`.

The issue is that fleet token accounting underreports Claude because it only tracks `input_tokens` and `output_tokens`, while Claude Code emits heavy `cache_creation_input_tokens` and especially `cache_read_input_tokens` on each turn.

Observed finance run rough totals from raw Claude logs:

- `input_tokens`: ~4.5k
- `cache_creation_input_tokens`: ~992k
- `cache_read_input_tokens`: ~25.8M
- `output_tokens`: ~13k
- total raw Claude token events: ~26.8M

The largest Claude-heavy tasks were implementation tasks with many tool turns and large dependency context:

- Task 017 review/assignment/correction APIs: ~5.8M raw Claude token events
- Task 018 finance chat framework: ~4.8M
- Task 016 local LLM classifier audit trail: ~3.4M
- Task 015 extraction/draft creation: ~3.3M
- Task 022 retry before pause: ~2.5M

## Root causes

### 1. Fleet usage model is too narrow

Current usage model in `extensions/fleet/engines/types.ts`, task state, aggregate state, widget, and inspector only represents:

```ts
usage: {
  inputTokens: number;
  outputTokens: number;
}
```

For Claude this hides the dominant cost/quota dimension: cache creation/read tokens.

### 2. Stream-json parser ignores Claude cache fields

`extensions/fleet/engines/_stream-json-process.ts` currently maps stream usage roughly as:

```ts
inputTokens = usageRaw["input_tokens"]
outputTokens = usageRaw["output_tokens"]
```

It should also capture:

```ts
cacheCreationInputTokens = usageRaw["cache_creation_input_tokens"]
cacheReadInputTokens = usageRaw["cache_read_input_tokens"]
```

### 3. Generated dependency handoff tells agents to read raw transcripts

`extensions/fleet/task.ts` currently generates upstream handoff blocks that include:

```md
- Read `.pi/tasks/<dep>/output.jsonl` for the raw engine transcript and final summary.
```

That is expensive and usually unnecessary. Raw `output.jsonl` contains complete tool transcripts and repeated model usage payloads. Downstream Claude agents that read these files repeatedly create huge cache-read usage.

### 4. No compact task handoff artifact exists

Downstream agents need the result of an upstream task, not the full raw transcript. Fleet currently has `task.md`, `status.json`, `progress.jsonl`, and `output.jsonl`, but no compact `handoff.md` that says:

- changed files
- public API/contracts
- tests run
- decisions/constraints
- known limitations
- what downstream tasks should consume

## Recommended fixes

### A. Extend usage accounting

Files likely touched:

- `extensions/fleet/engines/types.ts`
- `extensions/fleet/engines/_stream-json-process.ts`
- `extensions/fleet/engines/codex-usage.ts` if normalizing a shared shape
- `extensions/fleet/task.ts`
- `extensions/fleet/state.ts`
- `extensions/fleet/widget.ts`
- `extensions/fleet/inspect.ts`
- relevant tests under `extensions/fleet/*.test.ts` and `extensions/fleet/engines/*.test.ts`

Proposed shape:

```ts
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export function totalUsageTokens(usage: Usage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheCreationInputTokens ?? 0)
    + (usage.cacheReadInputTokens ?? 0);
}
```

For backward compatibility, status/state JSON can default missing cache fields to zero.

### B. Show real usage in widget/inspector

Widget should either:

- display total tokens including cache, or
- display engine-aware usage, e.g. `26.8M*` with `* includes cache`, or
- add a compact detail in inspector: `in / out / cache write / cache read / total`.

This would have made the finance run's Claude pressure visible immediately.

### C. Replace raw transcript dependency handoff with compact handoff

Change `extensions/fleet/task.ts` handoff generation from "read output.jsonl" to something like:

```md
- Read `.pi/tasks/<dep>/handoff.md` first if it exists; it is the compact authoritative summary for downstream tasks.
- Read `.pi/tasks/<dep>/status.json` to confirm completion.
- Read `.pi/tasks/<dep>/progress.jsonl` only if the handoff is missing or unclear.
- Do not read `.pi/tasks/<dep>/output.jsonl` unless debugging a failed task or explicitly searching for a missing detail with a targeted command.
```

### D. Require every task to produce `handoff.md`

Add to generated task.md:

```md
## Completion Handoff
Before finishing, write `.pi/tasks/NNN-slug/handoff.md` with:
- changed files
- important APIs/contracts
- tests run
- known limitations
- follow-up context for dependent tasks
```

The worker/reviewer/scout prompts can reinforce this.

### E. Add a Claude usage guard

Optional config in `.pi/fleet.json`:

```json
{
  "budgets": {
    "claude": {
      "maxConcurrent": 1,
      "warnAfterTasks": 3,
      "warnOnThinking": "high"
    }
  }
}
```

Initial version can simply warn before `/fleet:start` when a plan has many Claude tasks or high-thinking Claude tasks.

### F. Planner policy adjustment

Planner should prefer:

- Codex for implementation/codegen/UI/API/mechanical work
- Claude for architecture, schema/domain modelling, threat model, security review, and tricky accounting semantics
- Claude high only when explicitly justified
- Haiku/low or Codex Spark for docs/scout/simple review tasks

## Immediate mitigation used in finance run

For the paused finance run, remaining tasks should be converted away from Claude where acceptable and pending task handoff instructions should avoid reading upstream raw `output.jsonl` files.

## Implementation follow-up

Implemented on 2026-05-07:

- Fleet `Usage` now supports Claude cache creation/read tokens and shared total-token helpers.
- Claude stream-json parsing now captures `cache_creation_input_tokens` and `cache_read_input_tokens`, accumulating assistant-turn usage while treating result usage as an aggregate fallback.
- Widget, status output, aggregate state, archive summaries, and inspector now use cache-aware totals; inspector shows in/out/cache write/cache read/total.
- `/fleet:repair-usage` now backfills Claude and Codex usage from saved `output.jsonl`; Claude backfill includes cache fields.
- Generated dependency handoff now points downstream tasks to `handoff.md` first and warns against reading raw `output.jsonl` except for targeted debugging.
- Generated task instructions now require each task to write a compact `handoff.md` before finishing.
