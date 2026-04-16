// Fleet extension entry point
// Orchestrates work across pi, claude, and codex engines.

import fs from "fs/promises";
import path from "path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { Key } from "@mariozechner/pi-tui";
import type { ExtensionContext, ExtensionFactory } from "@mariozechner/pi-coding-agent";

// Re-export foundational types so other modules can import from "fleet/index"
export type { FleetConfig, AgentConfig, EngineConfig, EngineProfileConfig, ThinkingLevel } from "./config.js";
export type { TaskSpec } from "./plan.js";
export { loadConfig, loadConfigWithStatus, resolveAgentPrompt } from "./config.js";
export { parsePlan, loadPlan, validateDependencies, parsePlanDocument, renderPlanDocument, validatePlanDocument, normalizePlanMarkdown } from "./plan.js";

import { loadConfigWithStatus, resolveTaskExecution } from "./config.js";
import { loadValidatedPlan } from "./plan.js";
import { createTaskFolder, listTasks, readProgress, writeStatus, taskDir, syncTaskFolder } from "./task.js";
import { buildAggregateState, writeAggregateState } from "./state.js";
import {
  archiveTaskFolders,
  clearActiveTaskSummaries,
  listTaskFolders,
  removeTaskFolders,
  writeArchiveSummary,
  writePlanSummary,
} from "./archive.js";
import { Orchestrator } from "./orchestrator.js";
import { handleFailure } from "./recovery.js";
import { FleetWidget } from "./widget.js";
import { createDemoRoot, cleanupDemoRoot, presetConfig, type DemoPreset } from "./demo.js";
import { openFleetInspector } from "./inspect.js";
import { extractLatestCodexUsageFromJsonl } from "./engines/codex-usage.js";

// ── Module-level singletons ───────────────────────────────────────────────────

let orchestrator: Orchestrator | null = null;
let widget: FleetWidget | null = null;
const fleetConfigBootstrapNotified = new Set<string>();
let widgetVisible = true;
let demoRoot: string | null = null;
let activeRoot: string | null = null;

const execFile = promisify(execFileCb);

function hasActiveExecution(): boolean {
  return orchestrator?.getSnapshot().some((task) => task.status === "running" || task.status === "retrying") ?? false;
}

async function refreshAggregateStateFromDisk(cwd: string): Promise<void> {
  const tasks = await listTasks(cwd);
  const progressMap = new Map<string, Awaited<ReturnType<typeof readProgress>>>();

  for (const task of tasks) {
    const progress = await readProgress(cwd, task.id, task.name);
    progressMap.set(`${task.id}-${task.name}`, progress);
  }

  const aggregate = buildAggregateState(tasks, progressMap);
  await writeAggregateState(cwd, aggregate);
}

async function maybeOfferArchiveCommit(
  ctx: ExtensionContext,
  cwd: string,
  archiveId: string,
): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return;
  }

  const choice = await ctx.ui.select(`Archive ${archiveId} created. Create a git commit for it now?`, [
    "Yes, commit the archive",
    "No, I'll commit manually",
  ]);

  if (choice !== "Yes, commit the archive") return;

  try {
    await execFile("git", ["add", "-A", ".pi/archive"], { cwd });
    await execFile("git", ["commit", "-m", `archive fleet tasks: ${archiveId}`], { cwd });
    ctx.ui.notify(`Created git commit for archive ${archiveId}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Archive commit failed: ${message}`, "warning");
  }
}

async function backfillCodexUsageFromOutput(cwd: string): Promise<{ updated: number; scanned: number }> {
  const tasks = await listTasks(cwd);
  let updated = 0;
  let scanned = 0;

  for (const task of tasks) {
    if (task.engine !== "codex") continue;
    scanned++;

    const outputPath = path.join(taskDir(cwd, task.id, task.name), "output.jsonl");
    let content: string;
    try {
      content = await fs.readFile(outputPath, "utf-8");
    } catch {
      continue;
    }

    const usage = extractLatestCodexUsageFromJsonl(content);
    if (!usage) continue;

    if (
      usage.inputTokens === task.usage.inputTokens &&
      usage.outputTokens === task.usage.outputTokens
    ) {
      continue;
    }

    await writeStatus(cwd, {
      ...task,
      usage,
    });
    updated++;
  }

  if (updated > 0) {
    await refreshAggregateStateFromDisk(cwd);
  }

  return { updated, scanned };
}

// ── Extension factory ─────────────────────────────────────────────────────────

const fleetExtension: ExtensionFactory = (pi) => {
  let clearWidgetSlot: (() => void) | null = null;

  function hideWidget(): void {
    widget?.detach();
    widget = null;
    clearWidgetSlot?.();
  }

  function showIdleWidget(ctx: ExtensionContext): void {
    if (!widgetVisible) return;
    clearWidgetSlot = () => ctx.ui.setWidget("fleet", undefined);
    ctx.ui.setWidget("fleet", [
      "Fleet idle — no active agents.",
      "Start work with /fleet:start, run a mock session with /fleet:demo, or inspect tasks with /fleet:status.",
      "Toggle this widget with /fleet:widget or Ctrl+Alt+F.",
    ]);
  }

  function showWidget(ctx: ExtensionContext): void {
    if (!widgetVisible || !orchestrator || widget || !hasActiveExecution()) return;

    clearWidgetSlot = () => ctx.ui.setWidget("fleet", undefined);
    widget = new FleetWidget(
      orchestrator,
      (id, lines) => ctx.ui.setWidget(id, lines),
      (id) => ctx.ui.setWidget(id, undefined),
    );
    widget.attach();
  }

  function syncWidget(ctx: ExtensionContext): void {
    if (!widgetVisible) {
      hideWidget();
      return;
    }

    if (hasActiveExecution()) {
      showWidget(ctx);
      return;
    }

    hideWidget();
    showIdleWidget(ctx);
  }

  function wireOrchestratorUi(ctx: ExtensionContext, cwd: string): void {
    if (!orchestrator) return;

    syncWidget(ctx);

    if (!(orchestrator as Orchestrator & { _fleetUiWired?: boolean })._fleetUiWired) {
      orchestrator.on("task:status", async (event) => {
        if (event.status === "retrying") {
          await handleFailure({
            cwd,
            taskState: event.state,
            orchestrator: orchestrator!,
            onNotify: (msg) => ctx.ui.notify(msg, "warning"),
          });
        }
        if (event.status === "failed") {
          ctx.ui.notify(`Task ${event.id}-${event.name} failed.`, "error");
        }
      });

      orchestrator.on("fleet:done", async (event) => {
        await writeArchiveSummary(cwd);
        const s = event.summary;
        ctx.ui.notify(
          `Fleet done — ✓ ${s.done} done  ✗ ${s.failed} failed. Wrote .pi/tasks/archive-summary.json`,
          "info",
        );
        syncWidget(ctx);
      });

      (orchestrator as Orchestrator & { _fleetUiWired?: boolean })._fleetUiWired = true;
    }
  }

  async function loadFleetConfigForCommand(ctx: ExtensionContext) {
    const result = await loadConfigWithStatus(ctx.cwd);
    if (result.createdDefaultConfig && !fleetConfigBootstrapNotified.has(ctx.cwd)) {
      fleetConfigBootstrapNotified.add(ctx.cwd);
      ctx.ui.notify(
        "Created .pi/fleet.json from defaults. Review it to adjust engines, profiles, agents, concurrency, and paths.",
        "info",
      );
    }
    return result.config;
  }

  async function ensureLiveOrchestrator(ctx: ExtensionContext): Promise<void> {
    if (!orchestrator) {
      const config = await loadFleetConfigForCommand(ctx);
      orchestrator = new Orchestrator(ctx.cwd, config);
    }
    activeRoot = ctx.cwd;
    wireOrchestratorUi(ctx, ctx.cwd);
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    syncWidget(ctx);
  });

  pi.on("session_shutdown", async () => {
    hideWidget();
    await orchestrator?.stop();
    await cleanupDemoRoot(demoRoot);
    demoRoot = null;
    activeRoot = null;
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
        const thinkingStr = t.thinking ? `:${t.thinking}` : "";
        const profileStr = t.profile ? ` [${t.profile}]` : "";
        return `${t.status.padEnd(10)} ${t.id}-${t.name.padEnd(25)} ${t.engine}/${t.model}${thinkingStr}${profileStr}${tokenStr}`;
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
          path.join(ctx.cwd, "PLAN.md"),
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

  // ── /fleet:profiles ───────────────────────────────────────────────────────

  pi.registerCommand("fleet:profiles", {
    description: "Show configured fleet execution profiles and per-engine model/thinking mappings",
    async handler(args, ctx) {
      try {
        const config = await loadFleetConfigForCommand(ctx);
        const profiles = config.profiles ?? {};
        const requested = (args || "").trim();

        const entries = requested
          ? Object.entries(profiles).filter(([name]) => name === requested)
          : Object.entries(profiles);

        if (entries.length === 0) {
          const available = Object.keys(profiles).join(", ") || "(none configured)";
          ctx.ui.notify(requested ? `Unknown profile "${requested}". Available: ${available}` : `No profiles configured.`, requested ? "error" : "info");
          return;
        }

        const blocks = entries.map(([name, profile]) => {
          const lines = [`Profile: ${name}`];
          for (const engine of Object.keys(profile).sort()) {
            const cfg = profile[engine];
            if (!cfg) continue;
            const thinking = cfg.thinking ? ` | thinking: ${cfg.thinking}` : "";
            lines.push(`- ${engine}: ${cfg.model}${thinking}`);
          }
          return lines.join("\n");
        });

        pi.sendMessage({
          customType: "fleet-profiles",
          content: blocks.join("\n\n"),
          display: true,
        });
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:split ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:split", {
    description: "Parse PLAN.md and create/update task folder structure under .pi/tasks/",
    async handler(_args, ctx) {
      try {
        if (hasActiveExecution()) {
          throw new Error("Fleet is currently running. Stop it before splitting a new PLAN.md.");
        }

        const config = await loadFleetConfigForCommand(ctx);
        const validatedPlan = await loadValidatedPlan(ctx.cwd, config.planPath);
        const tasks = validatedPlan.document.tasks;

        if (validatedPlan.normalizedContent.trim() !== validatedPlan.sourceContent.trim()) {
          await fs.writeFile(validatedPlan.planPath, validatedPlan.normalizedContent, "utf-8");
          ctx.ui.notify("Normalized PLAN.md to canonical fleet task format.", "info");
        }

        if (tasks.length === 0) {
          throw new Error("No tasks found in PLAN.md. Expected one or more '### Task NNN: ...' sections under '## Tasks'.");
        }

        const tasksRoot = path.join(ctx.cwd, ".pi", "tasks");
        await fs.mkdir(tasksRoot, { recursive: true });

        const resolvedTasks = [];
        const resolutionWarnings: string[] = [];
        for (const task of tasks) {
          const resolved = resolveTaskExecution(config, task);
          resolvedTasks.push({
            ...task,
            model: resolved.model,
            thinking: resolved.thinking,
          });
          resolutionWarnings.push(...resolved.warnings);
        }

        const existingTaskFolders = await listTaskFolders(ctx.cwd);
        const desiredFolders = new Set(resolvedTasks.map((spec) => `${spec.id}-${spec.slug}`));
        const staleFolders = existingTaskFolders.filter((name) => !desiredFolders.has(name));

        if (staleFolders.length > 0) {
          if (!ctx.hasUI) {
            throw new Error(
              `Stale task folders detected: ${staleFolders.join(", ")}. Re-run interactively to archive or discard them before splitting.`,
            );
          }

          const preview = staleFolders.slice(0, 8).join(", ");
          const suffix = staleFolders.length > 8 ? ` (+${staleFolders.length - 8} more)` : "";
          const choice = await ctx.ui.select(
            `Stale fleet tasks detected: ${preview}${suffix}`,
            [
              "Archive stale tasks",
              "Discard stale tasks",
              "Cancel split",
            ],
          );

          if (choice === "Cancel split" || !choice) {
            ctx.ui.notify("Split cancelled", "info");
            return;
          }

          if (choice === "Archive stale tasks") {
            const archiveEntry = await archiveTaskFolders(ctx.cwd, staleFolders, "split-stale");
            await maybeOfferArchiveCommit(ctx, ctx.cwd, archiveEntry.id);
            ctx.ui.notify(
              `Archived ${staleFolders.length} stale task folder(s) to ${archiveEntry.archivePath}`,
              "info",
            );
          } else {
            await removeTaskFolders(ctx.cwd, staleFolders);
            ctx.ui.notify(`Discarded ${staleFolders.length} stale task folder(s)`, "warning");
          }
        }

        await clearActiveTaskSummaries(ctx.cwd);

        let created = 0;
        let updated = 0;
        for (const spec of resolvedTasks) {
          const dir = taskDir(ctx.cwd, spec.id, spec.slug);
          try {
            await fs.access(dir);
            await syncTaskFolder(ctx.cwd, spec);
            updated++;
          } catch {
            await createTaskFolder(ctx.cwd, spec);
            created++;
          }
        }

        await writePlanSummary(ctx.cwd, config.planPath, resolvedTasks);
        try {
          await fs.unlink(path.join(tasksRoot, "archive-summary.json"));
        } catch {
          // ignore
        }
        await refreshAggregateStateFromDisk(ctx.cwd);

        const summary = `Split PLAN.md into ${resolvedTasks.length} task(s): ${created} created, ${updated} updated`;
        ctx.ui.notify(`${summary}.`, "info");
        if (resolutionWarnings.length > 0) {
          const preview = resolutionWarnings.slice(0, 3).join(" ");
          const suffix = resolutionWarnings.length > 3 ? ` (+${resolutionWarnings.length - 3} more)` : "";
          ctx.ui.notify(`Execution profile warnings: ${preview}${suffix}`, "warning");
        }
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:summarize ──────────────────────────────────────────────────────

  pi.registerCommand("fleet:summarize", {
    description: "Write .pi/tasks/archive-summary.json from current task progress/status",
    async handler(_args, ctx) {
      try {
        const tasks = await listTasks(ctx.cwd);
        if (tasks.length === 0) {
          ctx.ui.notify("No tasks found. Run /fleet:split first.", "info");
          return;
        }

        await writeArchiveSummary(ctx.cwd);
        ctx.ui.notify("Wrote .pi/tasks/archive-summary.json", "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:archive ────────────────────────────────────────────────────────

  pi.registerCommand("fleet:archive", {
    description: "Archive the current task set into .pi/archive/ and clear active task folders",
    async handler(_args, ctx) {
      try {
        if (hasActiveExecution()) {
          throw new Error("Fleet is currently running. Stop it before archiving tasks.");
        }

        const folders = await listTaskFolders(ctx.cwd);
        if (folders.length === 0) {
          ctx.ui.notify("No task folders found to archive.", "info");
          return;
        }

        if (!ctx.hasUI) {
          throw new Error("/fleet:archive requires an interactive UI session for confirmation.");
        }

        const choice = await ctx.ui.select(
          `Archive ${folders.length} active task folder(s) and clear them from .pi/tasks/?`,
          ["Archive current task set", "Cancel"],
        );
        if (choice !== "Archive current task set") {
          ctx.ui.notify("Archive cancelled", "info");
          return;
        }

        const archiveEntry = await archiveTaskFolders(ctx.cwd, folders, "manual");
        await clearActiveTaskSummaries(ctx.cwd);
        await refreshAggregateStateFromDisk(ctx.cwd);
        await maybeOfferArchiveCommit(ctx, ctx.cwd, archiveEntry.id);
        ctx.ui.notify(`Archived current task set to ${archiveEntry.archivePath}`, "info");
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
        await ensureLiveOrchestrator(ctx);
        await orchestrator!.start(args ? [args] : undefined);
        syncWidget(ctx);

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
      syncWidget(ctx);
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
          const thinkingStr = t.thinking ? `:${t.thinking}` : "";
          const profileStr = t.profile ? ` [${t.profile}]` : "";
          const engineModel = `${t.engine}/${t.model}${thinkingStr}`;
          return `${symbol} ${taskLabel} ${statusLabel} ${engineModel}${profileStr}${tokenStr}`;
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

  // ── /fleet:repair-usage ───────────────────────────────────────────────────

  pi.registerCommand("fleet:repair-usage", {
    description: "Backfill missing token usage from saved output.jsonl history",
    async handler(_args, ctx) {
      try {
        if (hasActiveExecution()) {
          throw new Error("Fleet is currently running. Stop it before repairing historical usage.");
        }

        const root = activeRoot ?? ctx.cwd;
        const { updated, scanned } = await backfillCodexUsageFromOutput(root);
        ctx.ui.notify(
          updated > 0
            ? `Backfilled token usage for ${updated} codex task(s) from output history (${scanned} scanned).`
            : `No codex usage updates were needed (${scanned} scanned).`,
          "info",
        );
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
        await ensureLiveOrchestrator(ctx);
        if (orchestrator!.getSnapshot().length === 0) {
          // Load tasks into orchestrator state after restart without scheduling work.
          await orchestrator!.start([]);
        }

        wireOrchestratorUi(ctx, ctx.cwd);
        await orchestrator!.retry(args);
        syncWidget(ctx);
        ctx.ui.notify(`Retrying task ${args}`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:simulate ────────────────────────────────────────────────────────

  pi.registerCommand("fleet:simulate", {
    description: "Run fleet in simulation mode — fires all events without spending tokens",
    async handler(args, ctx) {
      try {
        const config = await loadFleetConfigForCommand(ctx);

        // Always create a fresh orchestrator in simulate mode
        hideWidget();
        await orchestrator?.stop();

        orchestrator = new Orchestrator(
          ctx.cwd,
          config,
          (msg) => ctx.ui.notify(msg, "warning"),
          true, // simulate = true
        );
        activeRoot = ctx.cwd;

        orchestrator.on("fleet:done", (event) => {
          const s = event.summary;
          ctx.ui.notify(
            `Simulation done — ✓ ${s.done} done  ✗ ${s.failed} failed  total: ${((s.totalInputTokens + s.totalOutputTokens) / 1000).toFixed(1)}k tokens (simulated)`,
            "info",
          );
        });

        showWidget(ctx);

        await orchestrator.start(args ? [args] : undefined);
        syncWidget(ctx);

        const tasks = await listTasks(ctx.cwd);
        ctx.ui.notify(
          `Simulation started (${tasks.length} tasks, no real agents spawned)`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:demo ────────────────────────────────────────────────────────────

  pi.registerCommand("fleet:demo", {
    description: "Run a mock fleet with fake tasks + simulated engines for TUI development",
    async handler(args, ctx) {
      try {
        const preset = ((args || "parallel").trim() || "parallel") as DemoPreset;
        const allowed: DemoPreset[] = ["happy", "failure", "parallel", "big"];
        if (!allowed.includes(preset)) {
          ctx.ui.notify(
            `Unknown demo preset \"${preset}\". Use one of: ${allowed.join(", ")}`,
            "error",
          );
          return;
        }

        const baseConfig = await loadFleetConfigForCommand(ctx);
        const config = presetConfig(baseConfig, preset);

        hideWidget();
        await orchestrator?.stop();
        await cleanupDemoRoot(demoRoot);

        demoRoot = await createDemoRoot(preset);
        activeRoot = demoRoot;
        orchestrator = new Orchestrator(
          demoRoot,
          config,
          (msg) => ctx.ui.notify(msg, "warning"),
          true,
        );

        orchestrator.on("fleet:done", (event) => {
          const s = event.summary;
          ctx.ui.notify(
            `Demo done (${preset}) — ✓ ${s.done} done  ✗ ${s.failed} failed`,
            "info",
          );
        });

        showWidget(ctx);

        await orchestrator.start();
        syncWidget(ctx);
        ctx.ui.notify(
          `Demo started (${preset}) — mock tasks + simulated engines`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:widget ─────────────────────────────────────────────────────────

  pi.registerCommand("fleet:widget", {
    description: "Show, hide, or toggle the live fleet widget",
    async handler(args, ctx) {
      const action = (args || "toggle").trim().toLowerCase();
      if (!["show", "hide", "toggle", "status"].includes(action)) {
        ctx.ui.notify("Usage: /fleet:widget <show|hide|toggle|status>", "error");
        return;
      }

      if (action === "status") {
        ctx.ui.notify(`Fleet widget is ${widgetVisible ? "visible" : "hidden"}`, "info");
        return;
      }

      if (action === "show" || (action === "toggle" && !widgetVisible)) {
        widgetVisible = true;
        syncWidget(ctx);
        ctx.ui.notify("Fleet widget shown", "info");
        return;
      }

      widgetVisible = false;
      hideWidget();
      ctx.ui.notify("Fleet widget hidden", "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("f"), {
    description: "Toggle the fleet widget",
    handler: async (ctx) => {
      widgetVisible = !widgetVisible;
      syncWidget(ctx);
      ctx.ui.notify(`Fleet widget ${widgetVisible ? "shown" : "hidden"}`, "info");
    },
  });

  // ── /fleet:inspect ────────────────────────────────────────────────────────

  pi.registerCommand("fleet:inspect", {
    description: "Open an inspector overlay for task logs and details",
    async handler(args, ctx) {
      try {
        const root = activeRoot ?? ctx.cwd;
        await openFleetInspector(root, args || undefined, ctx);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // ── /fleet:reset ──────────────────────────────────────────────────────────

  pi.registerCommand("fleet:reset", {
    description: "Reset one task or all tasks to pending status, clearing progress and output",
    async handler(args, ctx) {
      if (!args) {
        ctx.ui.notify("Usage: /fleet:reset <task-id|all>", "error");
        return;
      }

      try {
        const root = activeRoot ?? ctx.cwd;
        const tasks = await listTasks(root);
        const targets = args === "all" ? tasks : tasks.filter((t) => t.id === args);

        if (targets.length === 0) {
          ctx.ui.notify(args === "all" ? "No tasks found" : `Task ${args} not found`, "error");
          return;
        }

        if (orchestrator) {
          await orchestrator.stop();
          hideWidget();
          orchestrator = null;
        }

        syncWidget(ctx);

        for (const task of targets) {
          const dir = taskDir(root, task.id, task.name);
          await fs.writeFile(path.join(dir, "progress.jsonl"), "");
          await fs.writeFile(path.join(dir, "output.jsonl"), "");
          try {
            await fs.unlink(path.join(dir, "recovery.md"));
          } catch {
            // File may not exist — ignore
          }

          await writeStatus(root, {
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
        }

        ctx.ui.notify(
          args === "all"
            ? `Reset ${targets.length} tasks to pending`
            : `Task ${args} reset to pending`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
};

export default fleetExtension;
