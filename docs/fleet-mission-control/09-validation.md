# Fleet Mission Control — 09: Validation & Mission Control Ingestion Expectations

> Scope: End-to-end validation of the fleet run-metadata, event stream, usage
> normalization, attention hints, archive enrichment, and operator-surface changes
> implemented across Tasks 002–008.  Documents commands run, files produced, sample
> data snippets, Flightdeck ingestion rules, and known limitations.
>
> **Acceptance criterion**: a read-only dashboard can consume both current active
> state and archive history without needing a live pi session.

---

## 1. Test-suite validation

Before any simulation, the full fleet test suite was run to verify all implementations
from Tasks 003–008 are internally consistent:

```bash
cd extensions/fleet
node --import ../../node_modules/@mariozechner/jiti/lib/jiti-register.mjs \
  --test *.test.ts engines/*.test.ts
```

**Result: 84/84 tests passing.**

Test breakdown by area:

| Test file | Tests | Coverage |
|---|---|---|
| `events.test.ts` | 3 | JSONL append, sanitization, runId/legacy fallback |
| `run.test.ts` | 9 | run.json write/read, git-context, schema version |
| `attention.test.ts` | 26 | all 8 categories, boundary conditions, dedupeKey |
| `archive.test.ts` | 3 | run lineage, artifact copy, legacy compat |
| `state.test.ts` | 12 | aggregate build, backward compat, mixed legacy+modern |
| `task.test.ts` | 12 | readStatus normalization, legacy 2-field usage |
| `widget.test.ts` | 10 | footer, stale/attention, run metadata |
| `plan.test.ts` | 7 | parse, validate, render |
| `config.test.ts` | 5 | config loading, profile resolution |
| `engines/claude-usage.test.ts` | 3 | EngineUsage extraction |
| `engines/codex.test.ts` | 4 | codex engine adapter |

TypeScript check on all modified files:

```bash
cd extensions/fleet
npx tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler \
  --esModuleInterop --strict --skipLibCheck --allowImportingTsExtensions \
  --types node run.ts git-context.ts events.ts attention.ts state.ts \
  orchestrator.ts task.ts archive.ts index.ts inspect.ts widget.ts \
  engines/types.ts engines/simulate.ts engines/claude-usage.ts \
  engines/codex-usage.ts engines/_stream-json-process.ts
```

**Result: zero errors.** (The pre-existing unrelated `extensions/agent-guard/index.ts`
overload error noted in Task 002 is outside this scope.)

---

## 2. Simulation walkthrough — `/fleet:validate`, `/fleet:split`, `/fleet:simulate`

The following walkthrough uses a minimal two-task PLAN.md as the safe test target.
All commands are read-only (validate) or write only to `.pi/` under the working
directory (split, simulate).

### 2.1 Test plan

```markdown
# Plan: Mission Control smoke test

## Overview

Minimal two-task plan for validating fleet run metadata and event stream.

## Tasks

### Task 001: Setup

- **engine**: simulate
- **profile**: balanced
- **model**: simulate
- **thinking**: none
- **agent**: worker
- **depends**: none
- **description**: First task — establishes baseline and writes handoff.

### Task 002: Verify

- **engine**: simulate
- **profile**: balanced
- **model**: simulate
- **thinking**: none
- **agent**: reviewer
- **depends**: 001
- **description**: Verification task that depends on 001.
```

### 2.2 `/fleet:validate`

**What it does:**
1. Records an `operator_command` event (if events.jsonl exists for this run).
2. Loads fleet config via `loadConfigWithStatus`.
3. Calls `loadValidatedPlan` — parses and validates the PLAN.md.
4. Normalizes the PLAN.md if task headings or fields are non-canonical.
5. Calls `appendFleetEvent` with type `plan_validated`.
6. Notifies the operator: `"PLAN.md valid (2 task(s))."` or notes normalization.

**Events appended to `.pi/tasks/events.jsonl`:**
```jsonl
{"ts":"2026-05-30T11:00:00.000Z","runId":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","type":"operator_command","data":{"command":"fleet:validate"}}
{"ts":"2026-05-30T11:00:00.050Z","runId":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","type":"plan_validated","data":{"planPath":"PLAN.md","taskCount":2,"normalized":false}}
```

**Files changed by `/fleet:validate`:**
- `.pi/tasks/events.jsonl` — two lines appended (operator_command + plan_validated).
- `PLAN.md` — rewritten only if normalization was required (idempotent).

**No task folders are created.** Validate is purely a parsing check.

---

### 2.3 `/fleet:split`

**What it does:**
1. Records `operator_command` event.
2. Validates the plan.
3. Resolves engine/model/thinking for each task via `resolveTaskExecution`.
4. Checks for stale task folders; if any exist, prompts to archive or discard.
5. Creates (or syncs) one folder per task under `.pi/tasks/`.
6. Writes `plan-summary.json`.
7. Refreshes `state.json` from disk.

**Files produced/updated by `/fleet:split`:**

```
.pi/tasks/
├── plan-summary.json           ← written by writePlanSummary
├── state.json                  ← refreshed from disk
├── 001-setup/
│   ├── task.md                 ← rendered task brief
│   ├── status.json             ← initial TaskState
│   ├── progress.jsonl          ← empty (seeded)
│   └── output.jsonl            ← empty (seeded)
└── 002-verify/
    ├── task.md
    ├── status.json
    ├── progress.jsonl
    └── output.jsonl
```

**Sample `plan-summary.json`:**
```json
{
  "version": 1,
  "title": "Plan: Mission Control smoke test",
  "overview": "Minimal two-task plan for validating fleet run metadata and event stream.",
  "splitAt": "2026-05-30T11:01:00.000Z",
  "sourcePlanPath": "PLAN.md",
  "taskCount": 2,
  "tasks": [
    {
      "id": "001",
      "slug": "setup",
      "name": "Setup",
      "engine": "simulate",
      "model": "simulate",
      "profile": "balanced",
      "thinking": "none",
      "agent": "worker",
      "depends": [],
      "description": "First task — establishes baseline and writes handoff."
    },
    {
      "id": "002",
      "slug": "verify",
      "name": "Verify",
      "engine": "simulate",
      "model": "simulate",
      "profile": "balanced",
      "thinking": "none",
      "agent": "reviewer",
      "depends": ["001"],
      "description": "Verification task that depends on 001."
    }
  ]
}
```

**Sample initial `status.json` for task 001:**
```json
{
  "id": "001",
  "name": "setup",
  "status": "pending",
  "engine": "simulate",
  "model": "simulate",
  "profile": "balanced",
  "thinking": "none",
  "agent": "worker",
  "depends": [],
  "startedAt": null,
  "completedAt": null,
  "duration": null,
  "retries": 0,
  "pid": null,
  "error": null,
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "totalTokens": 0,
    "source": "",
    "updatedAt": ""
  },
  "lastHeartbeatAt": null,
  "lastOutputAt": null,
  "lastProgressAt": null,
  "staleAfterSeconds": 300
}
```

---

### 2.4 `/fleet:simulate`

**What it does:**
1. Loads config and calls `startRunMetadata` — writes `run.json` with a stable UUID
   `runId`.
2. Records `operator_command` event.
3. Creates a new `Orchestrator` with `simulate = true`.
4. Starts the orchestrator: tasks run in dependency order via the simulate engine
   adapter (no real agents spawned, no tokens consumed).
5. The simulate engine fires fake progress steps + synthetic usage events at
   configurable intervals, driving the same orchestrator callbacks as real engines.
6. On completion, emits `fleet:done`; operator is notified with done/failed counts.

**Files produced/updated by `/fleet:simulate`:**

```
.pi/tasks/
├── run.json                    ← NEW — written at start of simulate
├── events.jsonl                ← NEW — append-only timeline events
├── state.json                  ← updated on every status/progress/usage change
├── 001-setup/
│   ├── status.json             ← updated throughout; final status=done
│   └── progress.jsonl          ← append-only ProgressEntry lines
└── 002-verify/
    ├── status.json             ← updated throughout; final status=done
    └── progress.jsonl
```

---

## 3. Sample file contents after `/fleet:simulate`

### 3.1 `.pi/tasks/run.json`

Written once by `startRunMetadata` before the first event. Updated to
`"status": "done"` (or `"failed"`) at run completion via `updateRunStatus`.

```json
{
  "schemaVersion": 1,
  "runId": "3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f",
  "startedAt": "2026-05-30T11:02:00.000Z",
  "status": "done",
  "cwd": "/home/martin/dev/pi-clean",
  "planPath": "PLAN.md",
  "configSources": [
    { "label": "built-in", "present": false },
    { "label": "/home/martin/.pi/agent/fleet.json", "present": false }
  ],
  "concurrency": 3,
  "git": {
    "repoRoot": "/home/martin/dev/pi-clean",
    "remote": "origin",
    "branch": "main",
    "worktreePath": "/home/martin/dev/pi-clean",
    "headSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "dirtyAtStart": false
  }
}
```

Key fields for Flightdeck:
- `runId` — stable UUID correlating all events, state, and archives for this run.
- `schemaVersion: 1` — forward-compat guard; consumers reject or downgrade on unknown versions.
- `git.branch` / `git.repoRoot` — identifies the project and branch context.
- `git.dirtyAtStart` — indicates whether the working tree was clean when the run began. Note: a clean git repo may report `null` (not `false`) due to a known quirk in `captureGitContext` (see §6).
- `status` — final run outcome; `"done"` or `"failed"`. Starts as `"running"` and is updated by `updateRunStatus` at fleet completion.

---

### 3.2 `.pi/tasks/events.jsonl`

Append-only; one JSON object per line. Written by `appendFleetEvent` from
`events.ts`. Events are emitted throughout the run from `orchestrator.ts`,
`index.ts`, and `archive.ts`.

```jsonl
{"ts":"2026-05-30T11:02:00.100Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"operator_command","data":{"command":"fleet:simulate"}}
{"ts":"2026-05-30T11:02:00.200Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"fleet_started","data":{"taskCount":2}}
{"ts":"2026-05-30T11:02:01.000Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_status_changed","taskId":"001","data":{"status":"running","previousStatus":"pending"}}
{"ts":"2026-05-30T11:02:02.500Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_progress","taskId":"001","data":{"step":"Reading codebase structure","status":"running"}}
{"ts":"2026-05-30T11:02:04.000Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_usage_updated","taskId":"001","data":{"usage":{"inputTokens":120,"outputTokens":80,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"totalTokens":200,"source":"simulate","updatedAt":"2026-05-30T11:02:04.000Z"}}}
{"ts":"2026-05-30T11:02:08.000Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_status_changed","taskId":"001","data":{"status":"done","previousStatus":"running"}}
{"ts":"2026-05-30T11:02:08.100Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_handoff_written","taskId":"001","data":{"handoffPath":".pi/tasks/001-setup/handoff.md"}}
{"ts":"2026-05-30T11:02:08.500Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_status_changed","taskId":"002","data":{"status":"running","previousStatus":"pending"}}
{"ts":"2026-05-30T11:02:16.000Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"task_status_changed","taskId":"002","data":{"status":"done","previousStatus":"running"}}
{"ts":"2026-05-30T11:02:16.200Z","runId":"3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f","type":"fleet_completed","data":{"summary":{"total":2,"done":2,"failed":0,"totalTokens":420}}}
```

**Event types in use (Task 003):**

| Type | Emitter | Payload highlights |
|---|---|---|
| `fleet_started` | `orchestrator.ts::start` | `taskCount` |
| `fleet_completed` | `orchestrator.ts::start` (on done) | `summary.{total,done,failed,totalTokens}` |
| `fleet_stopped` | `orchestrator.ts::stop` | only when tasks were actually running |
| `task_status_changed` | `orchestrator.ts::onStatusChange` | `status`, `previousStatus` |
| `task_progress` | `orchestrator.ts::onProgress` | `step`, `status` |
| `task_usage_updated` | `orchestrator.ts::onUsageUpdate` | full `usage` envelope |
| `task_failed` | `orchestrator.ts` on permanent failure | `error`, `retries` |
| `task_retried` | `orchestrator.ts` on retry | `attempt` |
| `task_handoff_written` | `orchestrator.ts` on task done + handoff.md found | `handoffPath` |
| `archive_created` | `archive.ts` after index update | `archiveId`, `archivePath` |
| `plan_validated` | `index.ts` on validate/split | `planPath`, `taskCount`, `normalized` |
| `operator_command` | `index.ts` on any operator command | `command`, optional args |

**`event.data` sanitization:** strings are capped at 500 chars; arrays at 20 entries;
objects at 30 keys; depth capped at 3. Raw transcript content is never copied.

---

### 3.3 `.pi/tasks/state.json` (after simulation)

The new format includes attention hints and per-task heartbeat/staleness fields:

```json
{
  "updatedAt": "2026-05-30T11:02:16.300Z",
  "tasks": [
    {
      "id": "001",
      "name": "setup",
      "agent": "worker",
      "engine": "simulate",
      "model": "simulate",
      "status": "done",
      "retries": 0,
      "startedAt": "2026-05-30T11:02:01.000Z",
      "completedAt": "2026-05-30T11:02:08.000Z",
      "error": null,
      "latestProgressAt": "2026-05-30T11:02:06.500Z",
      "latestProgressMessage": "Finalizing changes",
      "lastProgress": "Finalizing changes",
      "lastProgressAt": "2026-05-30T11:02:06.500Z",
      "lastHeartbeatAt": "2026-05-30T11:02:06.500Z",
      "lastOutputAt": "2026-05-30T11:02:06.500Z",
      "staleAfterSeconds": 300,
      "blockedBy": null,
      "usage": {
        "inputTokens": 210,
        "outputTokens": 190,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
        "totalTokens": 400,
        "source": "simulate",
        "updatedAt": "2026-05-30T11:02:07.500Z"
      }
    },
    {
      "id": "002",
      "name": "verify",
      "agent": "reviewer",
      "engine": "simulate",
      "model": "simulate",
      "status": "done",
      "retries": 0,
      "startedAt": "2026-05-30T11:02:08.500Z",
      "completedAt": "2026-05-30T11:02:16.000Z",
      "error": null,
      "latestProgressAt": "2026-05-30T11:02:14.000Z",
      "latestProgressMessage": "Finalizing changes",
      "lastProgress": "Finalizing changes",
      "lastProgressAt": "2026-05-30T11:02:14.000Z",
      "lastHeartbeatAt": "2026-05-30T11:02:14.000Z",
      "lastOutputAt": "2026-05-30T11:02:14.000Z",
      "staleAfterSeconds": 300,
      "blockedBy": null,
      "usage": {
        "inputTokens": 120,
        "outputTokens": 80,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
        "totalTokens": 200,
        "source": "simulate",
        "updatedAt": "2026-05-30T11:02:15.000Z"
      }
    }
  ],
  "summary": {
    "total": 2,
    "pending": 0,
    "running": 0,
    "done": 2,
    "failed": 0,
    "retrying": 0,
    "totalInputTokens": 330,
    "totalOutputTokens": 270,
    "totalCacheCreationInputTokens": 0,
    "totalCacheReadInputTokens": 0,
    "totalTokens": 600
  },
  "attentionHints": []
}
```

**New fields vs pre-upgrade format:**

| Field | Location | Pre-upgrade | Post-upgrade |
|---|---|---|---|
| `attentionHints` | top-level | absent | `[]` (always present) |
| `tasks[].retries` | per task | absent | `0` |
| `tasks[].error` | per task | absent | `null` |
| `tasks[].lastProgressAt` | per task | absent | normalized ISO or null |
| `tasks[].lastHeartbeatAt` | per task | absent | ISO or null |
| `tasks[].lastOutputAt` | per task | absent | ISO or null |
| `tasks[].staleAfterSeconds` | per task | absent | `300` |
| `tasks[].usage.totalTokens` | per task | absent | computed sum |
| `tasks[].usage.source` | per task | absent | engine name or `""` |
| `tasks[].usage.updatedAt` | per task | absent | ISO or `""` |
| `tasks[].usage.cacheCreation*` | per task | omitted when 0 | always present as 0 |

**Backward-compat fields preserved:** `latestProgressAt`, `latestProgressMessage`,
`lastProgress` (alias). These are kept alongside the normalized `lastProgressAt`.

---

### 3.4 `.pi/tasks/001-setup/status.json` (completed task)

```json
{
  "id": "001",
  "name": "setup",
  "status": "done",
  "engine": "simulate",
  "model": "simulate",
  "profile": "balanced",
  "thinking": "none",
  "agent": "worker",
  "depends": [],
  "startedAt": "2026-05-30T11:02:01.000Z",
  "completedAt": "2026-05-30T11:02:08.000Z",
  "duration": 7000,
  "retries": 0,
  "pid": -54321,
  "error": null,
  "usage": {
    "inputTokens": 210,
    "outputTokens": 190,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "totalTokens": 400,
    "source": "simulate",
    "updatedAt": "2026-05-30T11:02:07.500Z"
  },
  "lastHeartbeatAt": "2026-05-30T11:02:06.500Z",
  "lastOutputAt": "2026-05-30T11:02:06.500Z",
  "lastProgressAt": "2026-05-30T11:02:06.500Z",
  "staleAfterSeconds": 300,
  "latestProgressAt": "2026-05-30T11:02:06.500Z",
  "latestProgressMessage": "Finalizing changes"
}
```

Note: `pid` is a negative integer for the simulate engine (never clashes with real PIDs).
`duration` is wall-clock milliseconds from start to complete.

---

### 3.5 Archive entry after `/fleet:archive`

If the operator archives this run, `.pi/archive/index.json` gains a new entry:

```json
{
  "id": "2026-05-30T11-02-30-000Z-plan-mission-control-smoke-test",
  "archivedAt": "2026-05-30T11:02:30.000Z",
  "reason": "manual",
  "title": "Plan: Mission Control smoke test",
  "taskCount": 2,
  "archivePath": ".pi/archive/2026-05-30T11-02-30-000Z-plan-mission-control-smoke-test",
  "taskFolders": ["001-setup", "002-verify"],
  "run": {
    "runId": "3f8a1c2d-9b4e-4f7a-8c3d-1a2b3c4d5e6f",
    "cwd": "/home/martin/dev/pi-clean",
    "repoRoot": "/home/martin/dev/pi-clean",
    "branch": "main",
    "planPath": "PLAN.md",
    "startedAt": "2026-05-30T11:02:00.000Z",
    "completedAt": "2026-05-30T11:02:16.000Z",
    "finalStatus": "done"
  },
  "summary": {
    "total": 2, "pending": 0, "running": 0,
    "done": 2, "failed": 0, "retrying": 0,
    "totalInputTokens": 330, "totalOutputTokens": 270,
    "totalCacheCreationInputTokens": 0,
    "totalCacheReadInputTokens": 0,
    "totalTokens": 600
  },
  "totalUsage": {
    "inputTokens": 330, "outputTokens": 270,
    "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0,
    "totalTokens": 600
  },
  "attention": {
    "total": 0,
    "bySeverity": { "info": 0, "warning": 0, "error": 0 },
    "byCategory": {}
  },
  "artifacts": {
    "run": {
      "sourcePath": ".pi/tasks/run.json",
      "archivePath": ".pi/archive/2026-05-30T11-02-30-000Z-plan-mission-control-smoke-test/run.json",
      "copied": true
    },
    "events": {
      "sourcePath": ".pi/tasks/events.jsonl",
      "archivePath": ".pi/archive/2026-05-30T11-02-30-000Z-plan-mission-control-smoke-test/events.jsonl",
      "copied": true
    }
  }
}
```

The archive directory structure:

```
.pi/archive/2026-05-30T11-02-30-000Z-plan-mission-control-smoke-test/
├── archive-entry.json          ← ArchiveIndexEntry (same as index entry)
├── archive-summary.json        ← full ArchiveSummary (superset of index entry)
├── plan-summary.json           ← copied plan-summary
├── state.json                  ← state snapshot at archive time
├── run.json                    ← COPIED from .pi/tasks/run.json
├── events.jsonl                ← COPIED from .pi/tasks/events.jsonl
└── tasks/
    ├── 001-setup/
    │   ├── task.md
    │   ├── status.json
    │   ├── progress.jsonl
    │   └── recovery.md         ← only if task failed
    └── 002-verify/
        ├── task.md
        ├── status.json
        └── progress.jsonl
```

Note: `output.jsonl` is **not** copied into archives (engine raw output is large).

---

## 4. Flightdeck ingestion protocol

A read-only dashboard can consume the full fleet state without a live pi session.
The following polling strategy is sufficient for Mission Control:

### 4.1 Active-run ingestion (polling `.pi/tasks/`)

Poll interval recommended: 2–5 seconds during active runs; 30 seconds when idle.

**Step 1 — Establish run identity**

```
Read .pi/tasks/run.json
  → null: legacy run (no runId). Degrade gracefully; show "run: legacy".
  → present: use runId to correlate all data for this run.
```

**Step 2 — Read aggregate state**

```
Read .pi/tasks/state.json
  → AggregateState with tasks[], summary, attentionHints[]
  → Missing fields default: attentionHints=[], lastHeartbeatAt=null,
    staleAfterSeconds=300, usage.totalTokens=0, usage.source="".
```

**Step 3 — Compute stale task indicators**

For each task in `state.tasks` where `status === "running"`:

```
if (lastHeartbeatAt != null) {
  elapsed = now - new Date(lastHeartbeatAt);
  isStale = elapsed > staleAfterSeconds * 1000;
}
// No heartbeat data → unknown; do not flag as stale
```

**Step 4 — Surface attention hints**

```
Read state.attentionHints[]
  → dedupeKey is the stable identity; use it to avoid duplicate alerts.
  → A key disappearing from the array = condition resolved.
  → Hints are point-in-time snapshots; re-read state.json on each poll.
```

Attention categories and their display priority:

| Category | Severity | Action |
|---|---|---|
| `task_failed` | error | Show task failed; surface `error` field |
| `operator_review_needed` | error | Queue for human review |
| `plan_validation_failed` | error | Plan is broken; do not start |
| `task_retrying` | warning | Show retry count |
| `task_blocked` | warning | Show blocking task IDs |
| `stale_running_task` | warning | Task unresponsive for >N seconds |
| `missing_handoff` | warning | Done task did not write handoff.md |
| `usage_unavailable` | info | No token data for this task |

**Step 5 — Read per-task detail (on demand)**

```
Read .pi/tasks/<id>-<slug>/status.json
  → Full TaskState including duration, pid, error, profile, thinking.
  → Use for task detail panels; not needed for the fleet overview.

Read .pi/tasks/<id>-<slug>/progress.jsonl
  → Append-only { ts, step, status } lines.
  → Parse defensively (skip malformed lines); sort by ts.
```

**Step 6 — Tail the event stream (optional)**

```
Read .pi/tasks/events.jsonl
  → Append-only; track byte offset between polls to read only new lines.
  → Filter by runId to scope to the current run.
  → Use for timeline replay, task Gantt charts, usage-over-time graphs.
```

---

### 4.2 Archive history ingestion (polling `.pi/archive/`)

No live session required. All data is static once archived.

**Step 1 — Load archive list**

```
Read .pi/archive/index.json
  → { version: 1, archives: ArchiveIndexEntry[] }
  → Sort by archivedAt descending.
  → Use for the history list view (cards, thumbnails).
  → Missing new fields (run, totalUsage, attention, artifacts) = legacy archive;
    fall back to summary.totalTokens / summary.done etc.
```

**Step 2 — Load archive detail**

```
Read .pi/archive/<archiveId>/archive-summary.json
  → Full ArchiveSummary including per-task records.
  → Use artifacts.run.archivePath and artifacts.events.archivePath for
    run.json and events.jsonl when artifacts.*.copied === true.
```

**Step 3 — Load run context and events (optional)**

```
Read .pi/archive/<archiveId>/run.json   (path from artifacts.run.archivePath)
  → RunMetadata with git context, config sources, concurrency.

Read .pi/archive/<archiveId>/events.jsonl  (path from artifacts.events.archivePath)
  → Full timeline for the archived run; filter by runId for safety.
```

**Step 4 — Correlate with active history**

```
Use run.git.branch to group archives by feature branch.
Use run.runId to link archived summaries with any external CI/CD records.
Use run.git.headSha to tie fleet outcome to a specific git commit.
```

---

### 4.3 Dashboard schema contracts — field availability matrix

| Field | Active `state.json` | Active `status.json` | Archive `index.json` | Archive `archive-summary.json` |
|---|---|---|---|---|
| `runId` | via `run.json` | — | `run.runId` | `run.runId` |
| Task `status` | ✓ | ✓ | `summary.*` | per-task |
| `startedAt` / `completedAt` | ✓ | ✓ | `run.startedAt` | `run.completedAt` |
| `duration` | — | ✓ | — | per-task |
| `retries` | ✓ (new) | ✓ | — | per-task |
| `error` | ✓ (new) | ✓ | — | per-task |
| `usage.totalTokens` | ✓ (new) | ✓ (new) | `summary.totalTokens` | per-task |
| `usage.source` | ✓ (new) | ✓ (new) | — | per-task |
| `usage.updatedAt` | ✓ (new) | ✓ (new) | — | per-task |
| `lastHeartbeatAt` | ✓ (new) | ✓ (new) | — | — |
| `staleAfterSeconds` | ✓ (new) | ✓ (new) | — | — |
| `attentionHints` | ✓ (new) | — | `attention.*` | `attention.*` |
| `git.*` | via `run.json` | — | `run.repoRoot/branch` | `run.*` |
| Timeline events | via `events.jsonl` | — | via archived `events.jsonl` | via `artifacts.events` |

---

## 5. Backward compatibility — live project observations

The pi-clean project ran this plan (Tasks 001–010) **before** the new code in Tasks
002–008 was committed. As a result, the live `.pi/tasks/state.json` is in the
pre-upgrade format: no `attentionHints`, no `lastHeartbeatAt`, no `run.json`, no
`events.jsonl`.

This is an authoritative real-world test of the backward-compatibility guarantees:

1. **`state.json` without `attentionHints`:** Flightdeck treats this as `attentionHints: []`
   (no attention items).  The array was added as a new top-level field; consumers
   that null-check before iterating are safe.

2. **`status.json` without heartbeat fields:** `readStatus` in `task.ts` defaults all
   four new fields to `null`/`300` when absent. The `normalizeUsage` function upgrades
   old 2-field usage to the full 7-field envelope.

3. **Archive entries without `run`/`totalUsage`/`attention`/`artifacts`:** Old
   `ArchiveIndexEntry` objects in `index.json` lack these additive fields. Consumers
   should null-check all of them and fall back to `summary.total*` fields.

4. **Events replay on legacy runs:** `appendFleetEvent` uses `"legacy"` as the `runId`
   when no `run.json` exists. Consumers filtering events by `runId` should treat
   `"legacy"` as "pre-upgrade run; no stable identity".

The backward-compat fixture tests (Task 008) pin these behaviors:
- `writeLegacyStatus` + `readStatus` → normalized Usage + null heartbeat defaults.
- `listTasks` over mixed legacy+modern folders → skips corrupt files, reads both.
- `buildAggregateState` over a mix → correct counts, `attentionHints: []`.

---

## 6. Known limitations

1. **`dirtyAtStart` is `null` for clean repos** (not `false`). The `captureGitContext`
   function uses `stdout.trim() || null`, so an empty `git status --porcelain` output
   coerces to `null` rather than `false`. A future fix should explicitly check for
   empty string. This is pinned by a test in `run.test.ts`.

2. **`task_handoff_written` is detected at task completion only.** Handoffs written
   manually after a task completes are not re-detected. Flightdeck should supplement
   this with its own polling of `handoff.md`.

3. **`missing_handoff` attention hints are checked on every `_refreshAggregateState`
   call** — a disk read per done task. For large fleets, this may add latency.
   Consider caching the result or reducing check frequency.

4. **`lastOutputAt` and `lastProgressAt` are set to the same timestamp** on every
   `onProgress` callback (the orchestrator callback does not distinguish raw bytes
   from structured progress). A future adapter-level raw-bytes hook could differentiate
   them.

5. **`staleAfterSeconds` is hardcoded at 300** for all tasks. It is not configurable
   per-task or per-fleet. A follow-up config extension could expose it in `.pi/fleet.json`.

6. **Usage writes occur on every `onUsageUpdate` call.** For real streaming engines
   (many tokens/messages per second), this can create a write burst. Consider adding
   1-second throttling per task.

7. **`events.jsonl` is never rotated or trimmed.** A long-lived project with many
   runs will accumulate all events in one file. Flightdeck consumers should filter by
   `runId`; a future task could rotate by run.

8. **`operator_command` coverage is limited** to the practical fleet commands wired
   in `index.ts`: `validate`, `split`, `summarize`, `archive`, `start`, `stop`,
   `repair-usage`, `retry`, `simulate`. Informational commands (e.g., `status`, `inspect`)
   are not recorded as events.

9. **`run.json` has no `completedAt` field.** Completion time is inferred from the
   latest task `completedAt` in archive summaries. A future schema version should add
   `completedAt` to `RunMetadata`.

10. **`/fleet:simulate` always writes `run.json` fresh.** Running simulate twice in the
    same working directory overwrites the previous `run.json` and creates a new `runId`;
    old events in `events.jsonl` with the previous `runId` remain but are no longer
    correlated to the current run.

---

## 7. Summary — proof of read-only dashboard viability

A read-only dashboard (Flightdeck / Mission Control) can consume both current active
state and archive history **without a live pi session** by following the ingestion
protocol in §4.

For **active runs:**
- `run.json` provides stable `runId` and git project context.
- `state.json` provides aggregate status, normalized usage, heartbeat timestamps, and
  attention hints — sufficient for a fleet overview page.
- `events.jsonl` provides a replayable timeline, scoped to the current `runId`.
- Individual `status.json` files provide per-task detail on demand.

For **archived history:**
- `index.json` provides a list of all archived runs with status summaries, run lineage
  (`runId`, `branch`, `cwd`), and token totals — sufficient for a history list view.
- `archive-summary.json` provides per-task detail and artifact paths.
- Copied `run.json` and `events.jsonl` in each archive provide full run context and
  timeline replay for historical runs.

Both access patterns are purely filesystem reads. No fleet orchestrator, no pi session,
no long-lived process is required on the dashboard side.
