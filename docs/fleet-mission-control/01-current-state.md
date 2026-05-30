# Fleet Mission Control — 01: Current State & Flightdeck Handoff Map

> Scope: Read-only reconnaissance of the existing `extensions/fleet/` implementation
> and the Flightdeck upgrade handoff
> (`/home/martin/ai/hub/apps/flightdeck/docs/PI_CLEAN_FLEET_UPGRADE_HANDOFF.md`).
> This document is the baseline reference for tasks 002–010. It records exactly what
> the fleet writes to disk today, what Flightdeck can already read, where run identity
> and project context are missing, and the acceptance criteria each later task must meet.

---

## 1. Source files inspected

| File | Role today |
| --- | --- |
| `extensions/fleet/orchestrator.ts` | Schedules tasks up to `config.concurrency`, spawns engine processes, owns the in-memory `RuntimeTaskState` map, persists `status.json` + `state.json`, emits `task:status` / `task:progress` / `task:usage` / `fleet:done`. |
| `extensions/fleet/state.ts` | Builds and atomically writes the aggregate `.pi/tasks/state.json` (`buildAggregateState` / `writeAggregateState` / `readAggregateState`). Defines `AggregateState`. |
| `extensions/fleet/task.ts` | Per-task folder lifecycle: `taskDir`, `createTaskFolder`, `syncTaskFolder`, `readStatus`/`writeStatus`, `appendProgress`/`readProgress`, `listTasks`. Defines `TaskState`, `TaskStatus`, `ProgressEntry`, and the `task.md` template. |
| `extensions/fleet/archive.ts` | Plan/archive summaries (`plan-summary.json`, `archive-summary.json`), archival into `.pi/archive/<id>/`, `index.json`, `archive-entry.json`. Defines `PlanSummary`, `ArchiveSummary`, `ArchiveIndexEntry`. |
| `extensions/fleet/inspect.ts` | TUI inspector overlay; reads each task folder's `progress.jsonl`, `output.jsonl`, `task.md`, `recovery.md`, and `status.json` (via `listTasks`). Screens: overview/progress/output/task/recovery. |
| `extensions/fleet/widget.ts` | Live dashboard widget driven purely by orchestrator events (no disk reads). Renders per-task rows, progress bars, and a summary line. |
| `extensions/fleet/config.ts` | Loads layered config (built-in → user `~/.pi/agent/fleet.json` → project `.pi/fleet.json`), resolves agent prompts, profiles, model aliasing, and per-engine thinking maps. Defines `FleetConfig`. |
| `extensions/fleet/recovery.ts` | On first failure, writes per-task `recovery.md` and calls `orchestrator.retry()`; on second failure, notifies the operator. |
| `extensions/fleet/engines/types.ts` | `Usage` shape (`inputTokens`, `outputTokens`, optional cache fields), `normalizeUsage`, `totalUsageTokens`, `EngineProcess`/`EngineAdapter` contracts. |

---

## 2. Every file the fleet writes under `.pi/`

### 2.1 Top-level run state — `.pi/tasks/`

| Path | Producer | Notes |
| --- | --- | --- |
| `.pi/tasks/state.json` | `state.ts::writeAggregateState` (called from orchestrator on every status/progress/usage change) | The single aggregate view. Atomic write (`.tmp` + `rename`). Shape = `AggregateState`. |
| `.pi/tasks/plan-summary.json` | `archive.ts::writePlanSummary` | Snapshot of the parsed `PLAN.md` at split time. Shape = `PlanSummary`. |
| `.pi/tasks/archive-summary.json` | `archive.ts::writeArchiveSummary` | Pre-archive rollup of all current tasks. Shape = `ArchiveSummary`. Removed on `clearActiveTaskSummaries`. |
| `.pi/tasks/config.json` | (not produced by these modules; copied if present during archive) | `archiveTaskFolders` copies it into the archive when it exists. |

> Observed live in this repo right now: `.pi/tasks/state.json`, `.pi/tasks/plan-summary.json`,
> plus task folders `001-…` through `010-…`.

### 2.2 Per-task folder — `.pi/tasks/<id>-<slug>/`

`taskDir(cwd, id, name)` → `.pi/tasks/<id>-<slug>`. Folder pattern recognized by
`listTasks` / `listTaskFolders`: `^(\d+)-(.+)$`.

| File | Producer | Notes |
| --- | --- | --- |
| `task.md` | `task.ts::renderTaskMd` (via `createTaskFolder` / `syncTaskFolder`) | Human + agent brief: configuration block, dependencies, dependency-handoff instructions, requirements, workspace rules, progress-tracking and completion-handoff instructions. Re-rendered on sync. |
| `status.json` | `task.ts::writeStatus` (called by orchestrator) | Canonical per-task `TaskState`. Atomic write. **Also carries the runtime-only `latestProgressAt` / `latestProgressMessage` fields** because the orchestrator passes a `RuntimeTaskState` to `writeStatus` (see §4). |
| `progress.jsonl` | `task.ts::appendProgress` (orchestrator, fire-and-forget) | Append-only `ProgressEntry` lines: `{ ts, step, status }`. Parsed defensively by orchestrator, inspector, and `buildAggregateState`. |
| `output.jsonl` | engine adapter (raw stream written to `outputJsonlPath`); seeded empty by `createTaskFolder` | Raw engine stream-json/JSONL. Read by `recovery.ts::extractOutputText` and the inspector. |
| `handoff.md` | written by the task agent itself (per `task.md` instructions); **not** produced by fleet code | Compact downstream summary. Listed in the Flightdeck handoff as consumable, but fleet never creates or validates it. |
| `recovery.md` | `recovery.ts::handleFailure` (first failure only) | Failure context + retry instructions. Copied into archives. |

### 2.3 Archive tree — `.pi/archive/`

| Path | Producer | Notes |
| --- | --- | --- |
| `.pi/archive/index.json` | `archive.ts::updateArchiveIndex` | `{ version: 1, archives: ArchiveIndexEntry[] }`, sorted by `archivedAt`. |
| `.pi/archive/<archiveId>/archive-entry.json` | `archive.ts::archiveTaskFolders` | One `ArchiveIndexEntry`. `archiveId = <timestamp>-<slugified plan title>`. |
| `.pi/archive/<archiveId>/plan-summary.json` | copied if present | |
| `.pi/archive/<archiveId>/archive-summary.json` | copied if present | |
| `.pi/archive/<archiveId>/state.json` | copied if present | |
| `.pi/archive/<archiveId>/config.json` | copied if present | |
| `.pi/archive/<archiveId>/tasks/<folder>/{task.md,status.json,progress.jsonl,recovery.md}` | copied per archived task | `output.jsonl` is **not** copied into archives. |

### 2.4 Config inputs (read, not written by a run)

| Path | Notes |
| --- | --- |
| `~/.pi/agent/fleet.json` (or `$PI_FLEET_USER_CONFIG`) | Optional user config layer. |
| `.pi/fleet.json` | Optional project config layer (`projectFleetConfigPath`). Never auto-created during normal commands. |

---

## 3. Fields Flightdeck can read today

### 3.1 `.pi/tasks/state.json` (`AggregateState`)

```jsonc
{
  "updatedAt": "ISO",                 // recomputed on every write
  "tasks": [
    {
      "id": "001",
      "name": "<slug>",
      "agent": "scout",
      "engine": "claude",
      "model": "claude-opus-4-8",
      "status": "pending|running|done|failed|retrying",
      "startedAt": "ISO|null",
      "completedAt": "ISO|null",
      "latestProgressAt": "ISO|null",
      "latestProgressMessage": "string|null",
      "lastProgress": "string|null",  // backwards-compatible alias of latestProgressMessage
      "blockedBy": ["<id>", ...] | null,
      "usage": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationInputTokens": 0?,  // optional, present only when non-zero
        "cacheReadInputTokens": 0?       // optional, present only when non-zero
      }
    }
  ],
  "summary": {
    "total","pending","running","done","failed","retrying": number,
    "totalInputTokens","totalOutputTokens",
    "totalCacheCreationInputTokens","totalCacheReadInputTokens",
    "totalTokens": number
  }
}
```

**Readable today:** task identity (id/name/agent/engine/model), lifecycle status,
start/complete timestamps, latest progress message + time, dependency-blocking
(`blockedBy`), per-task token usage, and an aggregate `summary` with rolled-up
counts and token totals.

### 3.2 Per-task `status.json` (`TaskState` + runtime overflow)

```jsonc
{
  "id","name","status","engine","model","agent": string,
  "profile": "string?",          // optional
  "thinking": "string?",         // optional
  "depends": ["<id>", ...],
  "startedAt","completedAt": "ISO|null",
  "duration": number|null,       // ms; NOT surfaced in state.json
  "retries": number,             // NOT surfaced in state.json
  "pid": number|null,            // NOT surfaced in state.json
  "error": "string|null",        // NOT surfaced in state.json
  "usage": { inputTokens, outputTokens, cache* },
  "latestProgressAt": "ISO|null",      // runtime field leaked via writeStatus
  "latestProgressMessage": "string|null"
}
```

`status.json` is richer than `state.json`: it additionally exposes `profile`,
`thinking`, `depends` (full list, not just unmet), `duration`, `retries`, `pid`,
and `error`. Flightdeck must read per-task `status.json` to get failure detail
and retry counts.

### 3.3 Other readable artifacts

- `progress.jsonl` — append-only `{ ts, step, status: "running"|"done"|"error" }`.
- `output.jsonl` — raw engine stream (provider-specific JSON shapes).
- `task.md` — full brief (configuration/dependencies/requirements/rules).
- `recovery.md` — present only after a first failure.
- `plan-summary.json` (`PlanSummary`) — `title`, `overview`, `splitAt`, `sourcePlanPath`, `taskCount`, and per-task plan specs.
- `archive-summary.json` (`ArchiveSummary`) — plan rollup + `summary` totals + per-task records including `duration`, `retries`, `error`, `progressEntries`, `lastProgress`.
- `.pi/archive/index.json` + `archive-entry.json` (`ArchiveIndexEntry`) — `id`, `archivedAt`, `reason`, `title`, `taskCount`, `archivePath`, `taskFolders`, `summary`.

---

## 4. Where run identity and project context are missing

These gaps are the substance of the Flightdeck handoff and drive tasks 002–006.

1. **No stable fleet run id.** Nothing in `orchestrator.ts`, `state.ts`, or `task.ts`
   generates or persists a `runId`. `AggregateState` has no run identifier; there is
   no `.pi/tasks/run.json`. Flightdeck cannot correlate a `state.json` snapshot with a
   specific run, and successive runs overwrite the same `state.json` with no lineage.
   → **Task 002** (run.json + runId in state.json).

2. **No project / repo / worktree context.** `cwd` is held only in the `Orchestrator`
   constructor and never serialized. There is no `repoRoot`, `gitRemote`,
   `currentBranch`, `worktreePath`, `headSha`, or `dirtyAtStart` anywhere on disk.
   Flightdeck must infer the project from the file path. → **Task 002** (`git-context.ts`).

3. **No heartbeat / staleness signal.** State carries `startedAt`/`completedAt` and
   `latestProgressAt`, but no `lastHeartbeatAt`, `lastOutputAt`, or `staleAfterSeconds`.
   A hung process looks identical to a slow-but-healthy one. The widget animates a bar
   purely from wall-clock elapsed since `startedAt` — not a liveness signal.
   → **Task 004** (heartbeat timestamps).

4. **Usage shape is not normalized / has no provenance.** `Usage` omits cache fields
   when zero (`normalizeUsage` drops them), has **no `totalTokens` on the task object**
   (only computed ad hoc via `totalUsageTokens`, and only rolled into `summary`), and
   has **no `source` or `updatedAt`**. Flightdeck cannot tell engine-reported usage from
   backfilled or unknown usage, and must recompute totals itself. → **Task 004**.

5. **No human-attention hints.** Failure/blocked/stale/missing-handoff conditions are
   implicit. `error` and `blockedBy` exist, but there is no structured `attention[]`
   array with `category`/`severity`/`message`/`createdAt`. → **Task 005**.

6. **No normalized event stream.** The orchestrator emits in-memory events
   (`task:status`, `task:progress`, `task:usage`, `fleet:done`) but never persists them.
   There is no `.pi/tasks/events.jsonl`, so timeline replay after the fact is impossible.
   → **Task 003**.

7. **Archive summaries lack run lineage.** `ArchiveIndexEntry` / `ArchiveSummary` carry
   plan title and status totals but **no `runId`, `cwd`, `repoRoot`, `branch`, or
   run-level `startedAt`/`completedAt`/`status`**. Archived history cannot be correlated
   with active project history. → **Task 006**.

8. **Runtime field leakage (cleanup risk).** `writeStatus` receives a `RuntimeTaskState`,
   so `status.json` already contains `latestProgressAt`/`latestProgressMessage` even
   though `TaskState` (the declared on-disk type) does not include them. Any schema work
   in tasks 002/004 should treat this intentionally rather than accidentally.

---

## 5. Acceptance criteria for the later implementation tasks

Derived from the handoff's "Acceptance criteria" (§278–289) and "Backward
compatibility" (§243–251) sections, plus the gaps above. The overarching constraint:
**all changes are additive and `schemaVersion`-stamped; no existing field is removed
or renamed; existing widget, inspect, simulate, and status surfaces keep working.**

### AC-0 — Backward compatibility (applies to every task)
- `.pi/tasks/state.json`, per-task `status.json`, `progress.jsonl`, `output.jsonl`,
  and `handoff.md` continue to exist with their current fields intact.
- New fields are added, never substituted; new top-level schemas carry `schemaVersion`.
- Flightdeck can ingest both old (no runId/events) and new formats. Old files parse
  without errors; missing new fields are treated as "degraded but usable".
- `extensions/fleet/*.test.ts` continue to pass; new tests cover the additions.

### AC-1 — Run metadata & project context (Task 002)
- Starting a fleet (`/fleet:start`, `/fleet:simulate`, or equivalent) writes
  `.pi/tasks/run.json` with: `schemaVersion`, stable `runId`
  (`flt_YYYYMMDD_HHMMSS_<short-random>`), `startedAt`, `completedAt` (null until done),
  `status`, `cwd`, `planPath`, `configPath`, `trigger`, `concurrency`.
- `.pi/tasks/state.json` includes `runId` and a `schemaVersion`.
- A `project` block records `cwd`, `repoRoot`, `gitRemote`, `currentBranch`,
  `worktreePath`, `headSha`, `dirtyAtStart`. Git failures do **not** abort startup —
  missing values are `null` and a warning is surfaced (event/log), not an exception.
- `runId` is allocated once per run and is stable across all writes within that run.

### AC-2 — Timeline events (Task 003)
- Append-only `.pi/tasks/events.jsonl` records events with at least:
  `ts`, `runId`, `type`, and (where applicable) `taskId`/`taskName`/`data`.
- Event types cover: `fleet_started`, `fleet_completed`, `fleet_stopped`,
  `task_created`, `task_status_changed`, `task_progress`, `task_usage_updated`,
  `task_failed`, `task_retried`, `task_handoff_written`, `archive_created`,
  `plan_validated`, `operator_command` (implement the subset the orchestrator can
  currently emit; document any deferred types).
- Events are emitted from the existing orchestrator event hooks; writing is
  append-only and resilient to partial lines (consumers parse defensively).

### AC-3 — Normalized usage & heartbeat (Task 004)
- Every task's `usage` envelope always includes a numeric `totalTokens`,
  `cacheCreationInputTokens`, `cacheReadInputTokens` (0 when absent, not omitted),
  a `source` of `engine-event | backfill | unknown`, and an `updatedAt`.
- Unknown usage is `0` with `source: "unknown"` — never missing.
- Claude/Codex/pi adapters map provider fields into this one shape.
- Each task state gains `lastHeartbeatAt`, `lastOutputAt`, `lastProgressAt`, and
  `staleAfterSeconds`; heartbeat advances on output, valid progress lines, usage/status
  changes, or confirmed liveness.

### AC-4 — Attention hints (Task 005)
- Tasks expose an `attention[]` array of `{ category, severity, message, createdAt }`.
- Categories include `task_failed`, `task_retrying`, `task_blocked`, `missing_handoff`,
  `stale_running_task`, `usage_unavailable`, `plan_validation_failed`,
  `operator_review_needed`. Fleet emits high-confidence hints only; Flightdeck still
  dedupes/lifecycles them.

### AC-5 — Archive run history (Task 006)
- Archive summaries/entries preserve `runId`, `cwd`, `repoRoot`, `branch`, `planPath`,
  run `startedAt`/`completedAt`/`status`, and total usage (`summary.totalTokens`).
- Archived runs are correlatable with active project history via `runId`.

### AC-6 — Operator surfaces (Task 007)
- Widget, inspector, and status commands surface (or at minimum tolerate) run id,
  heartbeat/staleness, normalized usage, and attention hints without regressing the
  existing layout or the ≤10-line widget viewport cap.

### AC-7 — Tests & fixtures (Task 008)
- Fixtures for both old-format and new-format `.pi/tasks/` trees; tests assert
  forward/backward parse compatibility, run metadata, events, usage normalization,
  and heartbeat behavior.

### AC-8 — Simulation & ingestion docs (Task 009)
- `/fleet:simulate` exercises the new run/event/usage/attention paths end-to-end and
  produces a representative `.pi/tasks/` tree; mission-control ingestion expectations
  are documented.

### AC-9 — Final review & rollout (Task 010)
- All acceptance criteria verified together; rollout guidance and any migration notes
  documented; full test suite green.

---

## 6. Quick reference — file → schema → owning module

| Disk artifact | Schema/type | Module |
| --- | --- | --- |
| `.pi/tasks/state.json` | `AggregateState` | `state.ts` |
| `.pi/tasks/<id>-<slug>/status.json` | `TaskState` (+ runtime progress fields) | `task.ts` |
| `.pi/tasks/<id>-<slug>/progress.jsonl` | `ProgressEntry[]` | `task.ts` |
| `.pi/tasks/<id>-<slug>/output.jsonl` | raw engine stream | engine adapters |
| `.pi/tasks/<id>-<slug>/task.md` | template string | `task.ts` |
| `.pi/tasks/<id>-<slug>/recovery.md` | template string | `recovery.ts` |
| `.pi/tasks/<id>-<slug>/handoff.md` | freeform (agent-authored) | — (none) |
| `.pi/tasks/plan-summary.json` | `PlanSummary` | `archive.ts` |
| `.pi/tasks/archive-summary.json` | `ArchiveSummary` | `archive.ts` |
| `.pi/archive/index.json` | `{ version, archives: ArchiveIndexEntry[] }` | `archive.ts` |
| `.pi/archive/<id>/archive-entry.json` | `ArchiveIndexEntry` | `archive.ts` |
| `.pi/fleet.json` / `~/.pi/agent/fleet.json` | `FleetConfig` (partial layers) | `config.ts` |

**Net new artifacts proposed by the handoff (do not exist today):**
`.pi/tasks/run.json`, `.pi/tasks/events.jsonl`, and the proposed modules
`run.ts`, `events.ts`, `git-context.ts`, `attention.ts`.
