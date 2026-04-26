// Fleet extension — config loading and agent prompt resolution

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

export interface AgentConfig {
  prompt: string;
  tools: string[] | null;
}

export interface EngineConfig {
  command: string;
  args: string[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface EngineProfileConfig {
  model: string;
  thinking?: ThinkingLevel | string;
}

export interface SimulateConfig {
  /** [min, max] milliseconds a simulated task runs before completing. Default [4000, 10000] */
  taskDurationMs?: [number, number];
  /** Milliseconds between fake progress events. Default 1200 */
  progressIntervalMs?: number;
  /** Probability (0–1) a simulated task fails. Default 0.2 */
  failureRate?: number;
  /**
   * Per-task step sequences used by the simulate engine.
   * Keys are the task name as it appears in task.md (e.g. "Discover context").
   * When a matching key is found the engine cycles through those steps instead
   * of the built-in generic list.  Useful for demos that want realistic,
   * task-specific progress messages.
   */
  taskSteps?: Record<string, string[]>;
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
  profiles?: Record<string, Partial<Record<string, EngineProfileConfig>>>;
  /** Simulation settings used by /fleet:simulate */
  simulate?: SimulateConfig;
}

// ── Hardcoded defaults ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FleetConfig = {
  simulate: {
    taskDurationMs: [4000, 10000],
    progressIntervalMs: 1200,
    failureRate: 0.2,
  },
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
      args: ["-p", "--mode", "json", "--no-extensions"],
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
  profiles: {
    fast: {
      pi: { model: "openai-codex/gpt-5.4-mini", thinking: "low" },
      claude: { model: "haiku", thinking: "low" },
      codex: { model: "gpt-5.3-codex-spark", thinking: "low" },
    },
    balanced: {
      pi: { model: "openai-codex/gpt-5.4", thinking: "medium" },
      claude: { model: "sonnet", thinking: "medium" },
      codex: { model: "gpt-5.3-codex", thinking: "medium" },
    },
    deep: {
      pi: { model: "openai-codex/gpt-5.4", thinking: "high" },
      claude: { model: "sonnet", thinking: "high" },
      codex: { model: "gpt-5.4", thinking: "high" },
    },
  },
  agents: {
    worker: {
      prompt:
        "You are a worker agent. Implement the requested changes. Write clean, tested code. Track your progress in the explicit task-local progress path provided in task.md after each significant step, and never write to a repo-root progress.jsonl. Work only inside the current working directory and use relative paths from cwd; never assume paths like /root/project. Prefer targeted searches with exclusions (for example exclude node_modules, .git, and .pi/archive) instead of broad scans like **/*.md across the whole repo. Avoid unnecessary tool churn: once you have enough context, produce the deliverable promptly.",
      tools: null,
    },
    scout: {
      prompt:
        "You are a scout agent. Your job is read-only reconnaissance. Explore the codebase, gather context, and report your findings. Do NOT modify any files. Write your findings to the explicit task-local progress path provided in task.md, and never write to a repo-root progress.jsonl. Work only inside the current working directory and use relative paths from cwd; never assume paths like /root/project. Prefer targeted searches with exclusions (for example exclude node_modules, .git, and .pi/archive) instead of broad scans like **/*.md across the whole repo. Avoid unnecessary tool churn: gather the minimum context needed and then summarize.",
      tools: ["read", "grep", "find", "ls", "bash"],
    },
    reviewer: {
      prompt:
        "You are a reviewer agent. Review the changes made by previous tasks. Check for correctness, style, edge cases, and test coverage. Write your review to the explicit task-local progress path provided in task.md, and never write to a repo-root progress.jsonl. Work only inside the current working directory and use relative paths from cwd; never assume paths like /root/project. Prefer targeted searches with exclusions (for example exclude node_modules, .git, and .pi/archive) instead of broad scans like **/*.md across the whole repo. Avoid unnecessary tool churn: inspect the relevant files and then produce the review.",
      tools: ["read", "grep", "find", "ls", "bash"],
    },
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load fleet config from `<cwd>/.pi/fleet.json`.
 * If the file does not exist, write the default config there first.
 */
function mergeProfiles(
  base: FleetConfig["profiles"],
  override: FleetConfig["profiles"] | undefined,
): FleetConfig["profiles"] {
  const merged: NonNullable<FleetConfig["profiles"]> = {
    ...(base ?? {}),
  };

  for (const [profileName, overrideEngines] of Object.entries(override ?? {})) {
    merged[profileName] = {
      ...(base?.[profileName] ?? {}),
      ...(overrideEngines ?? {}),
    };
  }

  return merged;
}

export interface LoadConfigResult {
  config: FleetConfig;
  configPath: string;
  createdDefaultConfig: boolean;
}

export async function loadConfigWithStatus(cwd: string): Promise<LoadConfigResult> {
  const configDir = join(cwd, ".pi");
  const configPath = join(configDir, "fleet.json");

  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;

    const defaultConfig = structuredClone(DEFAULT_CONFIG);
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf-8");
    return {
      config: defaultConfig,
      configPath,
      createdDefaultConfig: true,
    };
  }

  const parsed = JSON.parse(content) as Partial<FleetConfig>;
  return {
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      defaults: {
        ...DEFAULT_CONFIG.defaults,
        ...(parsed.defaults ?? {}),
      },
      engines: {
        ...DEFAULT_CONFIG.engines,
        ...(parsed.engines ?? {}),
      },
      agents: {
        ...DEFAULT_CONFIG.agents,
        ...(parsed.agents ?? {}),
      },
      profiles: mergeProfiles(DEFAULT_CONFIG.profiles, parsed.profiles),
      simulate: {
        ...(DEFAULT_CONFIG.simulate ?? {}),
        ...(parsed.simulate ?? {}),
      },
    },
    configPath,
    createdDefaultConfig: false,
  };
}

export async function loadConfig(cwd: string): Promise<FleetConfig> {
  const result = await loadConfigWithStatus(cwd);
  return result.config;
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

function normalizeThinkingLevel(value: string): ThinkingLevel {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    default:
      throw new Error(
        `Unknown thinking level "${value}". Expected one of: off, minimal, low, medium, high, xhigh.`,
      );
  }
}

export interface TaskProfileInput {
  id: string;
  name: string;
  engine: string;
  model: string;
  profile?: string;
  thinking?: string;
}

export interface ResolvedTaskExecution {
  model: string;
  thinking?: string;
  warnings: string[];
}

const DEPRECATED_MODEL_ALIASES: Record<string, string> = {
  o3: "gpt-5.3-codex",
  "gpt-5.1-codex-max": "gpt-5.3-codex",
  "gpt-5.1-codex-mini": "gpt-5.3-codex-spark",
  "gpt-5.2-codex": "gpt-5.3-codex",
  "gpt-5.2": "gpt-5.4",
};

function normalizeModelAlias(model: string, task: TaskProfileInput, warnings: string[]): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  const replacement = DEPRECATED_MODEL_ALIASES[trimmed];
  if (!replacement) return trimmed;

  warnings.push(
    `Task ${task.id} ("${task.name}") requested deprecated model "${trimmed}"; using "${replacement}" instead.`,
  );
  return replacement;
}

function enforcePiModelPolicy(model: string, task: TaskProfileInput, warnings: string[]): string {
  const trimmed = model.trim();
  if (task.engine !== "pi" || !trimmed) return trimmed;

  const normalized = trimmed.toLowerCase();
  if (!normalized.includes("claude")) return trimmed;

  const replacement = "openai-codex/gpt-5.4";
  warnings.push(
    `Task ${task.id} ("${task.name}") requested PI model "${trimmed}", but PI must not use Claude models because they bypass the subscription-max path and bill per token; using "${replacement}" instead.`,
  );
  return replacement;
}

export function resolveTaskExecution(config: FleetConfig, task: TaskProfileInput): ResolvedTaskExecution {
  const warnings: string[] = [];
  const profileName = task.profile?.trim();
  const explicitModel = task.model.trim();
  const explicitThinking = task.thinking?.trim();

  let model = normalizeModelAlias(explicitModel, task, warnings);
  let thinkingSource = explicitThinking;

  if (profileName) {
    const profile = config.profiles?.[profileName];
    if (!profile) {
      const available = Object.keys(config.profiles ?? {}).join(", ") || "(none configured)";
      throw new Error(
        `Task ${task.id} ("${task.name}") references unknown profile "${profileName}". Available profiles: ${available}`,
      );
    }
    const profileConfig = profile[task.engine];
    if (!profileConfig) {
      throw new Error(
        `Task ${task.id} ("${task.name}") uses profile "${profileName}" but it has no mapping for engine "${task.engine}".`,
      );
    }
    if (!model) {
      model = normalizeModelAlias(profileConfig.model, task, warnings);
    }
    if (!thinkingSource && profileConfig.thinking) {
      thinkingSource = profileConfig.thinking;
    }
  }

  if (!model) {
    model = normalizeModelAlias(config.defaults.model, task, warnings);
  }

  model = enforcePiModelPolicy(model, task, warnings);

  if (!thinkingSource) {
    return { model, warnings };
  }

  const normalizedThinking = normalizeThinkingLevel(thinkingSource);

  switch (task.engine) {
    case "pi":
      return { model, thinking: normalizedThinking, warnings };
    case "claude": {
      const effortMap: Record<ThinkingLevel, string> = {
        off: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "max",
      };
      return { model, thinking: effortMap[normalizedThinking], warnings };
    }
    case "codex": {
      const reasoningMap: Record<ThinkingLevel, string> = {
        off: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      };
      return { model, thinking: reasoningMap[normalizedThinking], warnings };
    }
    default:
      warnings.push(
        `Task ${task.id} ("${task.name}") requested thinking level "${normalizedThinking}" for engine "${task.engine}", but no thinking mapping is defined for that engine.`,
      );
      return { model, warnings };
  }
}
