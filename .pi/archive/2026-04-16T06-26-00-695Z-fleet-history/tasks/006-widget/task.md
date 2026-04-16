# Task 006: Widget

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: 004

## Context

You are implementing the `fleet` extension for `pi`. The widget shows a live dashboard above the editor with per-task status, progress, and aggregate token usage. It subscribes to orchestrator events and updates via `ctx.ui.setWidget()`.

Tasks 001-004 are done. Read these files before starting:
- `extensions/fleet/orchestrator.ts` — `Orchestrator`, all event types
- `extensions/fleet/task.ts` — `TaskState`, `TaskStatus`
- `extensions/fleet/state.ts` — `AggregateState`

The pi TUI API is available via `@mariozechner/pi-tui`. Widgets are set with `ctx.ui.setWidget(id, lines | renderFn)`. The simplest approach is passing a string array. For richer output, pass a render function that returns a `Component`.

## File to Create

### `extensions/fleet/widget.ts`

#### Target Appearance

```
● 001-explore-auth     scout    pi/sonnet      ██████░░  running   12.4k
◌ 002-refactor-auth    worker   claude/sonnet  ░░░░░░░░  blocked
✓ 003-update-service   worker   codex/o3       ████████  done      8.1k
✗ 004-review-changes   reviewer claude/opus    ████░░░░  failed    3.2k
──────────────────────────────────────────────────────────────────────
Running: 1  Done: 1  Failed: 1  Blocked: 1  │  Total tokens: 23.7k
```

Symbols:
- `●` running
- `◌` pending/blocked
- `✓` done
- `✗` failed / retrying

Progress bar: 8 chars, filled with `█`, empty with `░`.
For `running`: fill based on elapsed time (fill one block per 30s, max 7, last is always empty to show activity).
For `done`: full `████████`.
For `failed`: half `████░░░░`.
For `blocked`/`pending`: empty `░░░░░░░░`.

Token count: show in `k` if >= 1000, e.g. `12.4k`, or raw if < 1000.

#### Class

```typescript
export class FleetWidget {
  constructor(
    private orchestrator: Orchestrator,
    private setWidget: (id: string, lines: string[]) => void,
    private clearWidget: (id: string) => void
  )

  // Start listening to events and rendering
  attach(): void

  // Stop listening and clear the widget
  detach(): void

  // Force a re-render (called on timer for progress bar animation)
  private render(): void
}
```

#### Implementation Notes

- Subscribe to `task:status`, `task:progress`, `task:usage` on the orchestrator
- Keep a local `Map<string, TaskState>` that is updated on each event (don't read disk)
- Call `render()` after every event update
- Also set a 5-second interval to re-render (so the running progress bar animates even with no events)
- In `render()`: build the string array and call `setWidget("fleet", lines)`
- In `detach()`: remove all event listeners, clear the interval, call `clearWidget("fleet")`
- Keep each row to a fixed width using padding — use padEnd() for alignment

#### Integration

`FleetWidget` is instantiated in `index.ts` (task 007). It receives the orchestrator instance and wraps `ctx.ui.setWidget` / `ctx.ui.setWidget(id, undefined)` as the clear call.

## Acceptance Criteria
- Widget renders correctly for all status types
- Updates immediately on each orchestrator event
- Animates every 5s when tasks are running (progress bar moves)
- Clears when detached
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
