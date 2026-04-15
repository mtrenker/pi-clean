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
 *                        usage: { input_tokens, output_tokens } }
 */
export class StreamJsonEngineProcess implements EngineProcess {
  readonly pid: number;

  private readonly proc: ChildProcess;
  private readonly progressCbs: Array<(line: string) => void> = [];
  private readonly usageCbs: Array<(usage: Usage) => void> = [];
  private readonly completeCbs: Array<(result: EngineResult) => void> = [];
  private completed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

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
        const text = extractAssistantText(evt);
        if (text) {
          for (const cb of this.progressCbs) cb(text);
        }
        break;
      }
      case "result": {
        const usageRaw = evt["usage"] as Record<string, number> | undefined;
        if (usageRaw) {
          const usage: Usage = {
            inputTokens: usageRaw["input_tokens"] ?? 0,
            outputTokens: usageRaw["output_tokens"] ?? 0,
          };
          for (const cb of this.usageCbs) cb(usage);
        }
        break;
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a human-readable progress string from an `assistant` stream event.
 * Concatenates all text-typed content blocks and trims to 120 characters.
 */
function extractAssistantText(evt: Record<string, unknown>): string {
  const message = evt["message"] as Record<string, unknown> | undefined;
  if (!message) return "";

  const content = message["content"];
  if (!Array.isArray(content)) return "";

  const text = (content as Array<Record<string, unknown>>)
    .filter((block) => block["type"] === "text")
    .map((block) => (block["text"] as string | undefined) ?? "")
    .join("")
    .trim();

  return text.slice(0, 120);
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
  taskPrompt: string;
  cwd: string;
  outputJsonlPath: string;
}): StreamJsonEngineProcess {
  const args = [
    ...opts.baseArgs,
    "--system-prompt",
    opts.agentPrompt,
    "--model",
    opts.model,
    opts.taskPrompt,
  ];

  const proc = nodeSpawn(opts.command, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new StreamJsonEngineProcess(proc, opts.outputJsonlPath);
}
