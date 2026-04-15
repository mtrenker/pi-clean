// Fleet extension — demo task generation
// Creates a temporary fake project root with a mock .pi/tasks/ tree so
// /fleet:demo can exercise the orchestrator + widget without touching real tasks.

import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { FleetConfig } from "./config.js";
import { createTaskFolder } from "./task.js";
import type { TaskSpec } from "./plan.js";

export type DemoPreset = "happy" | "failure" | "parallel" | "big";

function baseTasks(): TaskSpec[] {
  return [
    {
      id: "001",
      slug: "discover-context",
      name: "Discover context",
      engine: "pi",
      model: "sonnet",
      agent: "scout",
      depends: [],
      description: "Explore the repository structure, identify core modules, and summarize findings.",
    },
    {
      id: "002",
      slug: "implement-core",
      name: "Implement core",
      engine: "claude",
      model: "sonnet",
      agent: "worker",
      depends: ["001"],
      description: "Implement the main orchestration flow and core module behavior.",
    },
    {
      id: "003",
      slug: "build-widget",
      name: "Build widget",
      engine: "codex",
      model: "o3",
      agent: "worker",
      depends: ["001"],
      description: "Implement the UI widget layer and live progress rendering.",
    },
    {
      id: "004",
      slug: "review-changes",
      name: "Review changes",
      engine: "claude",
      model: "opus",
      agent: "reviewer",
      depends: ["002", "003"],
      description: "Review the combined changes, check edge cases, and validate quality.",
    },
    {
      id: "005",
      slug: "polish-docs",
      name: "Polish docs",
      engine: "pi",
      model: "sonnet",
      agent: "worker",
      depends: ["004"],
      description: "Improve documentation, examples, and final messaging.",
    },
  ];
}

function bigTasks(): TaskSpec[] {
  return [
    ...baseTasks(),
    {
      id: "006",
      slug: "add-telemetry",
      name: "Add telemetry",
      engine: "claude",
      model: "sonnet",
      agent: "worker",
      depends: ["002"],
      description: "Add telemetry and logging around task execution.",
    },
    {
      id: "007",
      slug: "refine-recovery",
      name: "Refine recovery",
      engine: "codex",
      model: "o3",
      agent: "worker",
      depends: ["004", "006"],
      description: "Refine retry behavior and improve recovery details.",
    },
    {
      id: "008",
      slug: "final-check",
      name: "Final check",
      engine: "claude",
      model: "opus",
      agent: "reviewer",
      depends: ["005", "007"],
      description: "Perform a final pass and sign off on the entire workflow.",
    },
  ];
}

export function presetConfig(base: FleetConfig, preset: DemoPreset): FleetConfig {
  const next = structuredClone(base);
  const sim = next.simulate ?? {};

  switch (preset) {
    case "happy":
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [2500, 5000],
        progressIntervalMs: sim.progressIntervalMs ?? 700,
        failureRate: 0,
      };
      break;
    case "failure":
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [2500, 5000],
        progressIntervalMs: sim.progressIntervalMs ?? 700,
        failureRate: 0.45,
      };
      break;
    case "parallel":
      next.concurrency = Math.max(next.concurrency, 3);
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [3000, 6000],
        progressIntervalMs: sim.progressIntervalMs ?? 800,
        failureRate: 0.1,
      };
      break;
    case "big":
      next.concurrency = Math.max(next.concurrency, 3);
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [3000, 6500],
        progressIntervalMs: sim.progressIntervalMs ?? 800,
        failureRate: 0.15,
      };
      break;
  }

  return next;
}

export async function createDemoRoot(preset: DemoPreset): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-demo-"));
  await mkdir(join(root, ".pi", "tasks"), { recursive: true });

  const tasks = preset === "big" ? bigTasks() : baseTasks();
  for (const task of tasks) {
    await createTaskFolder(root, task);
  }

  return root;
}

export async function cleanupDemoRoot(root: string | null | undefined): Promise<void> {
  if (!root) return;
  await rm(root, { recursive: true, force: true });
}
