// Internal shared implementation for engines that emit stream-json (claude, pi).
// NOT part of the public API — import only from claude.ts and pi.ts.

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createInterface } from "readline";
import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";
import type { Usage, EngineResult, EngineProcess } from "./types.js";

// ── StreamJsonEngineProcess ───────────────────────────────────────────────────

/**
 * EngineProcess implementation for the `stream-json` output format used by
 * both the `claude` and `pi` CLIs.
 *
 * Expected stream events:
 *   { type: "assistant", message: { content: Array<{type, text?, ...}> } }
 *   { type: "result",    subtype: "success"|"error_...", result: "...",
 *                        usage: { input_tokens, output_tokens,
 *                                 cache_creation_input_tokens?,
 *                                 cache_read_input_tokens? } }
 */
export class StreamJsonEngineProcess implements EngineProcess {
  readonly pid: number;

  private readonly proc: ChildProcess;
  private readonly progressCbs: Array<(line: string) => void> = [];
  private readonly usageCbs: Array<(usage: Usage) => void> = [];
  private readonly completeCbs: Array<(result: EngineResult) => void> = [];
  private completed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private lastProgress = "";
  private accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(proc: ChildProcess, outputJsonlPath: string) {
    this.proc = proc;
    this.pid = proc.pid ?? 0;

    // Ensure output directory exists and open an append-mode write stream.
    mkdirSync(dirname(outputJsonlPath), { recursive: true });
    const outStream = createWriteStream(outputJsonlPath, { flags: "a" });

    // Read stdout line by line.
    const rl = createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (rawLine) => {
      if (!rawLine.trim()) return;

      // 1. Append raw line to output file.
      outStream.write(rawLine + "\n");

      // 2. Parse and dispatch callbacks.
      this.handleStreamJsonLine(rawLine);
    });

    // Close the write stream and fire onComplete when the process exits.
    proc.on("close", (code) => {
      outStream.end();
      if (this.killTimer !== undefined) {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      }
      if (!this.completed) {
        this.completed = true;
        const exitCode = code ?? 1;
        const result: EngineResult = {
          success: exitCode === 0,
          exitCode,
          error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
        };
        for (const cb of this.completeCbs) cb(result);
      }
    });
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
    this.proc.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (!this.completed) {
        this.proc.kill("SIGKILL");
      }
    }, 3000);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private handleStreamJsonLine(rawLine: string): void {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      return; // Non-JSON line — skip silently.
    }

    switch (evt["type"]) {
      case "assistant": {
        const text = extractAssistantProgress(evt);
        this.emitProgress(text);

        const message = evt["message"] as Record<string, unknown> | undefined;
        const usageRaw = message?.["usage"] as Record<string, number> | undefined;
        this.emitIncrementalUsage(usageRaw);
        break;
      }
      case "result": {
        const usageRaw = evt["usage"] as Record<string, number> | undefined;
        this.emitAggregateUsage(usageRaw);
        break;
      }
    }
  }

  private emitProgress(text: string): void {
    const trimmed = text.trim().slice(0, 120);
    if (!trimmed || trimmed === this.lastProgress) return;
    this.lastProgress = trimmed;
    for (const cb of this.progressCbs) cb(trimmed);
  }

  private emitIncrementalUsage(usageRaw: Record<string, number> | undefined): void {
    if (!usageRaw) return;

    const delta = parseStreamUsage(usageRaw);
    if (usageDeltaIsZero(delta)) return;

    this.accumulatedUsage = addUsage(this.accumulatedUsage, delta);
    for (const cb of this.usageCbs) cb({ ...this.accumulatedUsage });
  }

  private emitAggregateUsage(usageRaw: Record<string, number> | undefined): void {
    if (!usageRaw) return;

    const aggregate = parseStreamUsage(usageRaw);
    const next = maxUsage(this.accumulatedUsage, aggregate);
    if (usageEquals(next, this.accumulatedUsage)) return;

    this.accumulatedUsage = next;
    for (const cb of this.usageCbs) cb({ ...this.accumulatedUsage });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseStreamUsage(usageRaw: Record<string, number>): Usage {
  const usage: Usage = {
    inputTokens: usageRaw["input_tokens"] ?? 0,
    outputTokens: usageRaw["output_tokens"] ?? 0,
  };

  const cacheCreation = usageRaw["cache_creation_input_tokens"] ?? 0;
  const cacheRead = usageRaw["cache_read_input_tokens"] ?? 0;
  if (cacheCreation > 0) usage.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) usage.cacheReadInputTokens = cacheRead;

  return usage;
}

function usageDeltaIsZero(usage: Usage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    (usage.cacheCreationInputTokens ?? 0) === 0 &&
    (usage.cacheReadInputTokens ?? 0) === 0
  );
}

function addUsage(left: Usage, right: Usage): Usage {
  const next: Usage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };

  const cacheCreation = (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  const cacheRead = (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0);
  if (cacheCreation > 0) next.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) next.cacheReadInputTokens = cacheRead;

  return next;
}

function maxUsage(left: Usage, right: Usage): Usage {
  const next: Usage = {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
  };

  const cacheCreation = Math.max(left.cacheCreationInputTokens ?? 0, right.cacheCreationInputTokens ?? 0);
  const cacheRead = Math.max(left.cacheReadInputTokens ?? 0, right.cacheReadInputTokens ?? 0);
  if (cacheCreation > 0) next.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) next.cacheReadInputTokens = cacheRead;

  return next;
}

function usageEquals(left: Usage, right: Usage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    (left.cacheCreationInputTokens ?? 0) === (right.cacheCreationInputTokens ?? 0) &&
    (left.cacheReadInputTokens ?? 0) === (right.cacheReadInputTokens ?? 0)
  );
}

/**
 * Extract a human-readable progress string from an `assistant` stream event.
 * Prefers normal assistant text, but falls back to brief thinking/tool-use
 * summaries so long-running tasks still show visible activity.
 */
function extractAssistantProgress(evt: Record<string, unknown>): string {
  const message = evt["message"] as Record<string, unknown> | undefined;
  if (!message) return "";

  const content = message["content"];
  if (!Array.isArray(content)) return "";

  const blocks = content as Array<Record<string, unknown>>;

  const text = blocks
    .filter((block) => block["type"] === "text")
    .map((block) => (block["text"] as string | undefined) ?? "")
    .join("")
    .trim();
  if (text) return text;

  const toolUse = blocks.find((block) => block["type"] === "tool_use");
  if (toolUse) {
    const name = (toolUse["name"] as string | undefined)?.trim() || "tool";
    const input = toolUse["input"] as Record<string, unknown> | undefined;
    const description = (input?.["description"] as string | undefined)?.trim();
    const command = (input?.["command"] as string | undefined)?.trim();
    const pattern = (input?.["pattern"] as string | undefined)?.trim();
    const target = description || command || pattern;
    return target ? `Using ${name}: ${target}` : `Using ${name}`;
  }

  const thinking = blocks
    .filter((block) => block["type"] === "thinking")
    .map((block) => (block["thinking"] as string | undefined) ?? "")
    .join(" ")
    .trim();
  if (thinking) return `Thinking: ${thinking}`;

  return "";
}

// ── Factory helper ────────────────────────────────────────────────────────────

/**
 * Spawn a subprocess and wrap it in a StreamJsonEngineProcess.
 * Used by both ClaudeEngineAdapter and PiEngineAdapter.
 */
export function spawnStreamJson(opts: {
  command: string;
  baseArgs: string[];
  agentPrompt: string;
  model: string;
  thinking?: string;
  taskPrompt: string;
  cwd: string;
  outputJsonlPath: string;
}): StreamJsonEngineProcess {
  const args = [...opts.baseArgs];

  if (opts.command === "claude" && !args.includes("--verbose")) {
    args.push("--verbose");
  }

  args.push(
    "--system-prompt",
    opts.agentPrompt,
    "--model",
    opts.model,
  );

  if (opts.thinking) {
    args.push("--effort", opts.thinking);
  }

  args.push(opts.taskPrompt);

  const proc = nodeSpawn(opts.command, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new StreamJsonEngineProcess(proc, opts.outputJsonlPath);
}
