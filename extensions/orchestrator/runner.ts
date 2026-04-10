/**
 * Subagent runner - spawns pi subprocesses for task execution
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";

export interface TaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface TaskResult {
	taskId: number;
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: TaskUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	errorCode?: string; // ECONNREFUSED, ETIMEDOUT, HTTP_429, etc.
	output: string;
	retryCount?: number; // Number of retries attempted
	retryable?: boolean; // Whether error is retryable
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export type OnTaskUpdate = (result: TaskResult) => void;

export async function runSubagent(
	cwd: string,
	agent: AgentConfig,
	taskId: number,
	taskPrompt: string,
	signal: AbortSignal | undefined,
	onUpdate?: OnTaskUpdate,
	timeout?: number,
): Promise<TaskResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let timeoutController: AbortController | null = null;
	let timeoutId: NodeJS.Timeout | null = null;
	let combinedSignal: AbortSignal | undefined = signal;

	// Create timeout-triggered AbortController if timeout is specified
	if (timeout) {
		timeoutController = new AbortController();
		timeoutId = setTimeout(() => {
			console.log(`[orchestrator] Task ${taskId} (${agent.name}) timed out after ${timeout}ms`);
			timeoutController!.abort();
		}, timeout);

		// Chain user signal with timeout signal
		if (signal) {
			// If either signal aborts, we abort
			const ac = new AbortController();
			const abortBoth = () => ac.abort();
			signal.addEventListener("abort", abortBoth, { once: true });
			timeoutController.signal.addEventListener("abort", abortBoth, { once: true });
			combinedSignal = ac.signal;
		} else {
			combinedSignal = timeoutController.signal;
		}
	}

	const result: TaskResult = {
		taskId,
		agent: agent.name,
		task: taskPrompt,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		output: "",
	};

	const emitUpdate = () => onUpdate?.(result);

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${taskPrompt}`);
		let wasAborted = false;
		let wasTimeout = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (combinedSignal) {
				const killProc = () => {
					wasAborted = true;
					// Check if it was a timeout that triggered the abort
					if (timeoutController && timeoutController.signal.aborted) {
						wasTimeout = true;
					}
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (combinedSignal.aborted) killProc();
				else combinedSignal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.output = getFinalOutput(result.messages);
		
		if (wasTimeout) {
			result.stopReason = "timeout";
			result.errorMessage = `Task timed out after ${timeout}ms`;
			const timeoutMinutes = Math.floor(timeout! / 60000);
			const timeoutSeconds = Math.floor((timeout! % 60000) / 1000);
			let timeStr = "";
			if (timeoutMinutes > 0) timeStr += `${timeoutMinutes}m`;
			if (timeoutSeconds > 0) timeStr += `${timeoutSeconds}s`;
			throw new Error(`Task timed out after ${timeStr}`);
		}
		
		if (wasAborted) throw new Error("Subagent was aborted");
		return result;
	} finally {
		// Cleanup timeout
		if (timeoutId) clearTimeout(timeoutId);
		
		// Cleanup temp files
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: TaskUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: any, text: string) => string,
): string {
	const home = os.homedir();
	const shorten = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			const preview = cmd.length > 60 ? `${cmd.slice(0, 60)}...` : cmd;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const p = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "read ") + fg("accent", p);
		}
		case "write": {
			const p = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "write ") + fg("accent", p);
		}
		case "edit": {
			const p = shorten(((args.file_path || args.path || "...") as string));
			return fg("muted", "edit ") + fg("accent", p);
		}
		default: {
			const s = JSON.stringify(args);
			return fg("accent", toolName) + fg("dim", ` ${s.length > 50 ? s.slice(0, 50) + "..." : s}`);
		}
	}
}
