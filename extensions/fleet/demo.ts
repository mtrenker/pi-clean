// Fleet extension — demo task generation
// Creates a temporary fake project root with a mock .pi/tasks/ tree so
// /fleet:demo can exercise the orchestrator + widget without touching real tasks.

import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { FleetConfig, SimulateConfig } from "./config.js";
import { createTaskFolder } from "./task.js";
import type { TaskSpec } from "./plan.js";

export type DemoPreset = "happy" | "failure" | "parallel" | "big";

// ── Per-task progress step sequences ─────────────────────────────────────────
//
// Messages are intentionally varied in length:
//  - Short  (<30 chars)  → lots of trailing padding in the sub-line.
//  - Medium (30–62)      → fits comfortably in the 63-char message column.
//  - Long   (≥63 chars)  → will be truncated to 60 chars + "..." by fit().
//    (PROGRESS_MSG_WIDTH = LINE_WIDTH - prefix(2) - ts(8) - gap(1) = 63)
//
// This ensures the demo exercises all branches of the widget's two-line layout.

function demoTaskSteps(): NonNullable<SimulateConfig["taskSteps"]> {
  return {
    // ── 001 Discover context (scout) ─────────────────────────────────────
    "Discover context": [
      "Listing top-level directories",                                       // 29 – short
      "Reading package.json and tsconfig.json for tech-stack overview",      // 62 – fits exactly
      "Scanning extensions/fleet/ for module exports and public interfaces", // 66 – truncated
      "Grepping for EventEmitter usage across non-test source files",        // 60 – fits
      "Mapping task-state lifecycle: pending→running→done/failed/retrying",  // 66 – truncated
      "Summarising findings: 8 modules, 3 engine adapters, typed event bus", // 68 – truncated
    ],

    // ── 002 Implement core (worker) ──────────────────────────────────────
    "Implement core": [
      "Reading orchestrator.ts to understand the current state machine",     // 63 – exact fit
      "Identifying missing retry logic in _handleComplete handler",          // 57 – fits
      "Implementing exponential back-off with configurable jitter",          // 57 – fits
      "Wiring latestProgressAt/latestProgressMessage into RuntimeTaskState", // 68 – truncated
      "Writing unit tests for retry, kill, and concurrent-schedule paths",   // 65 – truncated
      "Running npx tsc --noEmit — 0 errors",                                 // 36 – short
    ],

    // ── 003 Build widget (worker) ────────────────────────────────────────
    "Build widget": [
      "Reviewing widget render loop and existing column layout constants",   // 65 – truncated
      "Adding PROGRESS_TS_LEN and PROGRESS_GAP constants",                   // 49 – fits
      "Implementing formatProgressLine() with fixed-width ts + message",     // 63 – exact fit
      "Rendering two-line rows for tasks that carry a progress entry",       // 60 – fits
      "Updating widget.test.ts: alignment, truncation, empty-entry cases",   // 65 – truncated
      "All widget tests pass",                                               // 21 – short
    ],

    // ── 004 Review changes (reviewer) ───────────────────────────────────
    "Review changes": [
      "Reading all modified files in extensions/fleet/",                     // 47 – fits
      "Checking formatProgressLine handles empty entry and long messages",   // 64 – truncated
      "Verifying latestProgressAt and latestProgressMessage propagation",    // 63 – exact fit
      "Edge case: whitespace-only step is filtered out by progress parser",  // 65 – truncated
      "Confirmed token counts accumulate correctly across usage events",     // 62 – fits
      "Review complete — all changes correct and well-tested",               // 52 – fits
    ],

    // ── 005 Polish docs (worker) ─────────────────────────────────────────
    "Polish docs": [
      "Reading README.md and PLAN.md",                                       // 29 – short
      "Updating widget section with two-line layout description and example",// 66 – truncated
      "Adding demo preset descriptions to demo.ts file header comment",      // 61 – fits
      "Documenting SimulateConfig.taskSteps field in config.ts JSDoc",       // 62 – fits
      "Final pass: all JSDoc comments accurate and consistent",              // 54 – fits
    ],

    // ── 006 Add telemetry (worker) ───────────────────────────────────────
    "Add telemetry": [
      "Reading orchestrator.ts to locate telemetry insertion points",        // 61 – fits
      "Adding structured log entries around task spawn and completion",       // 61 – fits
      "Emitting timing metrics via appendProgress for each state transition",// 65 – truncated
      "Verifying telemetry output format matches expected JSONL schema",      // 62 – fits
      "Running integration smoke-test with simulate engine",                 // 51 – fits
    ],

    // ── 007 Refine recovery (worker) ─────────────────────────────────────
    "Refine recovery": [
      "Reading recovery.ts and reviewing current retry trigger logic",       // 62 – fits
      "Analysing failure patterns from simulated runs to tune retry delays", // 67 – truncated
      "Implementing configurable retry delay with exponential back-off",     // 62 – fits
      "Updating recovery.md template to include richer diagnostic context",  // 65 – truncated
      "Tests pass — retry logic verified for both first and second failures",// 67 – truncated
    ],

    // ── 008 Final check (reviewer) ───────────────────────────────────────
    "Final check": [
      "Reading all task output files and reviewing final codebase state",    // 64 – truncated
      "Running npx tsc --noEmit and node --test across fleet extension",     // 63 – exact fit
      "Confirming widget renders correctly with two-line progress layout",   // 64 – truncated
      "Reviewing PLAN.md acceptance criteria one by one",                    // 48 – fits
      "Sign-off: implementation complete, all requirements met",             // 53 – fits
    ],
  };
}

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
      model: "gpt-5.3-codex",
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
      model: "gpt-5.3-codex",
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
  const steps = demoTaskSteps();

  switch (preset) {
    case "happy":
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [2500, 5000],
        progressIntervalMs: sim.progressIntervalMs ?? 700,
        failureRate: 0,
        taskSteps: steps,
      };
      break;
    case "failure":
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [2500, 5000],
        progressIntervalMs: sim.progressIntervalMs ?? 700,
        failureRate: 0.45,
        taskSteps: steps,
      };
      break;
    case "parallel":
      next.concurrency = Math.max(next.concurrency, 3);
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [3000, 6000],
        progressIntervalMs: sim.progressIntervalMs ?? 800,
        failureRate: 0.1,
        taskSteps: steps,
      };
      break;
    case "big":
      next.concurrency = Math.max(next.concurrency, 3);
      next.simulate = {
        taskDurationMs: sim.taskDurationMs ?? [3000, 6500],
        progressIntervalMs: sim.progressIntervalMs ?? 800,
        failureRate: 0.15,
        taskSteps: steps,
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
