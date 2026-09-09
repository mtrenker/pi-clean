// Single source of truth for interactive agent launch settings.
// Design: docs/agent-launch-profiles.md. Do not spell a model name, permission flag, or
// delegation control anywhere else; read them from here or from `github-work.mjs launch-command`.

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = [...CLAUDE_EFFORTS, "ultra"];

// Removes the built-in subagent tool instead of denying it, so it also applies under
// --permission-mode bypassPermissions. See docs/agent-launch-profiles.md for enforcement limits.
const CLAUDE_NO_NATIVE_DELEGATION = '{"disabledBuiltinTools":["Task"]}';

export const VERIFIED_CLIS = {
  claude: "2.1.266",
  codex: "0.153.4",
  herdr: "0.8.2",
  verifiedOn: "2026-09-09"
};

export const AGENT_PROFILES = {
  "claude-opus": {
    program: "claude",
    model: "claude-opus-5",
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "high",
    execution: "bypassPermissions",
    nativeDelegation: "disabled",
    designOwner: true
  },
  "claude-fable": {
    program: "claude",
    model: "claude-fable-5-1",
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "high",
    execution: "bypassPermissions",
    nativeDelegation: "disabled",
    designOwner: false
  },
  "codex-sol-write": {
    program: "codex",
    model: "gpt-5.6-sol",
    efforts: CODEX_EFFORTS,
    defaultEffort: "high",
    execution: "workspace-write",
    nativeDelegation: "disabled",
    designOwner: false
  },
  "codex-sol-read": {
    program: "codex",
    model: "gpt-5.6-sol",
    efforts: CODEX_EFFORTS,
    defaultEffort: "medium",
    execution: "read-only",
    nativeDelegation: "disabled",
    designOwner: false
  },
  "pi-ambient": {
    program: "pi",
    model: "ambient",
    efforts: [],
    defaultEffort: null,
    execution: "ambient",
    nativeDelegation: "not-applicable",
    designOwner: false
  }
};

// Agent names accepted by github-work.mjs, mapped to the profile they launch.
export const AGENT_PROFILE_IDS = {
  claude: "claude-opus",
  codex: "codex-sol-write",
  pi: "pi-ambient"
};

export const DEFAULT_ISSUE_AGENT = "claude";
export const DEFAULT_REVIEWER = "claude";

export function profileIds() {
  return Object.keys(AGENT_PROFILES);
}

export function agentProfile(id) {
  const profile = AGENT_PROFILES[id];
  if (!profile) throw new Error(`unknown launch profile: ${id}; supported: ${profileIds().join(", ")}`);
  return { id, ...profile };
}

export function profileForAgent(agent) {
  const id = AGENT_PROFILE_IDS[agent];
  if (!id) throw new Error(`agent must be ${Object.keys(AGENT_PROFILE_IDS).join(", ")}, or none`);
  return agentProfile(id);
}

export function resolveEffort(profile, requested) {
  if (profile.efforts.length === 0) {
    if (requested) throw new Error(`profile ${profile.id} takes its effort from personal settings; drop --effort`);
    return null;
  }
  const effort = requested ?? profile.defaultEffort;
  if (!profile.efforts.includes(effort)) {
    throw new Error(`unsupported effort ${effort} for profile ${profile.id}; supported: ${profile.efforts.join(", ")}`);
  }
  return effort;
}

// Exact interactive command for a Herdr pane. Never add a fallback: an unsupported model,
// effort, or permission value must fail here instead of silently launching something else.
export function launchCommand({ profile: id, effort, prompt }) {
  const profile = agentProfile(id);
  const level = resolveEffort(profile, effort);
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("launch prompt is required");

  switch (profile.program) {
    case "claude":
      return `claude --model ${profile.model} --effort ${level} --permission-mode bypassPermissions`
        + ` --settings ${shellQuote(CLAUDE_NO_NATIVE_DELEGATION)} ${shellQuote(prompt)}`;
    case "codex":
      return `codex --model ${profile.model} -c 'model_reasoning_effort="${level}"' --disable multi_agent`
        + ` --ask-for-approval never --sandbox ${profile.execution} ${shellQuote(prompt)}`;
    case "pi":
      return `pi ${shellQuote(prompt)}`;
    default:
      throw new Error(`profile ${profile.id} has no launch template`);
  }
}

export function describeProfiles() {
  return {
    verifiedClis: VERIFIED_CLIS,
    defaults: { issueAgent: DEFAULT_ISSUE_AGENT, reviewer: DEFAULT_REVIEWER, agents: AGENT_PROFILE_IDS },
    profiles: profileIds().map((id) => agentProfile(id))
  };
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
