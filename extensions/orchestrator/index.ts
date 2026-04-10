/**
 * Orchestrator Extension
 *
 * Multi-agent workflow: scout → planner → specialist subagents
 *
 * Flow:
 * 1. Scout agent investigates the codebase
 * 2. Planner creates PLAN.md + TASK-{n}.md files
 * 3. Tasks are executed by specialist subagents (worker, reviewer, tester, red-team)
 * 4. Progress is tracked via widget + status bar
 *
 * Supports dependency ordering: tasks with no deps run in parallel,
 * tasks with deps wait for their prerequisites.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents, specialistToAgent } from "./agents.js";
import {
	type TaskResult,
	type OnTaskUpdate,
	type DisplayItem,
	runSubagent,
	getDisplayItems,
	formatUsage,
	formatToolCall,
	formatTokens,
} from "./runner.js";
import { type PlanDef, type TaskDef, parsePlan } from "./tasks.js";

const MAX_CONCURRENCY = 4;

type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

interface TaskState {
	def: TaskDef;
	status: TaskStatus;
	result?: TaskResult;
}

interface OrchestratorDetails {
	phase: "scout" | "plan" | "execute" | "done";
	goal: string;
	taskStates: Array<{
		id: number;
		title: string;
		specialist: string;
		status: TaskStatus;
		result?: TaskResult;
	}>;
	scoutResult?: TaskResult;
	plannerResult?: TaskResult;
}

function statusIcon(status: TaskStatus, fg: (c: any, t: string) => string): string {
	switch (status) {
		case "pending":
			return fg("muted", "○");
		case "running":
			return fg("warning", "⏳");
		case "done":
			return fg("success", "✓");
		case "failed":
			return fg("error", "✗");
		case "skipped":
			return fg("muted", "⊘");
	}
}

export default function orchestratorExtension(pi: ExtensionAPI): void {
	const extensionDir = __dirname;

	// Progress widget state
	let currentDetails: OrchestratorDetails | null = null;

	function updateWidget(ctx: ExtensionContext) {
		if (!currentDetails) {
			ctx.ui.setWidget("orchestrator", undefined);
			ctx.ui.setStatus("orchestrator", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const d = currentDetails;

		// Status bar
		if (d.phase === "scout") {
			ctx.ui.setStatus("orchestrator", theme.fg("warning", "🔍 Scouting..."));
		} else if (d.phase === "plan") {
			ctx.ui.setStatus("orchestrator", theme.fg("warning", "📋 Planning..."));
		} else if (d.phase === "execute") {
			const done = d.taskStates.filter((t) => t.status === "done").length;
			const failed = d.taskStates.filter((t) => t.status === "failed").length;
			const total = d.taskStates.length;
			const running = d.taskStates.filter((t) => t.status === "running").length;
			let status = `⚡ ${done}/${total}`;
			if (failed > 0) status += theme.fg("error", ` ${failed} failed`);
			if (running > 0) status += theme.fg("warning", ` ${running} running`);
			ctx.ui.setStatus("orchestrator", status);
		} else if (d.phase === "done") {
			const failed = d.taskStates.filter((t) => t.status === "failed").length;
			if (failed > 0) {
				ctx.ui.setStatus("orchestrator", theme.fg("error", `✗ ${failed} failed`));
			} else {
				ctx.ui.setStatus("orchestrator", theme.fg("success", "✓ Complete"));
			}
		}

		// Widget showing task progress
		if (d.taskStates.length > 0) {
			const lines: string[] = [theme.bold(theme.fg("accent", `📋 ${d.goal}`))];
			for (const t of d.taskStates) {
				const icon = statusIcon(t.status, theme.fg.bind(theme));
				const specialist = theme.fg("muted", `[${t.specialist}]`);
				let line = `  ${icon} TASK-${t.id}: ${t.title} ${specialist}`;
				if (t.result) {
					const usage = formatUsage(t.result.usage, t.result.model);
					if (usage) line += ` ${theme.fg("dim", usage)}`;
				}
				lines.push(line);
			}
			ctx.ui.setWidget("orchestrator", lines);
		}
	}

	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description: [
			"Multi-agent orchestration: scout → planner → specialist subagents.",
			"Give it a goal and it will: 1) scout the codebase, 2) create PLAN.md + TASK-{n}.md files,",
			"3) execute tasks with specialist agents (worker, reviewer, tester, red-team).",
			"Tasks run in dependency order with parallelism where possible.",
		].join(" "),
		promptSnippet: "Orchestrate multi-agent workflows: scout, plan, then execute tasks with specialists",
		parameters: Type.Object({
			goal: Type.String({ description: "What you want to accomplish" }),
			scoutHints: Type.Optional(
				Type.String({ description: "Additional hints for the scout about where to look" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = discoverAgents(extensionDir);
			const agentMap = new Map<string, AgentConfig>();
			for (const a of agents) agentMap.set(a.name, a);

			const cwd = ctx.cwd;
			const { goal, scoutHints } = params;

			currentDetails = {
				phase: "scout",
				goal,
				taskStates: [],
			};
			updateWidget(ctx);

			const makeToolResult = (text: string): AgentToolResult<OrchestratorDetails> => ({
				content: [{ type: "text", text }],
				details: currentDetails!,
			});

			// ─── Phase 1: Scout ───
			const scoutAgent = agentMap.get("scout");
			if (!scoutAgent) {
				currentDetails = null;
				updateWidget(ctx);
				return makeToolResult("Error: scout agent not found. Available: " + agents.map((a) => a.name).join(", "));
			}

			let scoutPrompt = `Investigate the codebase for this goal: ${goal}`;
			if (scoutHints) scoutPrompt += `\n\nHints: ${scoutHints}`;

			const scoutResult = await runSubagent(cwd, scoutAgent, 0, scoutPrompt, signal, (r) => {
				currentDetails!.scoutResult = r;
				onUpdate?.(makeToolResult(`Scouting: ${r.output.slice(0, 200) || "(running...)"}`));
			});
			currentDetails.scoutResult = scoutResult;

			if (scoutResult.exitCode !== 0 || scoutResult.stopReason === "error") {
				currentDetails.phase = "done";
				updateWidget(ctx);
				return {
					...makeToolResult(`Scout failed: ${scoutResult.errorMessage || scoutResult.stderr || scoutResult.output}`),
					isError: true,
				};
			}

			// ─── Phase 2: Planner ───
			currentDetails.phase = "plan";
			updateWidget(ctx);

			const plannerAgent = agentMap.get("planner");
			if (!plannerAgent) {
				currentDetails = null;
				updateWidget(ctx);
				return makeToolResult("Error: planner agent not found.");
			}

			const plannerPrompt = [
				`Goal: ${goal}`,
				"",
				"Scout findings:",
				scoutResult.output,
			].join("\n");

			const plannerResult = await runSubagent(cwd, plannerAgent, 0, plannerPrompt, signal, (r) => {
				currentDetails!.plannerResult = r;
				onUpdate?.(makeToolResult(`Planning: ${r.output.slice(0, 200) || "(running...)"}`));
			});
			currentDetails.plannerResult = plannerResult;

			if (plannerResult.exitCode !== 0 || plannerResult.stopReason === "error") {
				currentDetails.phase = "done";
				updateWidget(ctx);
				return {
					...makeToolResult(`Planner failed: ${plannerResult.errorMessage || plannerResult.stderr || plannerResult.output}`),
					isError: true,
				};
			}

			// ─── Phase 3: Parse plan and execute tasks ───
			const plan = parsePlan(cwd);
			if (!plan || plan.tasks.length === 0) {
				currentDetails.phase = "done";
				updateWidget(ctx);
				return makeToolResult(
					"Planner did not create valid PLAN.md/TASK files. Planner output:\n\n" + plannerResult.output,
				);
			}

			currentDetails.phase = "execute";
			const taskStates: TaskState[] = plan.tasks.map((def) => ({ def, status: "pending" }));
			currentDetails.taskStates = taskStates.map((ts) => ({
				id: ts.def.id,
				title: ts.def.title,
				specialist: ts.def.specialist,
				status: ts.status,
			}));
			updateWidget(ctx);

			// Execute tasks respecting dependencies
			const completed = new Set<number>();
			const results: TaskResult[] = [];

			while (completed.size < taskStates.length) {
				// Find runnable tasks: pending + all deps satisfied
				const runnable = taskStates.filter(
					(ts) =>
						ts.status === "pending" &&
						ts.def.dependsOn.every((dep) => completed.has(dep)),
				);

				if (runnable.length === 0) {
					// Check for deadlock - skip remaining pending tasks
					for (const ts of taskStates) {
						if (ts.status === "pending") {
							ts.status = "skipped";
							const idx = currentDetails.taskStates.findIndex((t) => t.id === ts.def.id);
							if (idx >= 0) currentDetails.taskStates[idx].status = "skipped";
						}
					}
					break;
				}

				// Run batch (up to MAX_CONCURRENCY)
				const batch = runnable.slice(0, MAX_CONCURRENCY);
				for (const ts of batch) ts.status = "running";
				// Update widget
				for (const ts of batch) {
					const idx = currentDetails.taskStates.findIndex((t) => t.id === ts.def.id);
					if (idx >= 0) currentDetails.taskStates[idx].status = "running";
				}
				updateWidget(ctx);

				const batchPromises = batch.map(async (ts) => {
					const agentName = specialistToAgent(ts.def.specialist);
					const agent = agentMap.get(agentName);
					if (!agent) {
						ts.status = "failed";
						const failResult: TaskResult = {
							taskId: ts.def.id,
							agent: agentName,
							task: ts.def.content,
							exitCode: 1,
							messages: [],
							stderr: `Unknown agent: ${agentName}`,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							output: `Agent "${agentName}" not found`,
						};
						ts.result = failResult;
						return failResult;
					}

					const taskPrompt = `Execute this task:\n\n${ts.def.content}`;
					const result = await runSubagent(cwd, agent, ts.def.id, taskPrompt, signal, (r) => {
						ts.result = r;
						const idx = currentDetails!.taskStates.findIndex((t) => t.id === ts.def.id);
						if (idx >= 0) currentDetails!.taskStates[idx].result = r;
						onUpdate?.(makeToolResult(`Executing TASK-${ts.def.id}: ${r.output.slice(0, 200) || "(running...)"}`));
						updateWidget(ctx);
					});

					const isError = result.exitCode !== 0 || result.stopReason === "error";
					ts.status = isError ? "failed" : "done";
					ts.result = result;
					return result;
				});

				const batchResults = await Promise.all(batchPromises);

				for (const ts of batch) {
					completed.add(ts.def.id);
					const idx = currentDetails.taskStates.findIndex((t) => t.id === ts.def.id);
					if (idx >= 0) {
						currentDetails.taskStates[idx].status = ts.status;
						currentDetails.taskStates[idx].result = ts.result;
					}
				}
				results.push(...batchResults);
				updateWidget(ctx);
			}

			// ─── Done ───
			currentDetails.phase = "done";
			updateWidget(ctx);

			const succeeded = taskStates.filter((ts) => ts.status === "done").length;
			const failed = taskStates.filter((ts) => ts.status === "failed").length;
			const skipped = taskStates.filter((ts) => ts.status === "skipped").length;

			const summary = [
				`## Orchestration Complete`,
				``,
				`**Goal:** ${goal}`,
				`**Results:** ${succeeded} succeeded, ${failed} failed, ${skipped} skipped out of ${taskStates.length} tasks`,
				``,
			];

			for (const ts of taskStates) {
				const icon = ts.status === "done" ? "✓" : ts.status === "failed" ? "✗" : "⊘";
				summary.push(`${icon} **TASK-${ts.def.id}**: ${ts.def.title} [${ts.def.specialist}]`);
				if (ts.result?.output) {
					const preview = ts.result.output.split("\n").slice(0, 3).join("\n");
					summary.push(`  ${preview}`);
				}
				summary.push("");
			}

			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: currentDetails,
				isError: failed > 0,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("orchestrate "));
			const goal = args.goal || "...";
			const preview = goal.length > 80 ? `${goal.slice(0, 80)}...` : goal;
			text += theme.fg("accent", preview);
			if (args.scoutHints) {
				text += `\n  ${theme.fg("dim", `Hints: ${args.scoutHints}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as OrchestratorDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const fg = theme.fg.bind(theme);
			const mdTheme = getMarkdownTheme();

			// Compact view
			if (!expanded) {
				const phaseIcon =
					details.phase === "done"
						? details.taskStates.some((t) => t.status === "failed")
							? fg("error", "✗")
							: fg("success", "✓")
						: fg("warning", "⏳");

				let text = `${phaseIcon} ${fg("toolTitle", theme.bold("orchestrate"))} ${fg("accent", details.goal)}`;
				text += `\n  ${fg("muted", `Phase: ${details.phase}`)}`;

				if (details.taskStates.length > 0) {
					for (const ts of details.taskStates) {
						const icon = statusIcon(ts.status, fg);
						text += `\n  ${icon} TASK-${ts.id}: ${ts.title} ${fg("muted", `[${ts.specialist}]`)}`;
						if (ts.result) {
							const usage = formatUsage(ts.result.usage, ts.result.model);
							if (usage) text += ` ${fg("dim", usage)}`;
						}
					}
				}

				return new Text(text, 0, 0);
			}

			// Expanded view
			const container = new Container();

			const doneIcon = details.taskStates.some((t) => t.status === "failed")
				? fg("error", "✗")
				: fg("success", "✓");
			container.addChild(
				new Text(
					`${doneIcon} ${fg("toolTitle", theme.bold("orchestrate"))} ${fg("accent", details.goal)}`,
					0,
					0,
				),
			);

			// Scout results
			if (details.scoutResult) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(fg("muted", "─── Scout ───"), 0, 0));
				const usage = formatUsage(details.scoutResult.usage, details.scoutResult.model);
				if (usage) container.addChild(new Text(fg("dim", usage), 0, 0));
			}

			// Planner results
			if (details.plannerResult) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(fg("muted", "─── Planner ───"), 0, 0));
				const usage = formatUsage(details.plannerResult.usage, details.plannerResult.model);
				if (usage) container.addChild(new Text(fg("dim", usage), 0, 0));
			}

			// Task results
			for (const ts of details.taskStates) {
				container.addChild(new Spacer(1));
				const icon = statusIcon(ts.status, fg);
				container.addChild(
					new Text(
						`${fg("muted", `─── TASK-${ts.id}: `)}${fg("accent", ts.title)} ${fg("muted", `[${ts.specialist}]`)} ${icon}`,
						0,
						0,
					),
				);

				if (ts.result) {
					// Show tool calls
					const items = getDisplayItems(ts.result.messages);
					for (const item of items) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(
									fg("muted", "→ ") + formatToolCall(item.name, item.args, fg),
									0,
									0,
								),
							);
						}
					}

					// Show output as markdown
					if (ts.result.output) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(ts.result.output.trim(), 0, 0, mdTheme));
					}

					const usage = formatUsage(ts.result.usage, ts.result.model);
					if (usage) container.addChild(new Text(fg("dim", usage), 0, 0));
				}
			}

			// Total usage
			if (details.taskStates.length > 0) {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
				const allResults = [
					details.scoutResult,
					details.plannerResult,
					...details.taskStates.map((t) => t.result),
				].filter(Boolean) as TaskResult[];
				for (const r of allResults) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				container.addChild(new Spacer(1));
				container.addChild(new Text(fg("dim", `Total: ${formatUsage(total)}`), 0, 0));
			}

			return container;
		},
	});

	// Command to manually trigger orchestration
	pi.registerCommand("orchestrate", {
		description: "Orchestrate a multi-agent workflow (scout → plan → execute)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /orchestrate <goal>", "warning");
				return;
			}
			pi.sendUserMessage(
				`Use the orchestrate tool to accomplish: ${args.trim()}`,
			);
		},
	});

	// Command to show current plan status
	pi.registerCommand("plan-status", {
		description: "Show orchestration progress",
		handler: async (_args, ctx) => {
			const plan = parsePlan(ctx.cwd);
			if (!plan) {
				ctx.ui.notify("No PLAN.md found in current directory", "info");
				return;
			}

			const lines = [`Plan: ${plan.goal}`, `Tasks: ${plan.tasks.length}`, ""];
			for (const t of plan.tasks) {
				lines.push(`  TASK-${t.id}: ${t.title} [${t.specialist}]`);
				if (t.dependsOn.length > 0) {
					lines.push(`    depends on: ${t.dependsOn.map((d) => `TASK-${d}`).join(", ")}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Clean up widget on shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		currentDetails = null;
		updateWidget(ctx);
	});
}
