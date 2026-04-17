// Fleet extension — live dashboard widget
//
// Subscribes to orchestrator events and renders a per-task status table
// above the editor via ctx.ui.setWidget().

import type {
  Orchestrator,
  TaskStatusEvent,
  TaskProgressEvent,
  TaskUsageEvent,
  RuntimeTaskState,
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

/** Layout constants for the progress sub-line. */
const PROGRESS_TS_LEN = 8; // "HH:MM:SS"
const PROGRESS_GAP = 1; // single space between timestamp and message
const PROGRESS_MSG_WIDTH = LINE_WIDTH - COL.prefix - PROGRESS_TS_LEN - PROGRESS_GAP;

/**
 * Default collapsed viewport height for the widget.
 * We reserve 2 lines for the separator + summary/status bar.
 */
const DEFAULT_MAX_VISIBLE_LINES = 16;
const FOOTER_LINES = 2;
const DEFAULT_MAX_TASK_LINES = DEFAULT_MAX_VISIBLE_LINES - FOOTER_LINES;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fit text into a fixed-width column.
 * Overflow is truncated with "..." when possible.
 */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length === width) return text;
  if (text.length < width) return text.padEnd(width);
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

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
 * Format an ISO timestamp string as "HH:MM:SS" (local time).
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/**
 * Build the progress sub-line for a task.
 * Returns a LINE_WIDTH string when progress data exists, or empty string otherwise.
 *
 * Layout: <prefix-spaces><HH:MM:SS><space><message padded/truncated>
 */
function formatProgressLine(
  task: TaskState,
  progress: Map<string, { at: string; message: string }>,
): string {
  if (task.status === "done") return "";

  const entry = progress.get(task.id);
  if (!entry) return "";

  const indent = " ".repeat(COL.prefix);
  const ts = formatTimestamp(entry.at);
  const msg = fit(entry.message, PROGRESS_MSG_WIDTH);

  return indent + ts + " " + msg;
}

function formatTaskLabelColumn(task: TaskState): string {
  return fit(`${task.id}-${task.name}`, COL.taskName);
}

function formatAgentColumn(task: TaskState): string {
  return fit(task.agent, COL.agent);
}

function formatEngineModelColumn(task: TaskState): string {
  return fit(`${task.engine}/${task.model}`, COL.engineModel);
}

function formatBarColumn(task: TaskState): string {
  return fit(buildBar(task.status, task.startedAt), COL.bar);
}

function formatStatusColumn(task: TaskState, allTasks: Map<string, TaskState>): string {
  return fit(displayStatus(task, allTasks), COL.status);
}

function formatTokensColumn(totalTokens: number): string {
  return fit(" ", COL.tokensPad) + fit(formatTokens(totalTokens), COL.tokens);
}

function formatTaskRow(task: TaskState, allTasks: Map<string, TaskState>): string {
  const symbolCol = fit(`${STATUS_SYMBOL[task.status]} `, COL.prefix);
  const totalTokens = task.usage.inputTokens + task.usage.outputTokens;

  return (
    symbolCol +
    formatTaskLabelColumn(task) +
    fit(" ", COL.sep1) +
    formatAgentColumn(task) +
    fit(" ", COL.sep2) +
    formatEngineModelColumn(task) +
    fit(" ", COL.sep3) +
    formatBarColumn(task) +
    fit(" ", COL.barTrail) +
    formatStatusColumn(task, allTasks) +
    formatTokensColumn(totalTokens)
  );
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

/** Latest progress entry per task id. */
interface ProgressEntry {
  at: string;
  message: string;
}

interface FleetWidgetOptions {
  expanded?: boolean;
  maxVisibleLines?: number;
}

interface RenderedTaskBlock {
  task: TaskState;
  lines: string[];
}

export class FleetWidget {
  /** Local mirror of task states; updated incrementally on each event. */
  private tasks = new Map<string, TaskState>();

  /** Latest progress entry per task id; updated from task:progress events. */
  private progress = new Map<string, ProgressEntry>();

  private interval: ReturnType<typeof setInterval> | null = null;

  // Bound listeners kept so they can be removed in detach()
  private readonly _onStatus: (e: TaskStatusEvent) => void;
  private readonly _onProgress: (e: TaskProgressEvent) => void;
  private readonly _onUsage: (e: TaskUsageEvent) => void;

  private readonly orchestrator: Orchestrator;
  private readonly setWidget: (id: string, lines: string[]) => void;
  private readonly clearWidget: (id: string) => void;
  private expanded: boolean;
  private readonly maxTaskLines: number;

  constructor(
    orchestrator: Orchestrator,
    setWidget: (id: string, lines: string[]) => void,
    clearWidget: (id: string) => void,
    options: FleetWidgetOptions = {},
  ) {
    this.orchestrator = orchestrator;
    this.setWidget = setWidget;
    this.clearWidget = clearWidget;
    this.expanded = options.expanded ?? false;
    const maxVisibleLines = options.maxVisibleLines ?? DEFAULT_MAX_VISIBLE_LINES;
    this.maxTaskLines = Math.max(1, maxVisibleLines - FOOTER_LINES);
    this._onStatus = (event: TaskStatusEvent) => {
      // event.state is a snapshot of the full RuntimeTaskState
      this.tasks.set(event.id, { ...event.state });
      // Capture latest progress carried on the state snapshot
      if (event.state.latestProgressAt && event.state.latestProgressMessage) {
        this.progress.set(event.id, {
          at: event.state.latestProgressAt,
          message: event.state.latestProgressMessage,
        });
      }
      this.render();
    };

    this._onProgress = (event: TaskProgressEvent) => {
      // Store the latest progress details so the sub-line can display them.
      this.progress.set(event.id, {
        at: event.latestProgressAt,
        message: event.latestProgressMessage,
      });
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
    // Seed from current snapshot so the widget is populated immediately.
    // getSnapshot() returns RuntimeTaskState values which may carry
    // latestProgressAt / latestProgressMessage from a previous run.
    for (const state of this.orchestrator.getSnapshot()) {
      this.tasks.set(state.id, { ...state });
      const rt = state as Partial<RuntimeTaskState>;
      if (rt.latestProgressAt && rt.latestProgressMessage) {
        this.progress.set(state.id, {
          at: rt.latestProgressAt,
          message: rt.latestProgressMessage,
        });
      }
    }

    this.orchestrator.on("task:status", this._onStatus);
    this.orchestrator.on("task:progress", this._onProgress);
    this.orchestrator.on("task:usage", this._onUsage);

    // Periodic re-render so the running progress bar animates even without events
    this.interval = setInterval(() => this.render(), 5_000);

    this.render();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
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

    const taskBlocks = tasks.map((task) => this.buildTaskBlock(task));
    const lines: string[] = [];

    for (const line of this.selectVisibleTaskLines(taskBlocks)) {
      lines.push(line);
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

  private buildTaskBlock(task: TaskState): RenderedTaskBlock {
    const lines = [formatTaskRow(task, this.tasks)];
    const progressLine = formatProgressLine(task, this.progress);
    if (progressLine) lines.push(progressLine);
    return { task, lines };
  }

  private selectVisibleTaskLines(taskBlocks: RenderedTaskBlock[]): string[] {
    if (this.expanded) {
      return taskBlocks.flatMap((block) => block.lines);
    }

    const totalTaskLines = taskBlocks.reduce((sum, block) => sum + block.lines.length, 0);
    if (totalTaskLines <= this.maxTaskLines) {
      return taskBlocks.flatMap((block) => block.lines);
    }

    const focusIdx = this.findFocusTaskIndex(taskBlocks);
    const visibleBlocks: RenderedTaskBlock[] = [];
    let used = 0;

    for (let i = focusIdx; i < taskBlocks.length; i++) {
      const block = taskBlocks[i]!;
      if (used > 0 && used + block.lines.length > this.maxTaskLines) break;
      visibleBlocks.push(block);
      used += block.lines.length;
      if (used >= this.maxTaskLines) break;
    }

    for (let i = focusIdx - 1; i >= 0; i--) {
      const block = taskBlocks[i]!;
      if (used + block.lines.length > this.maxTaskLines) break;
      visibleBlocks.unshift(block);
      used += block.lines.length;
    }

    if (visibleBlocks.length === 0) {
      return taskBlocks[focusIdx]?.lines.slice(0, this.maxTaskLines) ?? [];
    }

    return visibleBlocks.flatMap((block) => block.lines);
  }

  private findFocusTaskIndex(taskBlocks: RenderedTaskBlock[]): number {
    const runningIdx = taskBlocks.findIndex((block) => block.task.status === "running");
    if (runningIdx !== -1) return runningIdx;

    const retryingIdx = taskBlocks.findIndex((block) => block.task.status === "retrying");
    if (retryingIdx !== -1) return retryingIdx;

    const actionablePendingIdx = taskBlocks.findIndex((block) =>
      displayStatus(block.task, this.tasks) === "pending",
    );
    if (actionablePendingIdx !== -1) return actionablePendingIdx;

    const unfinishedIdx = taskBlocks.findIndex((block) => block.task.status !== "done");
    if (unfinishedIdx !== -1) return unfinishedIdx;

    return Math.max(0, taskBlocks.length - 1);
  }
}
