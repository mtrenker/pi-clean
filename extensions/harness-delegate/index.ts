import { spawn } from "node:child_process";
import path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type Provider = "claude" | "codex";
type RunState = "running" | "success" | "error" | "aborted";
type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "plan" | "auto";

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

type DisplayItem =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "command";
      id: string;
      command: string;
      output?: string;
      status: "running" | "done" | "error";
      exitCode?: number | null;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      output?: string;
      status: "running" | "done" | "error";
      isError?: boolean;
    };

interface HarnessRunDetails {
  provider: Provider;
  prompt: string;
  cwd: string;
  state: RunState;
  model?: string;
  sessionId?: string;
  commandLine: string[];
  items: DisplayItem[];
  usage: UsageStats;
  stderr: string;
  finalOutput: string;
  errorMessage?: string;
  exitCode: number;
}

const ProviderSchema = StringEnum(["claude", "codex"] as const, {
  description: "Which first-party CLI harness to use.",
});

const CodexSandboxSchema = StringEnum(["read-only", "workspace-write", "danger-full-access"] as const, {
  description: "Codex sandbox mode. Default: workspace-write.",
  default: "workspace-write",
});

const ClaudePermissionModeSchema = StringEnum(
  ["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan", "auto"] as const,
  {
    description: "Claude Code permission mode. Default: bypassPermissions for non-interactive delegation.",
    default: "bypassPermissions",
  },
);

const DelegateHarnessParams = Type.Object({
  provider: ProviderSchema,
  prompt: Type.String({ description: "The task/prompt to execute in the delegated harness." }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the delegated harness. Defaults to the current project." }),
  ),
  model: Type.Optional(Type.String({ description: "Optional model override for the selected harness." })),
  appendSystemPrompt: Type.Optional(
    Type.String({ description: "Optional extra system instructions to append for the delegated harness." }),
  ),
  allowedTools: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Claude Code only. Optional allow-list for tools, e.g. ["Bash", "Read", "Edit"].',
    }),
  ),
  permissionMode: Type.Optional(ClaudePermissionModeSchema),
  sandbox: Type.Optional(CodexSandboxSchema),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Advanced: extra raw CLI arguments appended after pi-clean defaults for the selected harness.",
    }),
  ),
});

function createEmptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function formatTokens(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function shorten(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatClaudeToolCall(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") {
    const command = typeof input.command === "string" ? input.command : "...";
    return `$ ${shorten(command, 90)}`;
  }
  if (name === "Read") {
    const filePath =
      typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "...";
    return `read ${filePath}`;
  }
  if (name === "Edit" || name === "MultiEdit" || name === "Write") {
    const filePath =
      typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "...";
    return `${name.toLowerCase()} ${filePath}`;
  }
  return `${name} ${shorten(JSON.stringify(input), 90)}`;
}

function formatDisplayItem(item: DisplayItem): string {
  if (item.kind === "text") return item.text;
  if (item.kind === "command") {
    const suffix =
      item.status === "running"
        ? " (running)"
        : item.exitCode !== undefined && item.exitCode !== null
          ? ` (exit ${item.exitCode})`
          : "";
    return `$ ${item.command}${suffix}`;
  }
  const suffix = item.status === "running" ? " (running)" : item.isError ? " (error)" : "";
  return `${formatClaudeToolCall(item.name, item.input)}${suffix}`;
}

function renderCollapsedItems(items: DisplayItem[], theme: any, limit = 8): string {
  if (items.length === 0) return theme.fg("muted", "(no streamed output yet)");
  const shown = items.slice(-limit);
  const skipped = items.length - shown.length;
  const lines: string[] = [];
  if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier item${skipped === 1 ? "" : "s"}`));
  for (const item of shown) {
    if (item.kind === "text") {
      const preview = item.text.split("\n").slice(0, 3).join("\n");
      lines.push(theme.fg("toolOutput", preview));
    } else {
      lines.push(theme.fg("muted", "→ ") + theme.fg("accent", formatDisplayItem(item)));
      if (item.output) lines.push(theme.fg("dim", shorten(item.output.split("\n").slice(0, 3).join("\n"), 180)));
    }
  }
  return lines.join("\n");
}

function updateOrInsert(items: DisplayItem[], indexById: Map<string, number>, item: DisplayItem) {
  if (item.kind === "text") {
    items.push(item);
    return;
  }
  const index = indexById.get(item.id);
  if (index === undefined) {
    indexById.set(item.id, items.length);
    items.push(item);
  } else {
    items[index] = item;
  }
}

function buildCommandLine(params: {
  provider: Provider;
  prompt: string;
  cwd: string;
  model?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: ClaudePermissionMode;
  sandbox?: CodexSandbox;
  extraArgs?: string[];
}): { command: string; args: string[]; promptViaStdin: boolean } {
  if (params.provider === "claude") {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--permission-mode",
      params.permissionMode ?? "bypassPermissions",
    ];
    if (params.model) args.push("--model", params.model);
    if (params.allowedTools && params.allowedTools.length > 0) args.push("--tools", params.allowedTools.join(","));
    if (params.appendSystemPrompt) args.push("--append-system-prompt", params.appendSystemPrompt);
    if (params.extraArgs) args.push(...params.extraArgs);
    return { command: "claude", args, promptViaStdin: true };
  }

  const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", params.cwd];
  if (params.model) args.push("--model", params.model);
  if (params.sandbox === "read-only") args.push("--sandbox", "read-only");
  else if (params.sandbox === "danger-full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push("--full-auto");
  if (params.extraArgs) args.push(...params.extraArgs);
  args.push(params.prompt);
  return { command: "codex", args, promptViaStdin: false };
}

async function runHarness(
  params: {
    provider: Provider;
    prompt: string;
    cwd: string;
    model?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    permissionMode?: ClaudePermissionMode;
    sandbox?: CodexSandbox;
    extraArgs?: string[];
  },
  signal: AbortSignal | undefined,
  onUpdate: ((details: HarnessRunDetails) => void) | undefined,
): Promise<HarnessRunDetails> {
  const invocation = buildCommandLine(params);
  const details: HarnessRunDetails = {
    provider: params.provider,
    prompt: params.prompt,
    cwd: params.cwd,
    state: "running",
    model: params.model,
    commandLine: [invocation.command, ...invocation.args],
    items: [],
    usage: createEmptyUsage(),
    stderr: "",
    finalOutput: "",
    exitCode: 0,
  };
  const indexById = new Map<string, number>();

  const emit = () =>
    onUpdate?.({
      ...details,
      items: [...details.items],
      usage: { ...details.usage },
    });

  const proc = spawn(invocation.command, invocation.args, {
    cwd: params.cwd,
    stdio: [invocation.promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
    shell: false,
  });

  if (invocation.promptViaStdin && proc.stdin) {
    proc.stdin.write(params.prompt);
    proc.stdin.end();
  }

  let aborted = false;
  const killProc = () => {
    aborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 3000);
  };
  if (signal) {
    if (signal.aborted) killProc();
    else signal.addEventListener("abort", killProc, { once: true });
  }

  const parseCodexLine = (line: string) => {
    const event = JSON.parse(line) as any;
    if (event.type === "thread.started") {
      details.sessionId = event.thread_id;
      emit();
      return;
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      const item = event.item;
      if (!item) return;
      if (item.type === "agent_message" && typeof item.text === "string") {
        details.items.push({ kind: "text", text: item.text });
        details.finalOutput = item.text;
        emit();
        return;
      }
      if (item.type === "command_execution") {
        updateOrInsert(details.items, indexById, {
          kind: "command",
          id: item.id,
          command: item.command,
          output: item.aggregated_output || undefined,
          status: item.status === "completed" ? ((item.exit_code ?? 0) === 0 ? "done" : "error") : "running",
          exitCode: item.exit_code,
        });
        emit();
      }
      return;
    }
    if (event.type === "turn.completed" && event.usage) {
      details.usage.turns += 1;
      details.usage.input += event.usage.input_tokens ?? 0;
      details.usage.output += event.usage.output_tokens ?? 0;
      details.usage.cacheRead += event.usage.cached_input_tokens ?? 0;
      emit();
    }
  };

  const parseClaudeLine = (line: string) => {
    const event = JSON.parse(line) as any;
    if (event.type === "system" && event.subtype === "init") {
      details.sessionId = event.session_id;
      if (!details.model && typeof event.model === "string") details.model = event.model;
      emit();
      return;
    }
    if (event.type === "assistant" && event.message) {
      const message = event.message;
      if (!details.model && typeof message.model === "string") details.model = message.model;
      for (const part of message.content ?? []) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          details.items.push({ kind: "text", text: part.text });
          details.finalOutput = part.text;
        }
        if (part.type === "tool_use") {
          updateOrInsert(details.items, indexById, {
            kind: "tool",
            id: part.id,
            name: part.name,
            input: (part.input ?? {}) as Record<string, unknown>,
            status: "running",
          });
        }
      }
      emit();
      return;
    }
    if (event.type === "user" && event.message?.content) {
      for (const part of event.message.content) {
        if (part.type !== "tool_result" || !part.tool_use_id) continue;
        const toolOutput = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
        const existingIndex = indexById.get(part.tool_use_id);
        if (existingIndex === undefined) continue;
        const existing = details.items[existingIndex];
        if (existing && existing.kind === "tool") {
          details.items[existingIndex] = {
            ...existing,
            output: toolOutput,
            status: part.is_error ? "error" : "done",
            isError: part.is_error,
          };
        }
      }
      emit();
      return;
    }
    if (event.type === "result") {
      details.finalOutput = typeof event.result === "string" ? event.result : details.finalOutput;
      details.errorMessage = event.is_error ? event.result || "Delegated harness failed" : details.errorMessage;
      details.usage.turns = event.num_turns ?? details.usage.turns;
      if (event.usage) {
        details.usage.input = event.usage.input_tokens ?? details.usage.input;
        details.usage.output = event.usage.output_tokens ?? details.usage.output;
        details.usage.cacheRead = event.usage.cache_read_input_tokens ?? details.usage.cacheRead;
        details.usage.cacheWrite = event.usage.cache_creation_input_tokens ?? details.usage.cacheWrite;
        details.usage.cost = event.total_cost_usd ?? details.usage.cost;
      }
      emit();
    }
  };

  await new Promise<void>((resolve) => {
    let stdoutBuffer = "";
    proc.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if (params.provider === "codex") parseCodexLine(line);
          else parseClaudeLine(line);
        } catch {
          // Ignore malformed or unexpected lines.
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      details.stderr += chunk.toString();
      emit();
    });
    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        try {
          if (params.provider === "codex") parseCodexLine(stdoutBuffer.trim());
          else parseClaudeLine(stdoutBuffer.trim());
        } catch {
          // Ignore malformed tail line.
        }
      }
      details.exitCode = code ?? 0;
      if (aborted) details.state = "aborted";
      else if (details.exitCode !== 0 || details.errorMessage) details.state = "error";
      else details.state = "success";
      if (!details.errorMessage && details.state === "error") {
        details.errorMessage = details.stderr.trim() || "Delegated harness exited with a non-zero status.";
      }
      emit();
      resolve();
    });
    proc.on("error", (error) => {
      details.exitCode = 1;
      details.state = "error";
      details.errorMessage = error.message;
      emit();
      resolve();
    });
  });

  return details;
}

function renderDetails(details: HarnessRunDetails, expanded: boolean, theme: any) {
  const mdTheme = getMarkdownTheme();
  const icon =
    details.state === "running"
      ? theme.fg("warning", "⏳")
      : details.state === "success"
        ? theme.fg("success", "✓")
        : details.state === "aborted"
          ? theme.fg("warning", "◼")
          : theme.fg("error", "✗");
  const title = `${icon} ${theme.fg("toolTitle", theme.bold(details.provider))}${details.model ? theme.fg("muted", ` ${details.model}`) : ""}`;
  const usage = formatUsage(details.usage, undefined);

  if (!expanded) {
    let text = `${title}\n${theme.fg("dim", shorten(details.prompt, 120))}`;
    text += `\n${renderCollapsedItems(details.items, theme)}`;
    if (details.state !== "running" && details.finalOutput) {
      text += `\n${theme.fg("muted", "── final ──")}\n${theme.fg("toolOutput", shorten(details.finalOutput, 400))}`;
    }
    if (details.errorMessage) text += `\n${theme.fg("error", details.errorMessage)}`;
    if (usage) text += `\n${theme.fg("dim", usage)}`;
    if (details.state !== "running") text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(title, 0, 0));
  container.addChild(new Text(theme.fg("muted", `cwd: ${details.cwd}`), 0, 0));
  container.addChild(new Text(theme.fg("dim", `command: ${details.commandLine.join(" ")}`), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "── prompt ──"), 0, 0));
  container.addChild(new Text(details.prompt, 0, 0));

  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "── streamed progress ──"), 0, 0));
  if (details.items.length === 0) container.addChild(new Text(theme.fg("muted", "(no streamed output yet)"), 0, 0));
  for (const item of details.items) {
    if (item.kind === "text") {
      container.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
      continue;
    }
    container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("accent", formatDisplayItem(item)), 0, 0));
    if (item.output) container.addChild(new Text(theme.fg("dim", item.output), 0, 0));
  }

  if (details.finalOutput) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "── final output ──"), 0, 0));
    container.addChild(new Markdown(details.finalOutput.trim(), 0, 0, mdTheme));
  }
  if (details.stderr.trim()) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "── stderr ──"), 0, 0));
    container.addChild(new Text(theme.fg("error", details.stderr.trim()), 0, 0));
  }
  if (details.errorMessage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", details.errorMessage), 0, 0));
  }
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  return container;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate_harness",
    label: "Delegate Harness",
    description:
      "Run a prompt through an installed first-party CLI harness like Claude Code or Codex, stream its progress back into Pi, and return the final result.",
    promptSnippet:
      "Delegate a task to Claude Code or Codex via their official local CLI so Pi can use first-party subscriptions and show progress inline.",
    promptGuidelines: [
      "Use delegate_harness when the user explicitly asks to run Claude Code or Codex directly, or when subscription/policy constraints require the first-party CLI.",
      "Use provider=claude for Claude Code and provider=codex for OpenAI Codex CLI.",
      "Tell the user which harness you delegated to and summarize the delegated result when it finishes.",
    ],
    parameters: DelegateHarnessParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = path.resolve(params.cwd ?? ctx.cwd);
      const details = await runHarness(
        {
          provider: params.provider,
          prompt: params.prompt,
          cwd,
          model: params.model,
          appendSystemPrompt: params.appendSystemPrompt,
          allowedTools: params.allowedTools,
          permissionMode: params.permissionMode,
          sandbox: params.sandbox ?? "workspace-write",
          extraArgs: params.extraArgs,
        },
        signal,
        onUpdate
          ? (partial) => {
              const summary = partial.finalOutput || partial.errorMessage || "Running delegated harness...";
              onUpdate({
                content: [{ type: "text", text: summary }],
                details: partial,
              });
            }
          : undefined,
      );

      const text =
        details.state === "success"
          ? details.finalOutput || "Delegated harness completed without a final text response."
          : details.errorMessage || details.stderr || "Delegated harness failed.";

      return {
        content: [{ type: "text", text }],
        details,
        isError: details.state !== "success",
      };
    },

    renderCall(args, theme) {
      const line1 =
        theme.fg("toolTitle", theme.bold("delegate_harness ")) +
        theme.fg("accent", args.provider) +
        (args.model ? theme.fg("muted", ` ${args.model}`) : "");
      const line2 = theme.fg("dim", shorten(args.prompt || "", 100));
      return new Text(`${line1}\n  ${line2}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as HarnessRunDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }
      return renderDetails(details, expanded, theme);
    },
  });

  pi.registerCommand("harnesses", {
    description: "Show detected first-party harness CLIs",
    handler: async (_args, ctx) => {
      const checks = [
        { name: "claude", args: ["--version"] },
        { name: "codex", args: ["--version"] },
      ];
      const lines: string[] = [];
      for (const check of checks) {
        try {
          const result = await pi.exec(check.name, check.args, { timeout: 5000 });
          const out = (result.stdout || result.stderr || "installed").trim().split("\n")[0];
          lines.push(`${check.name}: ${out}`);
        } catch {
          lines.push(`${check.name}: not found`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
