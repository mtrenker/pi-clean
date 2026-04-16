// Fleet engine adapter — pi CLI (JSON event stream mode)

import { spawn as nodeSpawn } from "child_process";
import { createInterface } from "readline";
import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";

import type { EngineAdapter, EngineProcess, EngineResult, Usage } from "./types.js";
import type { EngineConfig } from "../config.js";

interface PiJsonEvent {
  type?: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>> | string;
    usage?: {
      input?: number;
      output?: number;
    };
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: {
    type?: string;
    partial?: {
      content?: Array<Record<string, unknown>>;
    };
  };
}

class PiJsonEngineProcess implements EngineProcess {
  readonly pid: number;

  private readonly proc: ReturnType<typeof nodeSpawn>;
  private readonly progressCbs: Array<(line: string) => void> = [];
  private readonly usageCbs: Array<(usage: Usage) => void> = [];
  private readonly completeCbs: Array<(result: EngineResult) => void> = [];
  private completed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private stderrBuffer = "";
  private lastProgress = "";
  private accumulatedUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(proc: ReturnType<typeof nodeSpawn>, outputJsonlPath: string) {
    this.proc = proc;
    this.pid = proc.pid ?? 0;

    mkdirSync(dirname(outputJsonlPath), { recursive: true });
    const outStream = createWriteStream(outputJsonlPath, { flags: "a" });

    const stdoutRl = createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    stdoutRl.on("line", (rawLine) => {
      if (!rawLine.trim()) return;
      outStream.write(rawLine + "\n");
      this.handleJsonLine(rawLine);
    });

    const stderrRl = createInterface({
      input: proc.stderr!,
      crlfDelay: Infinity,
    });

    stderrRl.on("line", (rawLine) => {
      if (!rawLine.trim()) return;
      outStream.write(JSON.stringify({ type: "stderr", line: rawLine }) + "\n");
      this.stderrBuffer += (this.stderrBuffer ? "\n" : "") + rawLine;
    });

    proc.on("close", (code) => {
      outStream.end();
      if (this.killTimer !== undefined) {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      }
      if (!this.completed) {
        this.completed = true;
        const exitCode = code ?? 1;
        const error = exitCode !== 0
          ? (this.stderrBuffer.trim() || `Process exited with code ${exitCode}`)
          : undefined;
        const result: EngineResult = {
          success: exitCode === 0,
          exitCode,
          error,
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

  private handleJsonLine(rawLine: string): void {
    let evt: PiJsonEvent;
    try {
      evt = JSON.parse(rawLine) as PiJsonEvent;
    } catch {
      return;
    }

    if (evt.type === "message_update" && evt.assistantMessageEvent?.type?.startsWith("text_")) {
      const text = extractAssistantText(evt.assistantMessageEvent.partial?.content);
      this.emitProgress(text);
      return;
    }

    if ((evt.type === "message_end" || evt.type === "turn_end") && evt.message?.role === "assistant") {
      const text = extractAssistantText(evt.message.content);
      this.emitProgress(text);
    }

    if (evt.type === "turn_end" && evt.message?.role === "assistant") {
      const usageRaw = evt.message.usage;
      if (usageRaw) {
        this.accumulatedUsage.inputTokens += usageRaw.input ?? 0;
        this.accumulatedUsage.outputTokens += usageRaw.output ?? 0;
        for (const cb of this.usageCbs) cb({ ...this.accumulatedUsage });
      }
    }
  }

  private emitProgress(text: string): void {
    const trimmed = text.trim().slice(0, 120);
    if (!trimmed || trimmed === this.lastProgress) return;
    this.lastProgress = trimmed;
    for (const cb of this.progressCbs) cb(trimmed);
  }
}

function extractAssistantText(content: Array<Record<string, unknown>> | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function normalizePiArgs(baseArgs: string[]): string[] {
  const args: string[] = [];

  for (let i = 0; i < baseArgs.length; i++) {
    const arg = baseArgs[i];
    if (arg === "--output-format") {
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      i += 1;
      continue;
    }
    args.push(arg);
  }

  if (!args.includes("-p") && !args.includes("--print")) {
    args.unshift("-p");
  }
  if (!args.includes("--no-extensions") && !args.includes("-ne")) {
    args.push("--no-extensions");
  }

  args.push("--mode", "json");
  return args;
}

export class PiEngineAdapter implements EngineAdapter {
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
    const args = [
      ...normalizePiArgs(this.engineConfig.args),
      "--system-prompt",
      opts.agentPrompt,
      "--model",
      opts.model,
    ];

    if (opts.thinking) {
      args.push("--thinking", opts.thinking);
    }

    if (opts.tools && opts.tools.length > 0) {
      args.push("--tools", opts.tools.join(","));
    }

    args.push(opts.taskPrompt);

    const proc = nodeSpawn(this.engineConfig.command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new PiJsonEngineProcess(proc, opts.outputJsonlPath);
  }
}
