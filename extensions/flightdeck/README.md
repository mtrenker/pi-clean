# Flightdeck telemetry

Trusted global Pi extension that reports Claude Code and Codex child executions to Flightdeck while they run. It observes `delegate_harness` and Fleet's in-process task boundaries; it does **not** treat the surrounding interactive Pi conversation as a task.

## Installation

The extension is part of the `@mtrenker/pi-clean` Pi package. Install the package globally:

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

Pi loads `extensions/flightdeck/index.ts` from the package manifest. The extension is trusted code with normal user permissions.

## Configuration

Set the append-only JSONL sink before starting Pi:

```bash
export FLIGHTDECK_TELEMETRY_FILE="$HOME/ai/hub/apps/flightdeck/logs/flightdeck-telemetry.jsonl"
```

With no sink, lifecycle counts still work but telemetry is disabled. A missing parent directory is created. An unwritable sink is reported as unhealthy but never changes a Claude/Codex result.

Fleet ownership is explicit:

```bash
# Default: live Pi extension owns Fleet child-task lifecycle and token events.
export FLIGHTDECK_FLEET_TELEMETRY_OWNER=extension

# Alternative: suppress live Fleet events when a Flightdeck scanner owns them.
export FLIGHTDECK_FLEET_TELEMETRY_OWNER=scanner
```

Do not enable both the live extension owner and scanner-derived Fleet lifecycle emission for the same run. When the extension owns telemetry, scanner ingestion may still read canonical `.pi/tasks` state for recovery and reconciliation, but it must not emit another lifecycle/token stream. Direct `delegate_harness` executions are always owned by this extension.

GitHub's `scripts/github-work.mjs` launcher supplies stable context through narrowly scoped `FLIGHTDECK_*` variables: `WORK_ID`, `PROJECT_SLUG`, `REPO_ROOT`, `REPOSITORY`, `WORKTREE_PATH`, `ROLE`, `REVIEWER`, `RUNTIME`, `WORKSPACE_LABEL`, and `BRANCH`. Other launchers may provide the same variables. Herdr workspace and pane IDs are never durable identity.

## Events and identity

Each Claude/Codex process attempt has one private typed lifecycle (`started`, heartbeat, cumulative usage, and exactly one `completed`, `failed`, or `aborted` terminal transition). Fleet retry attempts retain the Fleet run/task IDs and add an attempt number to `lifecycleId`/`agentId`.

The adapter emits schema-version 1 Flightdeck events:

- `agent.run.started`, `agent.task.started`
- `agent.run.heartbeat`, `agent.task.running`
- `agent.tokens.used`
- `agent.run.completed` / `agent.run.failed`
- `agent.task.completed` / `agent.task.failed`

Flightdeck's current schema has no separate aborted event. Aborts therefore use the `*.failed` event names with `attributes.status: "aborted"` and warning level; they are counted separately in Pi and are never reported as success or ordinary failure.

Every event carries stable `eventId` and `dedupeKey` attributes derived from lifecycle identity and transition. Usage events are cumulative snapshots, marked `usageKind: "cumulative"`; identical snapshots share an identity and are coalesced in-process. Consumers must upsert the latest cumulative snapshot by lifecycle rather than sum successive snapshots. This makes JSONL replay/re-accumulation safe.

Usage fields include provider/model and, when available:

- `inputTokens` / `gen_ai.usage.input_tokens`
- `outputTokens` / `gen_ai.usage.output_tokens`
- `cacheReadInputTokens`
- `cacheCreationInputTokens`
- `totalTokens`

Heartbeats contain only timestamps, sequence, state, and stale threshold. No progress text is emitted.

## Privacy boundary

The adapter emits identity, lifecycle state, coarse work context, model/provider, timing, exit code, and token counts only. It never emits prompts, model output, tool arguments/results, command output, file contents, stderr/stdout, credentials, broad environment data, or Fleet progress text. Environment context is read from the explicit variables listed above rather than serializing `process.env`.

## Status

The footer shows compact active/completed/failed/aborted counts and sink health. For details run:

```text
/flightdeck:status
```

Active tasks become stale after 90 seconds without a heartbeat by default. Quiet child processes emit a heartbeat every 30 seconds.

## Ingestion path

The extension appends validated-contract-compatible JSON objects, one per line, to `FLIGHTDECK_TELEMETRY_FILE`. Flightdeck's accumulator remains the only database writer: it tails or re-accumulates this file into Postgres, while Promtail/Alloy may ship the same JSONL to Loki. Flightdeck remains read-only and cannot start, stop, retry, or mutate Pi tasks.
