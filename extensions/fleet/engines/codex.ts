// Fleet engine adapter — codex CLI (JSONL format)

import { spawn as nodeSpawn } from "child_process";
import { createInterface } from "readline";
import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";
import type { EngineAdapter, EngineProcess, EngineResult, Usage } from "./types.js";
import type { EngineConfig } from "../config.js";

// ── CodexEngineProcess ────────────────────────────────────────────────────────

/**
 * EngineProcess implementation for the codex CLI JSONL output format.
 *
 * Expected stream events:
 *   { type: "message",      role: "assistant", content: "..." }  → onProgress
 *   { type: "shell_output", output: "..." }                       → onProgress
 *   { type: "done",         usage: { input_tokens, output_tokens } } → onUsageUpdate
 *
 * Non-zero exit code → failure.
 */
class CodexEngineProcess implements EngineProcess {
  readonly pid: number;

  private readonly proc: ReturnType<typeof nodeSpawn>;
  private readonly progressCbs: Array<(line: string) => void> = [];
  private readonly usageCbs: Array<(usage: Usage) => void> = [];
  private readonly completeCbs: Array<(result: EngineResult) => void> = [];
  private completed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(proc: ReturnType<typeof nodeSpawn>, outputJsonlPath: string) {
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
      this.handleCodexLine(rawLine);
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

  private handleCodexLine(rawLine: string): void {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      return; // Non-JSON line — skip silently.
    }

    switch (evt["type"]) {
      case "message": {
        // Only emit progress for assistant messages.
        if (evt["role"] === "assistant") {
          const content = (evt["content"] as string | undefined) ?? "";
          const trimmed = content.trim().slice(0, 120);
          if (trimmed) {
            for (const cb of this.progressCbs) cb(trimmed);
          }
        }
        break;
      }
      case "shell_output": {
        const output = (evt["output"] as string | undefined) ?? "";
        const trimmed = output.trim().slice(0, 120);
        if (trimmed) {
          for (const cb of this.progressCbs) cb(trimmed);
        }
        break;
      }
      case "done": {
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

// ── CodexEngineAdapter ────────────────────────────────────────────────────────

/**
 * Spawns the `codex` CLI and parses its JSONL output.
 *
 * Invocation:
 *   codex exec --json --dangerously-bypass-approvals-and-sandbox \
 *     -m <model> \
 *     "<agentPrompt>\n\n<taskPrompt>"
 *
 * Note: codex has no `--system-prompt` flag, so the agent prompt is
 * prepended to the task prompt.
 */
export class CodexEngineAdapter implements EngineAdapter {
  constructor(private readonly engineConfig: EngineConfig) {}

  spawn(opts: {
    taskPrompt: string;
    agentPrompt: string;
    model: string;
    thinking?: string;
    tools?: string[] | null;
    cwd: string;
    outputJsonlPath: string;
  }): EngineProcess {
    const combinedPrompt = `${opts.agentPrompt}\n\n${opts.taskPrompt}`;

    const args = [
      ...this.engineConfig.args,
      "-m",
      opts.model,
    ];

    if (opts.thinking) {
      args.push("-c", `reasoning_level=\"${opts.thinking}\"`);
    }

    args.push(combinedPrompt);

    const proc = nodeSpawn(this.engineConfig.command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new CodexEngineProcess(proc, opts.outputJsonlPath);
  }
}
