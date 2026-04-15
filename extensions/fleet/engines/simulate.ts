// Fleet engine adapters — simulate engine
// Implements EngineAdapter without spawning any real process.
// Fires the same events as real adapters so the widget and orchestrator
// behave identically during development/TUI testing.

import { appendFile } from "fs/promises";
import type { EngineAdapter, EngineProcess, EngineResult, Usage } from "./types.js";
import type { SimulateConfig } from "../config.js";

// ── Fake progress steps cycled through during simulation ──────────────────────

const STEPS = [
  "Reading codebase structure",
  "Scanning relevant files",
  "Analyzing dependencies",
  "Planning implementation",
  "Writing code",
  "Implementing changes",
  "Running tests",
  "Fixing issues",
  "Reviewing output",
  "Finalizing changes",
];

// ── SimulateEngineProcess ─────────────────────────────────────────────────────

class SimulateEngineProcess implements EngineProcess {
  readonly pid: number;

  private progressCbs: Array<(line: string) => void> = [];
  private usageCbs: Array<(usage: Usage) => void> = [];
  private completeCbs: Array<(result: EngineResult) => void> = [];

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private killed = false;

  private stepIndex = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    private readonly outputJsonlPath: string,
    private readonly cfg: Required<SimulateConfig>,
    private readonly taskName: string,
  ) {
    // Use a fake PID in the simulator range (negative to never clash with real PIDs)
    this.pid = -(Math.floor(Math.random() * 90000) + 10000);
  }

  onProgress(cb: (line: string) => void): void {
    this.progressCbs.push(cb);
  }

  onUsageUpdate(cb: (usage: Usage) => void): void {
    this.usageCbs.push(cb);
  }

  onComplete(cb: (result: EngineResult) => void): void {
    this.completeCbs.push(cb);
  }

  kill(): void {
    this._cleanup();
    this.killed = true;
    this._fireComplete({ success: false, exitCode: 130, error: "Killed" });
  }

  /** Start emitting fake events. Called by SimulateEngineAdapter after construction. */
  start(): void {
    const [minMs, maxMs] = this.cfg.taskDurationMs;
    const duration = minMs + Math.random() * (maxMs - minMs);

    // Progress ticks
    this.intervalHandle = setInterval(() => {
      this._tick();
    }, this.cfg.progressIntervalMs);

    // Completion timer
    this.timeoutHandle = setTimeout(() => {
      this._cleanup();
      const failed = Math.random() < this.cfg.failureRate;
      if (failed) {
        this._fireComplete({
          success: false,
          exitCode: 1,
          error: `Simulated failure in task "${this.taskName}"`,
        });
      } else {
        // Emit a final "done" progress step
        this._emitProgress(`Task "${this.taskName}" completed successfully`, "done");
        this._fireComplete({ success: true, exitCode: 0 });
      }
    }, duration);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _tick(): void {
    const step = STEPS[this.stepIndex % STEPS.length]!;
    this.stepIndex++;

    this._emitProgress(step, "running");

    // Increment fake token usage
    this.inputTokens += Math.floor(Math.random() * 800) + 200;
    this.outputTokens += Math.floor(Math.random() * 300) + 50;
    const usage = { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
    for (const cb of this.usageCbs) cb(usage);
  }

  private _emitProgress(step: string, status: "running" | "done" | "error"): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), step, status });

    // Write to output.jsonl (best-effort)
    appendFile(this.outputJsonlPath, line + "\n").catch(() => {});

    for (const cb of this.progressCbs) cb(line);
  }

  private _fireComplete(result: EngineResult): void {
    if (!this.killed || result.exitCode === 130) {
      for (const cb of this.completeCbs) cb(result);
    }
  }

  private _cleanup(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}

// ── SimulateEngineAdapter ─────────────────────────────────────────────────────

export class SimulateEngineAdapter implements EngineAdapter {
  private readonly cfg: Required<SimulateConfig>;

  constructor(cfg: SimulateConfig = {}) {
    this.cfg = {
      taskDurationMs: cfg.taskDurationMs ?? [4000, 10000],
      progressIntervalMs: cfg.progressIntervalMs ?? 1200,
      failureRate: cfg.failureRate ?? 0.2,
    };
  }

  spawn(opts: {
    taskPrompt: string;
    agentPrompt: string;
    model: string;
    cwd: string;
    outputJsonlPath: string;
  }): EngineProcess {
    // Extract task name from the prompt header for nicer log messages
    const nameMatch = opts.taskPrompt.match(/^#\s+Task[:\s]+(.+)/m);
    const taskName = nameMatch ? nameMatch[1].trim() : "unknown";

    const process = new SimulateEngineProcess(
      opts.outputJsonlPath,
      this.cfg,
      taskName,
    );
    process.start();
    return process;
  }
}
