# 10 · Rollout & Operator Guidance

Final rollout guide for the fleet **Mission Control** work (Tasks 002–009). This
is the last document in the `docs/fleet-mission-control/` series and assumes you
have skimmed [`09-validation.md`](./09-validation.md) (end-to-end evidence) and
[`01-current-state.md`](./01-current-state.md) (file inventory).

Audience: **Martin**, operating the `@mtrenker/pi-clean` package and building the
separate **Hub Flightdeck** dashboard app.

---

## 0. What shipped (one-paragraph recap)

The fleet extension now writes operator-readable, **forward-compatible** metadata
under `.pi/tasks/` on every run:

- `run.json` — run identity (`runId`, `schemaVersion: 1`), `status`, config-source
  layers, concurrency, and best-effort git context.
- `events.jsonl` — append-only timeline (`ts`, `runId`, `type`, optional `taskId`,
  small `data`).
- `state.json` — aggregate task state, **normalized** usage envelopes, heartbeat /
  staleness fields, and a new top-level `attentionHints[]`.
- Per-task `status.json` — normalized usage + heartbeat fields.
- Archive summaries now carry run-lineage metadata.

Every change is **additive**. Pre-upgrade task trees keep loading: missing files
read as `legacy`/`null`/defaults rather than throwing. Verified by 84/84 tests and
by this live `.pi/tasks/` tree, which is itself a pre-upgrade (old-format) fleet
run and still reads cleanly.

---

## 1. Reload the git-loaded extension

The extension is loaded from git, not a local checkout, so reloading is a
**publish → re-install → restart** cycle.

### 1.1 Publish the changes

```bash
# from the pi-clean repo root
git add -A
git commit -m "Fleet Mission Control: run/events/state metadata + docs"
git push origin <branch>          # merge to the branch pi installs from (e.g. main)
```

> Fleet is installed via `pi install git:git@github.com:mtrenker/pi-clean.git`,
> so pi pulls whatever the install branch points at. Changes are not visible to
> any pi session until they land on that branch.

### 1.2 Re-install / update in the consuming environment

```bash
# Re-run the installer to pull the latest commit…
pi install git:git@github.com:mtrenker/pi-clean.git
# …or, if you keep a managed package list, update it:
pi update @mtrenker/pi-clean
```

### 1.3 Restart the pi session

Extensions are wired at session startup (`index.ts` registers commands, widget,
and tools once). **Reloading the package does not hot-swap a running session** —
exit and relaunch pi so the new `fleet` module is loaded.

### 1.4 Smoke-test after reload

```bash
# Tests (run from the pi-clean repo, with the repo's jiti TS loader):
node --import ./node_modules/@mariozechner/jiti/lib/jiti-register.mjs \
  --test extensions/fleet/*.test.ts extensions/fleet/engines/*.test.ts
# Expect: 84/84 pass.
```

In a live pi session, confirm the wiring:

- `/fleet:config show` → prints effective config + source layers (no crash).
- `/fleet:validate` then `/fleet:simulate` → `.pi/tasks/run.json` and
  `events.jsonl` appear; `state.json` gains `attentionHints`.
- `/fleet:inspect` → `overview` / `attention` / `events` screens render.
- `/fleet:widget` (or **Ctrl+Alt+F**) → footer shows `run <id> <status>`.

> **Config note:** fleet **no longer auto-creates** `.pi/fleet.json`. It is
> optional; use `/fleet:config init-project` / `export-project` to materialize a
> project override. (The root `README.md` was corrected in this task — it
> previously claimed the file is auto-created.)

---

## 2. What Flightdeck should read first

Flightdeck is a **read-only** consumer. It must never write into `.pi/`. Poll on
an interval (2–5 s is plenty) and read files in this priority order. The full
field-availability matrix lives in `09-validation.md §4`; this is the load order.

### 2.1 Read order for an active run

1. **`.pi/tasks/run.json`** — read **first**. Establishes run identity.
   - Gate on `schemaVersion`. This release is `1`; **degrade or warn on any
     unknown version** rather than mis-parsing.
   - Absent → this is a `legacy` run; render with reduced fidelity, don't error.
2. **`.pi/tasks/state.json`** — the **primary dashboard payload**. Gives you
   `tasks[]` (status, normalized `usage`, heartbeat/stale fields), `summary`
   totals, and `attentionHints[]`.
   - Treat a missing `attentionHints` as `[]` (means "nothing noteworthy", not
     "unsupported").
3. **`.pi/tasks/events.jsonl`** — the timeline. **Filter by the `runId`** from
   step 1; the file accumulates across runs and is never rotated. Pre-upgrade
   lines carry `runId: "legacy"`.
4. **On demand only** (when the operator drills into one task):
   - `.pi/tasks/<id>-<slug>/status.json` — per-task detail.
   - `.pi/tasks/<id>-<slug>/progress.jsonl` — per-task progress stream.

### 2.2 Read order for history (archived runs)

1. `.pi/archive/index.json` — the archive list.
2. `.pi/archive/<id>/archive-summary.json` — detail + artifact paths + run lineage.
3. `.pi/archive/<id>/run.json` and `.pi/archive/<id>/events.jsonl` — archived
   context and timeline for that run.

### 2.3 Hard rules for the consumer

- **Version-gate** on `run.json.schemaVersion` (`RUN_SCHEMA_VERSION = 1`).
- **Scope everything to `runId`.** `events.jsonl` and `attentionHints` mix runs;
  `runId` is the only safe partition key.
- **`AttentionHint.dedupeKey` is the stable identity** of a condition across
  polls. A key that **disappears** between polls = condition resolved. (Code
  format: `<category>:task:<taskId>:<runId>` for task hints,
  `<category>:fleet:<runId>` for fleet-level hints. Use it opaquely — match on
  equality, do not parse it.)
- **Tolerate legacy / partial data.** Missing `run.json`, `events.jsonl`,
  heartbeat fields, or normalized usage are expected on old trees and must render
  as `legacy` / `-` / `0`, never as a fatal error.
- **Don't expect transcripts.** `events.jsonl` is metadata only — strings are
  truncated to 500 chars by the event sanitizer (see §4). Full per-task output is
  in each task's `output.jsonl`, which Flightdeck reads only on explicit drill-in.

---

## 3. Follow-up work: Hub Flightdeck app vs. pi-clean

The boundary: **pi-clean owns producing correct, versioned, read-only state on
disk. The Hub Flightdeck app owns consuming, presenting, and persisting it.** When
in doubt, if the work needs UI, cross-run history beyond what `.pi/archive/` holds,
notifications, or multi-project aggregation, it belongs in Flightdeck.

### 3.1 Belongs in **pi-clean** (this repo)

These are schema/producer concerns. Address before or shortly after rollout:

- **`run.json` has no `completedAt`.** Add it in a future schema version (bump
  `RUN_SCHEMA_VERSION` to `2`); `updateRunStatus` already exists as the write
  path. (Known limitation #5.)
- **`events.jsonl` is never rotated/compacted.** If files grow unboundedly,
  rotation belongs here, on the producer side. (Known limitation #6.) Until then,
  the documented contract is "consumer filters by `runId`."
- **`/fleet:simulate` overwrites `run.json`** each invocation while old events
  persist with a stale `runId` — only matters for demos, but it is a producer
  bug to clean up. (Known limitation #9.)
- **Any new field a dashboard needs** (e.g. per-task config-source provenance,
  byte-level output vs. progress distinction) is a schema change → here, behind a
  version bump.

### 3.2 Belongs in the **Hub Flightdeck app** (separate repo)

These are presentation/consumer concerns — keep them out of pi-clean:

- **The dashboard UI itself**: rendering `state.json`, the timeline view over
  `events.jsonl`, the archive/history browser.
- **Polling, caching, and diffing** across refreshes; **`dedupeKey`-based
  notifications/alerting** when an attention hint appears or persists.
- **Cross-run and cross-project aggregation** (multiple `.pi/` trees, long-term
  retention beyond `.pi/archive/`) — pi-clean only knows about the current repo's
  `.pi/`.
- **Operator actions** (retry, stop, re-plan) initiated from the dashboard. If
  Flightdeck ever needs to *act*, it should drive pi/fleet through a defined
  command surface, **never by writing into `.pi/` directly**.
- **Interpreting `staleAfterSeconds`** into red/amber UI and any per-tenant
  staleness policy (the field is currently a fixed 300 s hint, limitation #4).

---

## 4. Reviewer sign-off (acceptance criteria)

Result of the final review across `extensions/fleet/`,
`docs/fleet-mission-control/`, and the generated `.pi/tasks/` state files:

| Criterion | Status | Evidence |
|---|---|---|
| Backward compatibility | ✅ | `readStatus` defaults pre-004 fields; `readRunMetadata`/`readAggregateState` return `null`/`[]` on absence. Live `.pi/tasks/` is an old-format tree and loads cleanly. `task.test.ts` / `state.test.ts` pin legacy + mixed-format coverage. |
| Additive schema changes | ✅ | `run.json` is new (`schemaVersion: 1`); `attentionHints` is a new top-level array (absence ⇒ `[]`); usage normalization only *adds* `cache*`/`totalTokens`/`source`/`updatedAt`. No field removed or repurposed. |
| No transcript persistence in `events.jsonl` | ✅ | `events.ts` `sanitizeValue` truncates strings to 500 chars, caps array/object width and depth. `task_progress` events store only the parsed `step`, not raw engine output. Full output stays in per-task `output.jsonl`. |
| No widget/inspect/status regressions | ✅ | Full suite 84/84 (incl. widget tests); inspector `overview`/`attention`/`events` screens and widget footer read the new files with `legacy` fallbacks. |
| Clear operator documentation | ✅ | `09-validation.md` (ingestion protocol + field matrix) and this `10-rollout.md` (reload steps, read order, repo boundary). Stale root-README config claim corrected. |

**Verdict: approved for rollout.** No blocking issues found.

### Non-blocking notes carried forward

- `dirtyAtStart` is `null` (not `false`) for a clean repo — intentional, test-pinned
  (limitation #1). Consumers should treat `null` as "undetermined," not "dirty."
- `lastOutputAt` and `lastProgressAt` share a timestamp under the current wire
  protocol (limitation #3) — fine for staleness, not for byte-level activity.
- The `dedupeKey` format quoted in `09-validation.md §key contracts` lists four
  colon-separated segments; the code emits three for fleet-level hints
  (`<category>:fleet:<runId>`). Cosmetic doc nuance only — the key is stable and
  must be consumed opaquely, so no behavior changes. Worth tidying on the next doc
  pass.

See `09-validation.md §Known limitations` for the full list (10 items); none block
rollout, and the producer-side items are tracked in §3.1 above.
