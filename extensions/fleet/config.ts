// Fleet extension — config loading and agent prompt resolution

import { readFile } from "fs/promises";
import { join } from "path";

export interface AgentConfig {
  prompt: string;
  tools: string[] | null;
}

export interface EngineConfig {
  command: string;
  args: string[];
}

export interface FleetConfig {
  concurrency: number;
  planPath: string;       // relative to cwd, default "PLAN.md"
  tasksDir: string;      // relative to cwd, default ".pi/tasks"
  defaults: {
    engine: string;
    model: string;
    agent: string;
  };
  engines: Record<string, EngineConfig>;
  agents: Record<string, AgentConfig>;
}

// ── Hardcoded defaults ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FleetConfig = {
  concurrency: 2,
  planPath: "PLAN.md",
  tasksDir: ".pi/tasks",
  defaults: {
    engine: "claude",
    model: "sonnet",
    agent: "worker",
  },
  engines: {
    pi: {
      command: "pi",
      args: ["-p", "--output-format", "stream-json"],
    },
    claude: {
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--dangerously-skip-permissions"],
    },
    codex: {
      command: "codex",
      args: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox"],
    },
  },
  agents: {
    worker: {
      prompt:
        "You are a worker agent. Implement the requested changes. Write clean, tested code. Track your progress in progress.jsonl after each significant step.",
      tools: null,
    },
    scout: {
      prompt:
        "You are a scout agent. Your job is read-only reconnaissance. Explore the codebase, gather context, and report your findings. Do NOT modify any files. Write your findings to the task's progress.jsonl.",
      tools: ["read", "grep", "find", "ls", "bash"],
    },
    reviewer: {
      prompt:
        "You are a reviewer agent. Review the changes made by previous tasks. Check for correctness, style, edge cases, and test coverage. Write your review to progress.jsonl.",
      tools: ["read", "grep", "find", "ls", "bash"],
    },
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load fleet config from `<cwd>/.pi/tasks/config.json`.
 * Falls back to hardcoded defaults when the file does not exist.
 */
export async function loadConfig(cwd: string): Promise<FleetConfig> {
  const configPath = join(cwd, ".pi", "tasks", "config.json");
  try {
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content) as FleetConfig;
  } catch {
    // File missing or unreadable — return a fresh copy of defaults
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Return the system prompt for the named agent.
 * Throws an informative error if the agent is not defined in config.
 */
export function resolveAgentPrompt(config: FleetConfig, agentName: string): string {
  const agent = config.agents[agentName];
  if (!agent) {
    const available = Object.keys(config.agents).join(", ");
    throw new Error(
      `Agent "${agentName}" not found in config. Available agents: ${available}`,
    );
  }
  return agent.prompt;
}
