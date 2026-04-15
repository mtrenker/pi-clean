// Fleet extension — live dashboard widget
//
// Subscribes to orchestrator events and renders a per-task status table
// above the editor via ctx.ui.setWidget().

import type {
  Orchestrator,
  TaskStatusEvent,
  TaskProgressEvent,
  TaskUsageEvent,
} from "./orchestrator.js";
import type { TaskState, TaskStatus } from "./task.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WIDGET_ID = "fleet";

/** Visual symbol per status. */
const STATUS_SYMBOL: Record<TaskStatus, string> = {
  running: "●",
  pending: "◌",
  done: "✓",
  failed: "✗",
  retrying: "✗",
};

/** Progress bar fill/empty characters. */
const FILL = "█";
const EMPTY = "░";
const BAR_LEN = 8;

/** Column widths (chars). Separator length = sum of all. */
const COL = {
  // "● " prefix — symbol + space
  prefix: 2,
  // "001-explore-auth   " — id-name, padded
  taskName: 20,
  sep1: 1,
  // "worker   " — agent name, padded
  agent: 9,
  sep2: 1,
  // "claude/sonnet  " — engine/model, padded
  engineModel: 15,
  sep3: 1,
  // "████░░░░" — progress bar
  bar: BAR_LEN,
  barTrail: 2, // two spaces after bar
  // "running  " — display status, padded
  status: 9,
  // " 12.4k" — token count (with leading space) or empty
  tokensPad: 1,
  tokens: 5,
};

/** Total line width including optional token column. */
const LINE_WIDTH =
  COL.prefix +
  COL.taskName +
  COL.sep1 +
  COL.agent +
  COL.sep2 +
  COL.engineModel +
  COL.sep3 +
  COL.bar +
  COL.barTrail +
  COL.status +
  COL.tokensPad +
  COL.tokens;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a token count for display.
 * ≥ 1 000 → "12.4k"; < 1 000 → raw string; 0 → empty string.
 */
function formatTokens(n: number): string {
  if (n === 0) return "";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/**
 * Build an 8-char progress bar appropriate for the given status.
 *
 * running  → fill one █ per 30 s elapsed, max 7; last char always ░ (activity indicator)
 * done     → ████████
 * failed / retrying → ████░░░░
 * pending / blocked → ░░░░░░░░
 */
function buildBar(status: TaskStatus, startedAt: string | null): string {
  switch (status) {
    case "done":
      return FILL.repeat(BAR_LEN);

    case "failed":
    case "retrying":
      return FILL.repeat(4) + EMPTY.repeat(4);

    case "running": {
      if (startedAt) {
        const elapsedSec =
          (Date.now() - new Date(startedAt).getTime()) / 1000;
        const filled = Math.min(Math.floor(elapsedSec / 30), 7);
        return FILL.repeat(filled) + EMPTY.repeat(BAR_LEN - filled);
      }
      // startedAt not yet set — show empty
      return EMPTY.repeat(BAR_LEN);
    }

    case "pending":
    default:
      return EMPTY.repeat(BAR_LEN);
  }
}

/**
 * Derive the human-readable status label for a task.
 * Pending tasks with unmet dependencies are shown as "blocked".
 */
function displayStatus(
  task: TaskState,
  allTasks: Map<string, TaskState>,
): string {
  if (task.status !== "pending") return task.status;
  const isBlocked = task.depends.some(
    (depId) => allTasks.get(depId)?.status !== "done",
  );
  return isBlocked ? "blocked" : "pending";
}

// ── FleetWidget ───────────────────────────────────────────────────────────────

export class FleetWidget {
  /** Local mirror of task states; updated incrementally on each event. */
  private tasks = new Map<string, TaskState>();

  private interval: ReturnType<typeof setInterval> | null = null;

  // Bound listeners kept so they can be removed in detach()
  private readonly _onStatus: (e: TaskStatusEvent) => void;
  private readonly _onProgress: (e: TaskProgressEvent) => void;
  private readonly _onUsage: (e: TaskUsageEvent) => void;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly setWidget: (id: string, lines: string[]) => void,
    private readonly clearWidget: (id: string) => void,
  ) {
    this._onStatus = (event: TaskStatusEvent) => {
      // event.state is a snapshot of the full TaskState
      this.tasks.set(event.id, { ...event.state });
      this.render();
    };

    this._onProgress = (_event: TaskProgressEvent) => {
      // Progress lines don't carry token/status data we don't already have;
      // re-render so the running bar animation stays current.
      this.render();
    };

    this._onUsage = (event: TaskUsageEvent) => {
      const state = this.tasks.get(event.id);
      if (state) {
        state.usage.inputTokens = event.inputTokens;
        state.usage.outputTokens = event.outputTokens;
      }
      this.render();
    };
  }

  /** Start listening to events and rendering. */
  attach(): void {
    // Seed from current snapshot so the widget is populated immediately
    for (const state of this.orchestrator.getSnapshot()) {
      this.tasks.set(state.id, { ...state });
    }

    this.orchestrator.on("task:status", this._onStatus);
    this.orchestrator.on("task:progress", this._onProgress);
    this.orchestrator.on("task:usage", this._onUsage);

    // Periodic re-render so the running progress bar animates even without events
    this.interval = setInterval(() => this.render(), 5_000);

    this.render();
  }

  /** Stop listening and clear the widget. */
  detach(): void {
    this.orchestrator.off("task:status", this._onStatus);
    this.orchestrator.off("task:progress", this._onProgress);
    this.orchestrator.off("task:usage", this._onUsage);

    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.clearWidget(WIDGET_ID);
  }

  /** Build the string array and push it to the UI widget slot. */
  private render(): void {
    if (this.tasks.size === 0) return;

    const tasks = [...this.tasks.values()].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );

    const lines: string[] = [];

    // ── Per-task rows ──────────────────────────────────────────────────────

    for (const task of tasks) {
      const symbol = STATUS_SYMBOL[task.status];
      const taskLabel = `${task.id}-${task.name}`.padEnd(COL.taskName);
      const agentCol = task.agent.padEnd(COL.agent);
      const engineModelCol = `${task.engine}/${task.model}`.padEnd(
        COL.engineModel,
      );
      const bar = buildBar(task.status, task.startedAt);
      const statusLabel = displayStatus(task, this.tasks).padEnd(COL.status);

      const total = task.usage.inputTokens + task.usage.outputTokens;
      const tokensStr = formatTokens(total);

      let row =
        `${symbol} ` +
        `${taskLabel} ` +
        `${agentCol} ` +
        `${engineModelCol} ` +
        `${bar}  ` +
        statusLabel;

      if (tokensStr) {
        row += " " + tokensStr;
      }

      lines.push(row);
    }

    // ── Separator ──────────────────────────────────────────────────────────

    lines.push("─".repeat(LINE_WIDTH));

    // ── Summary line ───────────────────────────────────────────────────────

    let running = 0;
    let done = 0;
    let failed = 0;
    let blocked = 0;
    let retrying = 0;
    let totalTokens = 0;

    for (const task of tasks) {
      totalTokens += task.usage.inputTokens + task.usage.outputTokens;
      switch (task.status) {
        case "running":
          running++;
          break;
        case "done":
          done++;
          break;
        case "failed":
          failed++;
          break;
        case "pending":
          blocked++;
          break;
        case "retrying":
          retrying++;
          break;
      }
    }

    const totalStr = formatTokens(totalTokens) || "0";

    let summary =
      `Running: ${running}  Done: ${done}  Failed: ${failed}  Blocked: ${blocked}`;
    if (retrying > 0) summary += `  Retrying: ${retrying}`;
    summary += `  │  Total tokens: ${totalStr}`;

    lines.push(summary);

    this.setWidget(WIDGET_ID, lines);
  }
}
