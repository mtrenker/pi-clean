#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const AGENTS = new Set(["pi", "claude", "codex", "none"]);

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const needsId = ["start-issue", "review-pr", "finish-issue", "cleanup-pr"].includes(command);
  const id = needsId ? args.shift() : undefined;

  try {
    const options = parseOptions(args, allowedOptions(command));
    switch (command) {
      case "start-issue":
        requireId(command, id);
        return output(await startIssue(id, options));
      case "review-pr":
        requireId(command, id);
        return output(await reviewPr(id, options));
      case "finish-issue":
        requireId(command, id);
        return output(await cleanup("issue", id, options));
      case "cleanup-pr":
        requireId(command, id);
        return output(await cleanup("pr", id, options));
      case "status":
        return output(await status());
      case "help":
      case undefined:
        return printHelp(command ? 0 : 1);
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

async function startIssue(number, options) {
  const agent = options.agent ?? "pi";
  verifyTools(agent, agent !== "none");
  const context = repoContext();
  if (process.env.HERDR_ENV === "1") verifyNativeHerdrWorktreeSupport(context.repoRoot);
  const issue = jsonCommand("gh", ["issue", "view", number, "--json", "number,title,state,url"]);
  if (issue.state !== "OPEN" && !options.allowClosed) throw new Error(`issue #${number} is ${issue.state.toLowerCase()}`);

  const slug = slugify(issue.title);
  const workId = `github:${context.nameWithOwner}:issue:${issue.number}`;
  const managedRoot = resolve(worktreeRoot(), "github.com", context.nameWithOwner);
  const issueRoot = join(managedRoot, "issues");

  run("git", ["-C", context.repoRoot, "fetch", context.remote, "--prune"]);
  const entries = worktreeEntries(context.repoRoot);
  const issueEntries = entries.filter(
    (entry) => dirname(entry.path) === issueRoot && basename(entry.path).startsWith(`${issue.number}-`)
  );
  if (issueEntries.length > 1) {
    throw new Error(`multiple managed worktrees exist for issue #${issue.number}; clean up duplicates before continuing`);
  }

  const existingIssue = issueEntries[0];
  const existingBranch = existingIssue?.branch?.replace("refs/heads/", "");
  if (existingIssue && !existingBranch) throw new Error(`issue worktree is detached instead of using an issue branch: ${existingIssue.path}`);
  if (existingBranch && options.branch && existingBranch !== options.branch) {
    throw new Error(`issue #${issue.number} already uses branch ${existingBranch}, not requested branch ${options.branch}`);
  }

  const branch = existingBranch ?? options.branch ?? `issue/${issue.number}-${slug}`;
  const path = existingIssue?.path ?? join(issueRoot, `${issue.number}-${slug}`);
  const branchEntry = entries.find((entry) => entry.branch === `refs/heads/${branch}`);
  if (branchEntry && branchEntry.path !== path) {
    throw new Error(`branch ${branch} is already checked out outside the managed worktree: ${branchEntry.path}`);
  }

  const labelPrefix = `${context.repoName} · #${issue.number} ·`;
  const label = `${labelPrefix} ${truncate(issue.title, 42)}`;
  const prompt = `Work on GitHub issue #${issue.number} in ${context.nameWithOwner}. Read the repository instructions and issue, implement it in this worktree, validate the changes, and prepare a pull request. Do not merge.`;
  const launchEnvironment = flightdeckLaunchEnvironment({
    workId,
    projectSlug: context.repoName,
    repoRoot: context.repoRoot,
    repository: context.nameWithOwner,
    worktreePath: path,
    role: "author",
    runtime: "herdr",
    workspaceLabel: label,
    branch
  });

  const createdWorktree = !existingIssue;
  let runtime;
  if (process.env.HERDR_ENV === "1") {
    await mkdir(dirname(path), { recursive: true });
    runtime = createOrOpenHerdrIssueWorktree({
      repoRoot: context.repoRoot,
      path,
      branch,
      base: `${context.remote}/${context.defaultBranch}`,
      label,
      agent,
      prompt,
      launchEnvironment,
      existingWorktree: Boolean(existingIssue)
    });
  } else {
    if (createdWorktree) {
      await mkdir(dirname(path), { recursive: true });
      if (branchExists(context.repoRoot, branch)) {
        run("git", ["-C", context.repoRoot, "worktree", "add", path, branch]);
      } else {
        run("git", ["-C", context.repoRoot, "worktree", "add", "-b", branch, path, `${context.remote}/${context.defaultBranch}`]);
      }
    }
    runtime = { runtime: "none", workspaceLabel: label, createdWorkspace: false, agentStarted: false };
  }

  if (createdWorktree) await emit("worktree.created", "Issue worktree created", {
    worktreeId: workId,
    repoId: context.nameWithOwner,
    branchId: branch,
    path,
    workId,
    projectId: context.repoName,
    repository: context.nameWithOwner,
    issueNumber: issue.number,
    role: "author",
    runtime: runtime.runtime,
    workspaceLabel: runtime.workspaceLabel
  });
  if (runtime.agentStarted) {
    await emit("agent.run.started", "Issue agent started", {
      agentId: `${workId}:${agent}`,
      taskId: `issue:${issue.number}`,
      runId: workId,
      engine: agent,
      status: "running",
      workId,
      projectId: context.repoName,
      repository: context.nameWithOwner,
      issueNumber: issue.number,
      worktreePath: path,
      workspaceLabel: runtime.workspaceLabel
    });
  }

  return { ok: true, kind: "issue", workId, repository: context.nameWithOwner, issue, branch, worktreePath: path, createdWorktree, agent, ...runtime };
}

async function reviewPr(number, options) {
  const reviewer = options.reviewer ?? "claude";
  verifyTools(reviewer, true);
  const context = repoContext();
  const pr = jsonCommand("gh", ["pr", "view", number, "--json", "number,title,state,url,headRefName,baseRefName"]);
  if (pr.state !== "OPEN" && !options.allowClosed) throw new Error(`pull request #${number} is ${pr.state.toLowerCase()}`);

  if (!AGENTS.has(reviewer) || reviewer === "none") throw new Error("--reviewer must be pi, claude, or codex");
  const workId = `github:${context.nameWithOwner}:pr:${pr.number}:review:${reviewer}`;
  const path = resolve(worktreeRoot(), "github.com", context.nameWithOwner, "prs", String(pr.number), `review-${reviewer}`);
  const reviewRef = `refs/remotes/${context.remote}/pr/${pr.number}`;

  run("git", ["-C", context.repoRoot, "fetch", context.remote, `pull/${pr.number}/head:${reviewRef}`, "--force"]);
  const existing = worktreeEntries(context.repoRoot).find((entry) => entry.path === path);
  const createdWorktree = !existing;
  if (createdWorktree) {
    await mkdir(dirname(path), { recursive: true });
    run("git", ["-C", context.repoRoot, "worktree", "add", "--detach", path, reviewRef]);
  } else {
    const dirty = command("git", ["-C", path, "status", "--porcelain"]).stdout.trim();
    if (dirty) throw new Error(`refusing to refresh dirty review worktree: ${path}`);
    run("git", ["-C", path, "checkout", "--detach", reviewRef]);
  }

  const label = `${context.repoName} · PR #${pr.number} · review/${reviewer}`;
  const runtime = createHerdrWorkspace(
    path,
    label,
    reviewer,
    `Independently review GitHub pull request #${pr.number} in ${context.nameWithOwner}. Inspect the issue context, full diff, tests, regressions, and security. Do not modify the author worktree, approve, merge, or publish comments without explicit authorization.`,
    label,
    flightdeckLaunchEnvironment({
      workId,
      projectSlug: context.repoName,
      repoRoot: context.repoRoot,
      repository: context.nameWithOwner,
      worktreePath: path,
      role: "reviewer",
      reviewer,
      runtime: "herdr",
      workspaceLabel: label,
      branch: pr.headRefName
    })
  );

  if (createdWorktree) await emit("worktree.created", "Pull request review worktree created", {
    worktreeId: workId,
    repoId: context.nameWithOwner,
    branchId: pr.headRefName,
    path,
    workId,
    projectId: context.repoName,
    repository: context.nameWithOwner,
    prNumber: pr.number,
    role: "reviewer",
    reviewer,
    runtime: runtime.runtime,
    workspaceLabel: runtime.workspaceLabel
  });
  if (runtime.agentStarted) await emit("agent.run.started", "Pull request review agent started", {
    agentId: `${workId}:${reviewer}`,
    taskId: `pr:${pr.number}:review`,
    runId: workId,
    engine: reviewer,
    status: "running",
    workId,
    projectId: context.repoName,
    repository: context.nameWithOwner,
    prNumber: pr.number,
    role: "reviewer",
    worktreePath: path,
    workspaceLabel: runtime.workspaceLabel
  });

  return { ok: true, kind: "pr-review", workId, repository: context.nameWithOwner, pullRequest: pr, reviewer, worktreePath: path, createdWorktree, ...runtime };
}

async function cleanup(kind, number, options) {
  const context = repoContext();
  const entries = worktreeEntries(context.repoRoot);
  const managedRoot = resolve(worktreeRoot(), "github.com", context.nameWithOwner);
  const matches = entries.filter((entry) => {
    if (kind === "issue") {
      return dirname(entry.path) === join(managedRoot, "issues") && basename(entry.path).startsWith(`${number}-`);
    }
    return dirname(entry.path) === join(managedRoot, "prs", String(number)) && basename(entry.path).startsWith("review-");
  });
  if (matches.length === 0) return { ok: true, removed: [], message: `no ${kind} #${number} worktrees found` };

  for (const entry of matches) {
    const dirty = command("git", ["-C", entry.path, "status", "--porcelain"]).stdout.trim();
    if (dirty) throw new Error(`refusing to remove dirty worktree: ${entry.path}`);
  }

  const nativeIssueWorkspaces = kind === "issue"
    ? prepareIssueHerdrRemoval(context.repoName, number, matches)
    : new Map();
  if (kind === "pr") closeHerdrWorkspaces(context.repoName, kind, number);

  const removed = [];
  for (const entry of matches) {
    const nativeWorkspaceId = nativeIssueWorkspaces.get(resolve(entry.path));
    if (nativeWorkspaceId) {
      const response = nativeHerdrJson(["worktree", "remove", "--workspace", nativeWorkspaceId], "remove");
      const result = response.result ?? response;
      if (result.type !== "worktree_removed" || resolve(result.path ?? "") !== resolve(entry.path) || result.forced !== false) {
        throw new Error(`Herdr returned an invalid worktree removal response for ${entry.path}`);
      }
    } else {
      run("git", ["-C", context.repoRoot, "worktree", "remove", entry.path]);
    }
    removed.push(entry.path);
    await emit("worktree.removed", `${kind} worktree removed`, {
      worktreeId: `github:${context.nameWithOwner}:${kind}:${number}`,
      repoId: context.nameWithOwner,
      path: entry.path,
      workId: `github:${context.nameWithOwner}:${kind}:${number}`,
      projectId: context.repoName,
      repository: context.nameWithOwner,
      [`${kind}Number`]: Number(number)
    });
  }

  run("git", ["-C", context.repoRoot, "worktree", "prune"]);
  if (kind === "issue" && options.deleteBranch) {
    const branch = matches[0].branch?.replace("refs/heads/", "");
    if (branch) run("git", ["-C", context.repoRoot, "branch", "-d", branch]);
  }
  return { ok: true, removed };
}

async function status() {
  const context = repoContext();
  const root = resolve(worktreeRoot(), "github.com", context.nameWithOwner);
  const worktrees = worktreeEntries(context.repoRoot)
    .filter((entry) => entry.path.startsWith(root))
    .map((entry) => ({ ...entry, dirty: command("git", ["-C", entry.path, "status", "--porcelain"]).stdout.trim().length > 0 }));
  return { ok: true, repository: context.nameWithOwner, root, worktrees };
}

function repoContext() {
  const checkoutRoot = command("git", ["rev-parse", "--show-toplevel"]).stdout.trim();
  const commonDir = command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
  const repoRoot = basename(commonDir) === ".git" ? dirname(commonDir) : checkoutRoot;
  const gh = jsonCommand("gh", ["repo", "view", "--json", "name,nameWithOwner,defaultBranchRef"]);
  return {
    repoRoot,
    repoName: gh.name,
    nameWithOwner: gh.nameWithOwner,
    defaultBranch: gh.defaultBranchRef.name,
    remote: process.env.GITHUB_WORK_REMOTE || "origin"
  };
}

function prepareIssueHerdrRemoval(repoName, number, entries) {
  const nativeByPath = new Map();
  if (process.env.HERDR_ENV !== "1") return nativeByPath;

  const prefix = `${repoName} · #${number} ·`;
  const entryPaths = new Set(entries.map((entry) => resolve(entry.path)));
  const workspaces = herdrWorkspaces();
  const relevant = workspaces.filter((workspace) => {
    const checkoutPath = workspace.worktree?.checkout_path;
    return workspace.label?.startsWith(prefix)
      || (checkoutPath && entryPaths.has(resolve(checkoutPath)));
  });

  for (const workspace of relevant) {
    if (["working", "blocked"].includes(workspace.agent_status)) {
      throw new Error(`refusing to remove active Herdr workspace ${workspace.label} (${workspace.agent_status})`);
    }
    const worktree = workspace.worktree;
    const checkoutPath = worktree?.checkout_path;
    if (worktree?.is_linked_worktree && typeof checkoutPath === "string" && entryPaths.has(resolve(checkoutPath))) {
      const path = resolve(checkoutPath);
      if (nativeByPath.has(path)) throw new Error(`multiple Herdr workspaces represent issue worktree: ${path}`);
      nativeByPath.set(path, workspace.workspace_id);
    }
  }

  const nativeIds = new Set(nativeByPath.values());
  for (const workspace of relevant) {
    if (workspace.label?.startsWith(prefix) && !nativeIds.has(workspace.workspace_id)) {
      run("herdr", ["workspace", "close", workspace.workspace_id], { capture: true });
    }
  }
  return nativeByPath;
}

function closeHerdrWorkspaces(repoName, kind, number) {
  if (process.env.HERDR_ENV !== "1") return;
  const prefix = kind === "issue" ? `${repoName} · #${number} ·` : `${repoName} · PR #${number} ·`;
  while (true) {
    const match = herdrWorkspaces().find((workspace) => workspace.label.startsWith(prefix));
    if (!match) return;
    if (["working", "blocked"].includes(match.agent_status)) {
      throw new Error(`refusing to close active Herdr workspace ${match.label} (${match.agent_status})`);
    }
    run("herdr", ["workspace", "close", match.workspace_id], { capture: true });
  }
}

function herdrWorkspaces() {
  const listed = jsonCommand("herdr", ["workspace", "list"]);
  return listed.result?.workspaces ?? listed.workspaces ?? [];
}

function createOrOpenHerdrIssueWorktree({ repoRoot, path, branch, base, label, agent, prompt, launchEnvironment, existingWorktree }) {
  const args = existingWorktree
    ? ["worktree", "open", "--cwd", repoRoot, "--path", path, "--label", label, "--no-focus"]
    : ["worktree", "create", "--cwd", repoRoot, "--branch", branch, "--base", base, "--path", path, "--label", label, "--no-focus"];
  const response = nativeHerdrJson(args, existingWorktree ? "open" : "create");
  const result = response.result ?? response;
  const expectedType = existingWorktree ? "worktree_opened" : "worktree_created";
  const workspace = result.workspace;
  const pane = result.root_pane;
  const worktree = result.worktree;
  const workspaceId = workspace?.workspace_id;
  const paneId = pane?.pane_id;
  const responsePath = worktree?.path;
  const invalidOpenState = existingWorktree && typeof result.already_open !== "boolean";
  if (result.type !== expectedType || !workspaceId || !paneId || typeof responsePath !== "string"
    || resolve(responsePath) !== resolve(path) || worktree.is_linked_worktree !== true || invalidOpenState) {
    throw new Error(`Herdr returned an invalid native worktree ${existingWorktree ? "open" : "create"} response`);
  }

  const reusedWorkspace = existingWorktree && result.already_open === true;
  const createdWorkspace = !reusedWorkspace;
  const agentStarted = createdWorkspace && launchAgentInHerdrPane(paneId, agent, prompt, launchEnvironment);
  return {
    runtime: "herdr",
    herdrWorkspaceId: workspaceId,
    herdrPaneId: paneId,
    workspaceLabel: workspace.label ?? label,
    createdWorkspace,
    agentStarted,
    ...(reusedWorkspace ? { reusedWorkspace: true } : {})
  };
}

function verifyNativeHerdrWorktreeSupport(repoRoot) {
  const result = command("herdr", ["worktree", "list", "--cwd", repoRoot], { capture: true, allowFailure: true });
  if (result.status !== 0) {
    throw new Error("Herdr native worktree support is required for managed issue work. Install Herdr 0.7.3 or newer, then retry; no generic workspace fallback was used.");
  }
  try {
    const response = JSON.parse(result.stdout);
    const payload = response.result ?? response;
    if (payload.type !== "worktree_list" || !Array.isArray(payload.worktrees)) throw new Error("invalid response");
  } catch {
    throw new Error("Herdr native worktree support returned an incompatible response. Install a compatible Herdr version (0.7.3 or newer), then retry.");
  }
}

function nativeHerdrJson(args, operation) {
  const result = command("herdr", args, { capture: true, allowFailure: true });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`Herdr native worktree ${operation} failed. Ensure Herdr 0.7.3 or newer is installed and resolve the reported worktree state before retrying${detail ? `: ${detail}` : "."}`);
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Herdr native worktree ${operation} returned invalid JSON`); }
}

function launchAgentInHerdrPane(paneId, agent, prompt, launchEnvironment = {}) {
  if (!agent || agent === "none") return false;
  if (!AGENTS.has(agent)) throw new Error("--agent must be pi, claude, codex, or none");
  const environment = Object.entries(launchEnvironment)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const launch = `${environment ? `env ${environment} ` : ""}${managedAgentCommand(agent, prompt)}`;
  run("herdr", ["pane", "run", paneId, launch], { capture: true });
  return true;
}

function managedAgentCommand(agent, prompt) {
  switch (agent) {
    case "pi": return `pi ${shellQuote(prompt)}`;
    case "claude": return `claude --permission-mode bypassPermissions ${shellQuote(prompt)}`;
    case "codex": return `codex --full-auto ${shellQuote(prompt)}`;
    default: throw new Error("managed agent must be pi, claude, or codex");
  }
}

function createHerdrWorkspace(path, label, agent, prompt, labelPrefix = label, launchEnvironment = {}) {
  if (process.env.HERDR_ENV !== "1") {
    if (agent && agent !== "none") throw new Error("HERDR_ENV=1 is required to start an agent; pass --agent none to create only the worktree");
    return { runtime: "none", workspaceLabel: label, createdWorkspace: false, agentStarted: false };
  }

  const listed = jsonCommand("herdr", ["workspace", "list"]);
  const workspaces = listed.result?.workspaces ?? listed.workspaces ?? [];
  const existing = workspaces.find((workspace) => workspace.label === label || workspace.label.startsWith(labelPrefix));
  if (existing) {
    return {
      runtime: "herdr",
      herdrWorkspaceId: existing.workspace_id,
      workspaceLabel: existing.label,
      createdWorkspace: false,
      agentStarted: false,
      reusedWorkspace: true
    };
  }

  const created = jsonCommand("herdr", ["workspace", "create", "--cwd", path, "--label", label, "--no-focus"]);
  const workspace = created.result?.workspace ?? created.workspace;
  const pane = created.result?.root_pane ?? created.root_pane;
  const workspaceId = workspace?.workspace_id;
  const paneId = pane?.pane_id;
  if (!workspaceId || !paneId) throw new Error("herdr did not return workspace and pane IDs");

  const agentStarted = launchAgentInHerdrPane(paneId, agent, prompt, launchEnvironment);
  return {
    runtime: "herdr",
    herdrWorkspaceId: workspaceId,
    herdrPaneId: paneId,
    workspaceLabel: label,
    createdWorkspace: true,
    agentStarted
  };
}

async function emit(event, message, attributes) {
  const logPath = process.env.FLIGHTDECK_TELEMETRY_FILE;
  if (!logPath) return;
  const payload = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    service: "hub-agent",
    event,
    level: "info",
    message,
    resource: { serviceName: "hub-agent", serviceInstanceId: `github-work:${hostname()}`, hostName: hostname() },
    attributes: { ...attributes, eventId: randomUUID(), environmentType: "local", machineId: hostname() }
  };
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`warning: failed to emit ${event} telemetry: ${message}`);
  }
}

function worktreeEntries(repoRoot) {
  const text = command("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]).stdout;
  const entries = [];
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice(9), branch: null, head: null, detached: false };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7);
    else if (current && line === "detached") current.detached = true;
  }
  if (current) entries.push(current);
  return entries;
}

function branchExists(repoRoot, branch) {
  return command("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).status === 0;
}

function verifyTools(agent, requiresHerdr) {
  if (!AGENTS.has(agent)) throw new Error("agent must be pi, claude, codex, or none");
  if (requiresHerdr && process.env.HERDR_ENV !== "1") {
    throw new Error("HERDR_ENV=1 is required for managed agents; use start-issue --agent none to create a worktree without Herdr");
  }
  run("gh", ["auth", "status"], { capture: true });
  run("git", ["--version"], { capture: true });
  if (process.env.HERDR_ENV === "1") run("herdr", ["pane", "list"], { capture: true });
}

function allowedOptions(command) {
  switch (command) {
    case "start-issue": return new Map([["agent", "value"], ["branch", "value"], ["allow-closed", "boolean"]]);
    case "review-pr": return new Map([["reviewer", "value"], ["allow-closed", "boolean"]]);
    case "finish-issue": return new Map([["delete-branch", "boolean"]]);
    case "cleanup-pr":
    case "status":
    case "help":
    case undefined: return new Map();
    default: return new Map();
  }
}

function parseOptions(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--") || arg.includes("=")) throw new Error(`unexpected argument: ${arg}`);
    const rawKey = arg.slice(2);
    const kind = allowed.get(rawKey);
    if (!kind) throw new Error(`unknown option for this command: ${arg}`);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (kind === "boolean") options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      options[key] = value;
    }
  }
  return options;
}

export function flightdeckLaunchEnvironment(context) {
  const names = {
    workId: "FLIGHTDECK_WORK_ID",
    projectSlug: "FLIGHTDECK_PROJECT_SLUG",
    repoRoot: "FLIGHTDECK_REPO_ROOT",
    repository: "FLIGHTDECK_REPOSITORY",
    worktreePath: "FLIGHTDECK_WORKTREE_PATH",
    role: "FLIGHTDECK_ROLE",
    reviewer: "FLIGHTDECK_REVIEWER",
    runtime: "FLIGHTDECK_RUNTIME",
    workspaceLabel: "FLIGHTDECK_WORKSPACE_LABEL",
    branch: "FLIGHTDECK_BRANCH"
  };
  return Object.fromEntries(
    Object.entries(names)
      .map(([key, name]) => [name, context[key]])
      .filter(([, value]) => typeof value === "string" && value.length > 0)
  );
}

function worktreeRoot() {
  return process.env.GITHUB_WORKTREE_ROOT || join(homedir(), ".local", "share", "agent-worktrees");
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", stdio: options.capture ? "pipe" : ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`${program}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${program} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

function run(program, args, options) {
  return command(program, args, options);
}

function jsonCommand(program, args) {
  const result = command(program, args, { capture: true });
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${program} returned invalid JSON`); }
}

function slugify(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "work";
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireId(command, id) {
  if (!id || !/^\d+$/.test(id)) throw new Error(`${command} requires a numeric issue or PR number`);
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(code) {
  console.log(`github-work — isolated GitHub issue and PR work in Herdr\n\nUsage:\n  github-work start-issue <number> [--agent pi|claude|codex|none]\n  github-work review-pr <number> [--reviewer pi|claude|codex]\n  github-work status\n  github-work finish-issue <number> [--delete-branch]\n  github-work cleanup-pr <number>\n\nEnvironment:\n  GITHUB_WORKTREE_ROOT       default: ~/.local/share/agent-worktrees\n  GITHUB_WORK_REMOTE         default: origin\n  FLIGHTDECK_TELEMETRY_FILE  optional Flightdeck-compatible JSONL sink\n`);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
