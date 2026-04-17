# Fleet Extension — Operator Guide

The fleet extension orchestrates parallel Claude Code / Codex / pi tasks, renders a live dashboard widget above the editor, and provides an interactive inspector for per-task progress.

---

## Fleet config bootstrapping

Fleet reads project config from:

```text
.pi/fleet.json
```

When you run a fleet command that needs config and this file does not exist yet,
fleet creates `.pi/fleet.json` from the built-in defaults and shows an info
notification telling you to review it. This makes the active configuration
visible and editable instead of relying on hidden defaults.

If `.pi/fleet.json` already exists but contains invalid JSON, fleet stops with
an error. It does not silently fall back to defaults in that case.

The generated config is the place to adjust:

- engine commands and args
- execution profiles (`fast`, `balanced`, `deep`)
- agent prompts and allowed tools
- concurrency
- plan/task paths
- simulation settings

---

## Widget layout

The fleet widget renders a fixed-width table with one or two lines per task.

- **Collapsed mode (default)** keeps the summary/status bar visible and automatically follows the currently active work, so large plans do not push the interesting rows out of view.
- **Expanded mode** shows the full task list.
- **Running / failed / retrying / pending tasks** can show a second progress sub-line.
- **Done tasks** collapse to a single row to keep the widget compact.
- When there is **no active fleet execution**, the widget shows a small help panel instead of the live table.
- Toggle the widget with `/fleet:widget` or **Ctrl+Alt+F**. Use `/fleet:widget expand` or `/fleet:widget collapse` to control the viewport mode.

```
● 001-discover-context   scout     pi/sonnet       ░░░░░░░░  running   12.4k
  11:42:07 Scanning extensions/fleet/ for module exports and p...
◌ 002-implement-core     worker    claude/sonnet    ░░░░░░░░  blocked
✓ 003-build-widget       worker    codex/gpt-5.3... ████████  done
✗ 004-review-changes     reviewer  claude/opus      ████░░░░  failed
──────────────────────────────────────────────────────────────────────────
Running: 1  Done: 1  Failed: 1  Blocked: 1  │  Total tokens: 12.4k
```

### Reading the columns (left to right)

| Column | Width | What it shows |
|--------|------:|---------------|
| Symbol | 2 | Status glyph: `●` running · `◌` pending · `✓` done · `✗` failed/retrying |
| Task name | 20 | `<id>-<name>` — truncated with `...` if longer |
| Agent | 9 | Profile name (`worker`, `reviewer`, `scout`, …) |
| Engine/model | 15 | `<engine>/<model>` — truncated with `...` if longer |
| Progress bar | 8 | Running: fills one `█` per 30 s elapsed (max 7), last char always `░`; done: `████████`; failed: `████░░░░`; pending: `░░░░░░░░` |
| Status | 9 | `running` · `done` · `failed` · `retrying` · `pending` · `blocked` |
| Tokens | 6 | Per-task token total in `k` notation (`12.4k`); empty while 0 |

All columns are **fixed-width** — the widget width never changes as text updates, so your eye stays anchored on each column.

### Progress sub-line

When a task emits at least one progress step, a second line appears immediately below its main row:

```
  HH:MM:SS <message, padded or truncated to fill remaining width>
```

- The timestamp is formatted in **local time** as `HH:MM:SS`.
- The message area is exactly `LINE_WIDTH − 2 (indent) − 8 (ts) − 1 (gap) = 63` characters, padded with spaces or truncated with `...` to preserve alignment.
- Tasks with no progress data yet show only their main row.
- Done tasks stay collapsed even when they have historical progress.
- The sub-line updates live on every `task:progress` event from the orchestrator.

### Summary line

The last line below the separator reads:

```
Running: N  Done: N  Failed: N  Blocked: N  [Retrying: N]  │  Total tokens: X
```

> **Note**: Both `pending` (waiting on completed deps) and `blocked` (waiting on unfinished deps) tasks appear under **Blocked** in the summary. The per-row Status column distinguishes them.

---

## Running a demo

### `/fleet:demo`

Launches a pre-canned simulation using one of four presets:

| Preset | Concurrency | Failure rate | Duration |
|--------|-------------|--------------|----------|
| `happy` | 2 | 0 % | 2.5 – 5 s |
| `failure` | 2 | 45 % | 2.5 – 5 s |
| `parallel` | 3 | 10 % | 3 – 6 s |
| `big` | 3 | 15 % | 3 – 6.5 s (8 tasks) |

The demo creates a temporary task tree in a `mkdtemp` directory, wires up the simulate engine, attaches the widget, and tears everything down when done. No real files are modified.

Each preset ships with task-specific progress messages that deliberately exercise all three width categories:
- **Short** (<30 chars) — lots of trailing padding visible
- **Medium** (30–63 chars) — fills the message column comfortably
- **Long** (>63 chars) — truncated to 60 chars + `...`

### `/fleet:simulate`

Runs the simulate engine against the real task tree in `.pi/tasks/`. Useful for verifying widget behaviour against your actual PLAN.md without spending tokens.

---

## Widget controls

### `/fleet:widget <show|hide|toggle|status|expand|collapse>`

Controls the visibility and viewport mode of the fleet widget:

- `show` — show the widget again
- `hide` — hide it completely
- `toggle` — switch between shown and hidden
- `status` — report whether the widget is currently visible and whether it is expanded or collapsed
- `expand` — show the full task list
- `collapse` — return to the compact auto-following viewport

Shortcut:

- **Ctrl+Alt+F** — toggle the widget

When the widget is visible but no fleet is actively running, it shows an idle/help panel with quick hints for `/fleet:start`, `/fleet:demo`, and `/fleet:status`.

### `/fleet:repair-usage`

Backfills missing token counts for historical **Codex** tasks by reading saved `output.jsonl` files and extracting the latest usage event (`done` or `turn.completed`). This is useful after older runs where Codex usage was recorded in output history but not written into `status.json`.

---

## Inspector (`/fleet:inspect`)

Open the interactive inspector to drill into any task:

- **↑ / ↓** — navigate tasks
- **← / →** — cycle screens: `overview` · `progress` · `output` · `task` · `recovery`
- **Esc** — close

The `overview` screen shows `progressAt` and `progressMsg` read live from `progress.jsonl`, so you can confirm the widget sub-line matches the underlying file.

---

## Locally verifying widget behaviour

Run the regression suite without starting any real agent:

```bash
node --test extensions/fleet/widget.test.ts
```

The widget tests cover:

1. **Fixed-width truncation** — all columns are exactly `LINE_WIDTH` characters regardless of content length.
2. **Status column** — `pending` / `blocked` / `running` / `done` / `failed` / `retrying` labels render in the correct column.
3. **Progress sub-line on event** — emitting a `task:progress` event inserts a correctly-padded sub-line.
4. **Long-message truncation** — a 200-character message is truncated to `LINE_WIDTH` with trailing `...`.
5. **Snapshot seeding** — progress carried in the `RuntimeTaskState` snapshot renders a sub-line immediately on `attach()`.
6. **No sub-line for empty progress** — tasks without any progress data render a single row only.

Run the full fleet test suite:

```bash
node --test extensions/fleet/state.test.ts \
         extensions/fleet/plan.test.ts \
         extensions/fleet/config.test.ts \
         extensions/fleet/task.test.ts \
         extensions/fleet/widget.test.ts \
         extensions/fleet/engines/codex.test.ts
```

And type-check with:

```bash
npx tsc --noEmit
```

Both should report zero errors before any widget change is merged.

---

## Wiring `taskSteps` for realistic demos

Add a `taskSteps` map to `SimulateConfig` (in `.pi/fleet.json` or programmatically) to supply realistic per-task progress messages:

```json
{
  "simulate": {
    "taskDurationMs": [3000, 6000],
    "progressIntervalMs": 800,
    "failureRate": 0.1,
    "taskSteps": {
      "Build widget": [
        "Reviewing widget render loop and existing column layout constants",
        "Adding PROGRESS_TS_LEN and PROGRESS_GAP constants",
        "Implementing formatProgressLine() with fixed-width ts + message"
      ]
    }
  }
}
```

Keys must match the task `name` field in `task.md` exactly. Tasks without a matching key fall back to the built-in ten-step generic list.
