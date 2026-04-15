// Fleet extension entry point
// Orchestrates work across pi, claude, and codex engines.

import fs from "fs/promises";
import path from "path";
import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

// Re-export foundational types so other modules can import from "fleet/index"
export type { FleetConfig, AgentConfig, EngineConfig } from "./config.js";
export type { TaskSpec } from "./plan.js";
export { loadConfig, resolveAgentPrompt } from "./config.js";
export { parsePlan, loadPlan, validateDependencies } from "./plan.js";

import { loadConfig } from "./config.js";
import { loadPlan, validateDependencies } from "./plan.js";
import { createTaskFolder, listTasks, writeStatus, taskDir } from "./task.js";
import { Orchestrator } from "./orchestrator.js";
import { handleFailure } from "./recovery.js";
import { FleetWidget } from "./widget.js";

// ── Module-level singletons ───────────────────────────────────────────────────

let orchestrator: Orchestrator | null = null;
let widget: FleetWidget | null = null;

// ── Extension factory ─────────────────────────────────────────────────────────

const fleetExtension: ExtensionFactory = (pi) => {
  // ── Session shutdown ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    widget?.detach();
    await orchestrator?.stop();
  });

  // ── fleet_status tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "fleet_status",
    label: "Fleet Status",
    description:
      "Get the current status of fleet tasks. Use this to answer questions about task progress, what's running, what failed, etc.",
    promptSnippet: "Get current status of fleet agent tasks",
    parameters: Type.Object({
      taskId: Type.Optional(
        Type.String({ description: "Specific task ID (e.g. '001'), or omit for all tasks" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const tasks = await listTasks(ctx.cwd);
      const filtered = params.taskId
        ? tasks.filter((t) => t.id === params.taskId)
        : tasks;

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: params.taskId
                ? `Task ${params.taskId} not found`
                : "No tasks found. Run /fleet:split first.",
            },
          ],
          details: {},
        };
      }

      const lines = filtered.map((t) => {
        const tokens = t.usage.inputTokens + t.usage.outputTokens;
        const tokenStr = tokens > 0 ? ` | ${(tokens / 1000).toFixed(1)}k tokens` : "";
        return `${t.status.padEnd(10)} ${t.id}-${t.name.padEnd(25)} ${t.engine}/${t.model}${tokenStr}`;
      });

      return {
        content: [{ type: "text" as const, text: `Fleet tasks:\n${lines.join("\n")}` }],
        details: { tasks: filtered },
      };
    },
  });

  // ── /fleet:groom ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:groom", {
    description: "Interactively refine PLAN.md with the LLM",
    async handler(_args, ctx) {
      try {
        const plan = await fs.readFile(
          path.join(ctx.cwd, ".pi/tasks/PLAN.md"),
          "utf8",
        );
        ctx.ui.setEditorText(
          `Please review and refine this plan. You can:\n` +
            `- Add or clarify task descriptions\n` +
            `- Adjust engine/model/agent assignments\n` +
            `- Fix or add dependencies\n` +
            `- Split large tasks into smaller ones\n\n` +
            `When done, write the updated PLAN.md to .pi/tasks/PLAN.md\n\n---\n\n${plan}`,
        );
        ctx.ui.notify(
          "Plan loaded into editor. Refine and ask the LLM to write the updated PLAN.md.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to load PLAN.md: ${(error as Error).message}`,
          "error",
        );
      }
    },
  });

  // ── /fleet:split ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:split", {
    description: "Parse PLAN.md and create task folder structure under .pi/tasks/",
    async handler(_args, ctx) {
      try {
        const tasks = await loadPlan(ctx.cwd);
        validateDependencies(tasks);

        let created = 0;
        for (const spec of tasks) {
          const dir = taskDir(ctx.cwd, spec.id, spec.slug);
          try {
            await fs.access(dir);
            // Folder already exists — skip
          } catch {
            // Folder doesn't exist — create it
            await createTaskFolder(ctx.cwd, spec);
            created++;
          }
        }

        ctx.ui.notify(`Created ${created} task folders in .pi/tasks/`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:start ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:start", {
    description: "Start tasks whose dependencies are met (optionally specify a task ID)",
    async handler(args, ctx) {
      try {
        const config = await loadConfig(ctx.cwd);

        if (!orchestrator) {
          orchestrator = new Orchestrator(ctx.cwd, config);
        }

        // Set up recovery integration
        orchestrator.on("task:status", async (event) => {
          if (event.status === "retrying") {
            await handleFailure({
              cwd: ctx.cwd,
              taskState: event.state,
              orchestrator: orchestrator!,
              onNotify: (msg) => ctx.ui.notify(msg, "warning"),
            });
          }
          if (event.status === "failed") {
            ctx.ui.notify(`Task ${event.id}-${event.name} failed.`, "error");
          }
        });

        // Create and attach widget
        widget = new FleetWidget(
          orchestrator,
          (id, lines) => ctx.ui.setWidget(id, lines),
          (id) => ctx.ui.setWidget(id, undefined),
        );
        widget.attach();

        await orchestrator.start(args ? [args] : undefined);

        const tasks = await listTasks(ctx.cwd);
        ctx.ui.notify(`Fleet started (${tasks.length} tasks)`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:stop ───────────────────────────────────────────────────────────

  pi.registerCommand("fleet:stop", {
    description: "Stop running agents (optionally specify a task ID)",
    async handler(args, ctx) {
      if (!orchestrator) {
        ctx.ui.notify("No fleet running", "info");
        return;
      }
      await orchestrator.stop(args || undefined);
      ctx.ui.notify(args ? `Stopped task ${args}` : "All tasks stopped", "info");
    },
  });

  // ── /fleet:status ─────────────────────────────────────────────────────────

  pi.registerCommand("fleet:status", {
    description: "Show a summary of all tasks and their current status",
    async handler(_args, ctx) {
      try {
        const tasks = await listTasks(ctx.cwd);

        if (tasks.length === 0) {
          ctx.ui.notify("No tasks found. Run /fleet:split first.", "info");
          return;
        }

        const statusSymbol: Record<string, string> = {
          done: "✓",
          running: "●",
          pending: "◌",
          failed: "✗",
          retrying: "✗",
        };

        const lines = tasks.map((t) => {
          const symbol = statusSymbol[t.status] ?? "?";
          const tokens = t.usage.inputTokens + t.usage.outputTokens;
          const tokenStr =
            tokens > 0
              ? ` ${(tokens / 1000).toFixed(1)}k tokens`
              : "";
          const taskLabel = `${t.id}-${t.name}`.padEnd(26);
          const statusLabel = t.status.padEnd(9);
          const engineModel = `${t.engine}/${t.model}`;
          return `${symbol} ${taskLabel} ${statusLabel} ${engineModel}${tokenStr}`;
        });

        const formattedStatus = `Fleet Status (${tasks.length} tasks)\n${lines.join("\n")}`;

        pi.sendMessage({
          customType: "fleet-status",
          content: formattedStatus,
          display: true,
        });
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:retry ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:retry", {
    description: "Manually retry a failed task (specify task ID)",
    async handler(args, ctx) {
      if (!args) {
        ctx.ui.notify("Usage: /fleet:retry <task-id>", "error");
        return;
      }

      try {
        if (!orchestrator) {
          // Create orchestrator if not running (user may be retrying after restart)
          const config = await loadConfig(ctx.cwd);
          orchestrator = new Orchestrator(ctx.cwd, config);
          // Load tasks into orchestrator state
          await orchestrator.start([]);
        }

        await orchestrator.retry(args);
        ctx.ui.notify(`Retrying task ${args}`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:reset ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:reset", {
    description: "Reset a task to pending status, clearing progress and output",
    async handler(args, ctx) {
      if (!args) {
        ctx.ui.notify("Usage: /fleet:reset <task-id>", "error");
        return;
      }

      try {
        const tasks = await listTasks(ctx.cwd);
        const task = tasks.find((t) => t.id === args);
        if (!task) {
          ctx.ui.notify(`Task ${args} not found`, "error");
          return;
        }

        const dir = taskDir(ctx.cwd, task.id, task.name);
        await fs.writeFile(path.join(dir, "progress.jsonl"), "");
        await fs.writeFile(path.join(dir, "output.jsonl"), "");
        try {
          await fs.unlink(path.join(dir, "recovery.md"));
        } catch {
          // File may not exist — ignore
        }

        await writeStatus(ctx.cwd, {
          ...task,
          status: "pending",
          retries: 0,
          error: null,
          pid: null,
          startedAt: null,
          completedAt: null,
          duration: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        });

        ctx.ui.notify(`Task ${args} reset to pending`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
};

export default fleetExtension;
