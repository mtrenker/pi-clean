import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { flightdeckLaunchEnvironment } from "./github-work.mjs";
import { AGENT_PROFILE_IDS, AGENT_PROFILES, DELEGATION_BOUNDARY, launchCommand, profileIds } from "./agent-profiles.mjs";

const script = fileURLToPath(new URL("./github-work.mjs", import.meta.url));

function invoke(args, env = process.env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env
  });
}

test("help succeeds without external tools", () => {
  const result = invoke(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /start-issue/);
});

test("unknown options are rejected before command execution", () => {
  const result = invoke(["start-issue", "123", "--agnt", "none"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option/);
});

test("managed agents require Herdr before GitHub or Git mutations", () => {
  const env = { ...process.env };
  delete env.HERDR_ENV;
  const result = invoke(["start-issue", "123", "--agent", "pi"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HERDR_ENV=1 is required/);
});

test("commands without options reject trailing arguments", () => {
  const result = invoke(["status", "--bad"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option/);
});

test("Flightdeck launch context exports only the explicit stable allowlist", () => {
  assert.deepEqual(flightdeckLaunchEnvironment({
    workId: "github:owner/repo:issue:4",
    projectSlug: "repo",
    repository: "owner/repo",
    role: "author",
    workspaceLabel: "repo · #4 · telemetry",
    secret: "must-not-be-exported",
  }), {
    FLIGHTDECK_WORK_ID: "github:owner/repo:issue:4",
    FLIGHTDECK_PROJECT_SLUG: "repo",
    FLIGHTDECK_REPOSITORY: "owner/repo",
    FLIGHTDECK_ROLE: "author",
    FLIGHTDECK_WORKSPACE_LABEL: "repo · #4 · telemetry",
  });
});

const mockCli = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const program = basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.MOCK_GITHUB_WORK_STATE;
const logPath = process.env.MOCK_GITHUB_WORK_LOG;
const state = JSON.parse(readFileSync(statePath, "utf8"));
appendFileSync(logPath, JSON.stringify({ program, args }) + "\\n");
const json = (value) => process.stdout.write(JSON.stringify(value));
const fail = (message, status = 1) => { process.stderr.write(message); process.exit(status); };

if (program === "gh") {
  if (args[0] === "auth") process.exit(0);
  if (args[0] === "repo") json({ name: "repo", nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } });
  else if (args[0] === "issue") json({ number: 10, title: "Native worktree", state: "OPEN", url: "https://example.test/10" });
  else if (args[0] === "pr") json({ number: 20, title: "Review profiles", state: "OPEN", url: "https://example.test/20", headRefName: "feature/review-profiles", baseRefName: "main" });
  else fail("unexpected gh command");
} else if (program === "git") {
  if (args[0] === "--version") process.exit(0);
  if (args[0] === "rev-parse") {
    const value = args.includes("--git-common-dir") ? state.repoRoot + "/.git" : (state.currentRoot ?? state.repoRoot);
    process.stdout.write(value + "\\n");
  }
  else {
    const commandArgs = args[0] === "-C" ? args.slice(2) : args;
    if (commandArgs[0] === "fetch") process.exit(0);
    if (commandArgs[0] === "worktree" && commandArgs[1] === "list") process.stdout.write(state.worktreePorcelain ?? "");
    else if (commandArgs[0] === "worktree") process.exit(0);
    else if (commandArgs[0] === "show-ref") process.exit(state.branchExists ? 0 : 1);
    else if (commandArgs[0] === "status") process.stdout.write(state.dirty ?? "");
    else if (commandArgs[0] === "checkout") process.exit(0);
    else if (commandArgs[0] === "branch") process.exit(0);
    else fail("unexpected git command: " + commandArgs.join(" "));
  }
} else if (program === "herdr") {
  if (args[0] === "pane" && args[1] === "list") json({ result: { panes: state.panes ?? [] } });
  else if (args[0] === "pane" && args[1] === "current") json({ result: { pane: state.currentPane ?? null } });
  else if (args[0] === "pane" && args[1] === "run") process.exit(0);
  else if (args[0] === "pane" && args[1] === "close") process.exit(0);
  else if (args[0] === "tab" && args[1] === "list") json({ result: { tabs: state.tabs ?? [] } });
  else if (args[0] === "tab" && args[1] === "create") {
    json({ result: { tab: { tab_id: "t-review" }, root_pane: { pane_id: "p-review", tab_id: "t-review" } } });
  }
  else if (args[0] === "tab" && args[1] === "close") process.exit(0);
  else if (args[0] === "tab" && args[1] === "rename") process.exit(0);
  else if (args[0] === "worktree" && args[1] === "list") {
    if (state.unsupportedHerdr) fail("unknown command: worktree", 2);
    json({ result: { type: "worktree_list", source: {}, worktrees: [] } });
  } else if (args[0] === "worktree" && args[1] === "create") {
    json({ result: { type: "worktree_created", workspace: { workspace_id: "w-create", label: state.label }, root_pane: { pane_id: "p-create", tab_id: "t-author" }, worktree: { path: state.issuePath, is_linked_worktree: true } } });
  } else if (args[0] === "worktree" && args[1] === "open") {
    json({ result: { type: "worktree_opened", workspace: { workspace_id: "w-open", label: state.label }, root_pane: { pane_id: "p-open", tab_id: "t-author" }, worktree: { path: state.issuePath, is_linked_worktree: true }, already_open: state.alreadyOpen ?? true } });
  } else if (args[0] === "worktree" && args[1] === "remove") {
    json({ result: { type: "worktree_removed", workspace_id: args[3], path: state.issuePath, forced: false } });
  } else if (args[0] === "workspace" && args[1] === "list") {
    json({ result: { workspaces: state.workspaces ?? [] } });
  } else if (args[0] === "workspace" && args[1] === "create") {
    fail("the helper must never create a Herdr workspace");
  } else if (args[0] === "workspace" && args[1] === "close") {
    state.workspaces = (state.workspaces ?? []).filter((workspace) => workspace.workspace_id !== args[2]);
    writeFileSync(statePath, JSON.stringify(state));
  } else fail("unexpected herdr command: " + args.join(" "));
} else fail("unexpected mock executable: " + program);
`;

async function mockEnvironment(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "github-work-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const repoRoot = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const issuePath = join(worktreeRoot, "github.com", "owner", "repo", "issues", "10-native-worktree");
  await mkdir(bin, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
  for (const program of ["gh", "git", "herdr"]) {
    const path = join(bin, program);
    await writeFile(path, mockCli);
    await chmod(path, 0o755);
  }
  const statePath = join(root, "state.json");
  const logPath = join(root, "commands.jsonl");
  const telemetryPath = join(root, "telemetry.jsonl");
  const state = {
    repoRoot,
    issuePath,
    label: "#10 · Native worktree",
    worktreePorcelain: `worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n\n`,
    ...overrides
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(logPath, "");
  return {
    issuePath,
    repoRoot,
    worktreeRoot,
    statePath,
    logPath,
    telemetryPath,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_WORKTREE_ROOT: worktreeRoot,
      MOCK_GITHUB_WORK_STATE: statePath,
      MOCK_GITHUB_WORK_LOG: logPath,
      FLIGHTDECK_TELEMETRY_FILE: telemetryPath
    }
  };
}

async function commandLog(path) {
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function findCommand(log, program, prefix) {
  return log.find((entry) => entry.program === program && prefix.every((value, index) => entry.args[index] === value));
}

function launchedAgentCommand(entry) {
  return entry.args[3].replace(/^env (?:[A-Z_]+='[^']*' )+/, "");
}

function existingIssuePorcelain(repoRoot, issuePath) {
  return `worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${issuePath}\nHEAD def\nbranch refs/heads/issue/10-native-worktree\n\n`;
}

async function patchState(fixture, mutate) {
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  mutate(state);
  await writeFile(fixture.statePath, JSON.stringify(state));
}

test("managed start creates a native Herdr issue worktree and launches in its root pane", async (t) => {
  const fixture = await mockEnvironment(t);
  const result = invoke(["start-issue", "10", "--agent", "pi"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.herdrWorkspaceId, "w-create");
  assert.equal(output.herdrPaneId, "p-create");
  assert.equal(output.createdWorktree, true);
  assert.equal(output.agentStarted, true);

  const log = await commandLog(fixture.logPath);
  const create = findCommand(log, "herdr", ["worktree", "create"]);
  assert.deepEqual(create.args, [
    "worktree", "create", "--cwd", fixture.repoRoot,
    "--branch", "issue/10-native-worktree", "--base", "origin/main",
    "--path", fixture.issuePath, "--label", "#10 · Native worktree", "--no-focus"
  ]);
  const launch = findCommand(log, "herdr", ["pane", "run", "p-create"]);
  assert.ok(launch);
  assert.match(launchedAgentCommand(launch), /required Claude Opus 5\.5 handoff/);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("add")), false);

  const telemetry = (await readFile(fixture.telemetryPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(telemetry.map((event) => event.event), ["worktree.created", "agent.run.started"]);
  assert.equal("herdrWorkspaceId" in telemetry[0].attributes, false);
  assert.equal("herdrPaneId" in telemetry[0].attributes, false);
});

const ISSUE_TASK = "Work on GitHub issue #10 in owner/repo. Read the repository instructions and issue,"
  + " implement it in this worktree, validate the changes, and prepare a pull request. Do not merge."
  + " Follow the repository's checkpoint and preview contract: pause at a consequential or unspecified"
  + " UI/UX decision and bring a running preview you opened yourself, and change nothing that alters it"
  + " while you wait. Accepting a design lets you keep implementing in that direction; it is not"
  + " authorization to push, open or publish a pull request, or merge, and it never overrides a"
  + " repository rule that requires approval before committing. Preparing a pull request means showing"
  + " its title, body, base, and head.";
const OPUS_DESIGN_SUFFIX = " As Claude Opus 5.5, own and document any unresolved product, UX, interaction,"
  + " visual, architecture, API, or data-model design before implementing it.";
const WORKER_DESIGN_SUFFIX = " Do not originate or materially change unresolved product, UX, interaction,"
  + " visual, architecture, API, or data-model design. If such design is required and is not already"
  + " approved, stop and report the required Claude Opus 5.5 handoff.";

for (const [agent, profile, designSuffix] of [
  ["claude", "claude-opus", OPUS_DESIGN_SUFFIX],
  ["codex", "codex-sol-write", WORKER_DESIGN_SUFFIX],
]) {
  const expectedLaunch = launchCommand({ profile, prompt: `${ISSUE_TASK}${designSuffix}` });
  test(`managed ${agent} issue authors use the exact non-prompting profile`, async (t) => {
    const fixture = await mockEnvironment(t);
    const result = invoke(["start-issue", "10", "--agent", agent], { ...fixture.env, HERDR_ENV: "1" });
    assert.equal(result.status, 0, result.stderr);

    const log = await commandLog(fixture.logPath);
    const launch = findCommand(log, "herdr", ["pane", "run", "p-create"]);
    assert.ok(launch, "expected the author agent to launch in the worktree root pane");
    const command = launchedAgentCommand(launch);
    assert.equal(command, expectedLaunch);
    assert.match(command, /pause at a consequential or unspecified UI\/UX decision/);
    assert.match(command, /bring a running preview you opened yourself/);
    assert.match(command, /not authorization to push, open or publish a pull request, or merge/);
    assert.match(command, /never overrides a repository rule that requires approval before committing/);
    if (agent === "codex") assert.doesNotMatch(launch.args[3], /danger-full-access/);
  });
}

const REVIEW_PATH_SUFFIX = ["github.com", "owner", "repo", "prs", "20", "review-claude"];

function reviewPath(fixture) {
  return join(fixture.worktreeRoot, ...REVIEW_PATH_SUFFIX);
}

function repoWorkspace(overrides = {}) {
  return {
    workspace_id: "w-primary",
    label: "repo",
    agent_status: "idle",
    worktree: { checkout_path: "/repo", repo_root: "/repo", is_linked_worktree: false },
    ...overrides
  };
}

for (const [reviewer, expectedProfile, designMarker] of [
  [
    "claude",
    "claude --model claude-opus-5-5 --effort high --disallowed-tools Agent,Workflow --permission-mode bypassPermissions -- ",
    /As Claude Opus 5\.5, evaluate any new or materially changed/,
  ],
  [
    "codex",
    "codex --model gpt-6-sol -c 'model_reasoning_effort=\"high\"' --disable multi_agent --ask-for-approval never --sandbox workspace-write -- ",
    /flag those for Claude Opus 5\.5/,
  ],
]) {
  test(`managed ${reviewer} PR reviewers use the exact non-prompting profile and maintainability contract`, async (t) => {
    const fixture = await mockEnvironment(t);
    await patchState(fixture, (state) => {
      state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
    });
    const result = invoke(["review-pr", "20", "--reviewer", reviewer], { ...fixture.env, HERDR_ENV: "1" });
    assert.equal(result.status, 0, result.stderr);

    const log = await commandLog(fixture.logPath);
    const launch = findCommand(log, "herdr", ["pane", "run", "p-review"]);
    assert.ok(launch, "expected the reviewer agent to launch in its review tab");
    const command = launchedAgentCommand(launch);
    assert.ok(command.startsWith(expectedProfile), `expected launch profile ${expectedProfile}`);
    assert.match(command, /maintainability against the supported contract/);
    assert.match(command, /A blocker needs a concrete failure path in a supported environment/);
    assert.match(command, /Martin is one developer responsible for many projects/);
    assert.match(command, /reasoning that exists only in an agent transcript/);
    assert.match(command, /review the diff of that layer against its own base branch/);
    assert.match(command, designMarker);
    if (reviewer === "codex") {
      assert.doesNotMatch(command, /--full-auto/);
      assert.doesNotMatch(command, /danger-full-access/);
    }
  });
}

test("review-pr opens a compact review tab in the primary workspace and never creates one", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
  });

  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.herdrWorkspaceId, "w-primary");
  assert.equal(output.herdrTabId, "t-review");
  assert.equal(output.herdrPaneId, "p-review");
  assert.equal(output.herdrTabLabel, "PR #20 · Review");
  assert.equal(output.createdTab, true);
  assert.equal(output.createdWorkspace, false);
  assert.equal(output.worktreePath, reviewPath(fixture));

  const log = await commandLog(fixture.logPath);
  const create = findCommand(log, "herdr", ["tab", "create"]);
  assert.deepEqual(create.args, [
    "tab", "create", "--workspace", "w-primary", "--cwd", reviewPath(fixture),
    "--label", "PR #20 · Review", "--no-focus"
  ]);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "workspace" && entry.args[1] === "create"), false);
});

test("review-pr hosts the review in the caller's issue workspace", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.workspaces = [
      repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } }),
      {
        workspace_id: "w-issue",
        label: "#10 · Native worktree",
        agent_status: "idle",
        worktree: { checkout_path: fixture.issuePath, repo_root: fixture.repoRoot, is_linked_worktree: true }
      }
    ];
    state.currentPane = { pane_id: "p-author", workspace_id: "w-issue", tab_id: "w-issue:t1", cwd: fixture.issuePath };
    state.panes = [state.currentPane];
  });

  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).herdrWorkspaceId, "w-issue");
  const log = await commandLog(fixture.logPath);
  assert.deepEqual(findCommand(log, "herdr", ["tab", "create"]).args.slice(0, 4), ["tab", "create", "--workspace", "w-issue"]);
});

test("review-pr reuses a review that was moved, without creating a second one", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = `worktree ${fixture.repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${reviewPath(fixture)}\nHEAD def\ndetached\n\n`;
    state.workspaces = [{
      workspace_id: "w-issue",
      label: "#10 · Native worktree",
      agent_status: "idle",
      worktree: { checkout_path: fixture.issuePath, repo_root: fixture.repoRoot, is_linked_worktree: true }
    }];
    state.panes = [
      { pane_id: "p-author", workspace_id: "w-issue", tab_id: "w-issue:t1", cwd: fixture.issuePath, agent_status: "idle" },
      { pane_id: "p-moved", workspace_id: "w-issue", tab_id: "w-issue:t2", cwd: reviewPath(fixture), agent_status: "idle" }
    ];
  });

  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.reusedPlacement, true);
  assert.equal(output.herdrPaneId, "p-moved");
  assert.equal(output.herdrWorkspaceId, "w-issue");
  assert.equal(output.createdTab, false);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "tab" && entry.args[1] === "create"), false);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "run"), false);
});

test("review-pr refuses to refresh a review whose agent is still working, before touching git", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
    state.panes = [{ pane_id: "p-busy", workspace_id: "w-primary", tab_id: "w-primary:t2", cwd: reviewPath(fixture), agent_status: "working" }];
  });

  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to refresh review worktree while its agent is working/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("fetch")), false);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("checkout")), false);
});

test("review-pr names the reviewer only when another reviewer is already placed", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
    state.panes = [{
      pane_id: "p-codex",
      workspace_id: "w-primary",
      tab_id: "w-primary:t2",
      cwd: join(fixture.worktreeRoot, "github.com", "owner", "repo", "prs", "20", "review-codex"),
      agent_status: "idle"
    }];
  });

  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).herdrTabLabel, "PR #20 · Review (claude)");
});

test("review-pr refuses a dirty review worktree before refreshing it", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = `worktree ${fixture.repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${reviewPath(fixture)}\nHEAD def\ndetached\n\n`;
    state.dirty = " M file.txt\n";
    state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
  });

  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to refresh dirty review worktree/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("checkout")), false);
});

test("review-pr fails with the candidates when no host can be chosen", async (t) => {
  const fixture = await mockEnvironment(t, { workspaces: [] });
  const result = invoke(["review-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Herdr workspace belongs to/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "tab" && entry.args[1] === "create"), false);
});

test("review-pr rejects an explicit workspace from another repository", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.workspaces = [
      repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } }),
      { workspace_id: "w-other", label: "other", agent_status: "idle", worktree: { checkout_path: "/elsewhere", repo_root: "/elsewhere", is_linked_worktree: false } }
    ];
  });

  const result = invoke(["review-pr", "20", "--workspace", "w-other"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not belong to/);
});

test("cleanup-pr closes the review tab and leaves its host and neighbours alone", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = `worktree ${fixture.repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${reviewPath(fixture)}\nHEAD def\ndetached\n\n`;
    state.workspaces = [{
      workspace_id: "w-issue",
      label: "#10 · Native worktree",
      agent_status: "idle",
      worktree: { checkout_path: fixture.issuePath, repo_root: fixture.repoRoot, is_linked_worktree: true }
    }];
    state.panes = [
      { pane_id: "p-author", workspace_id: "w-issue", tab_id: "w-issue:t1", cwd: fixture.issuePath, agent_status: "idle" },
      { pane_id: "p-review", workspace_id: "w-issue", tab_id: "w-issue:t2", cwd: reviewPath(fixture), agent_status: "idle" }
    ];
  });

  const result = invoke(["cleanup-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  assert.ok(findCommand(log, "herdr", ["tab", "close", "w-issue:t2"]));
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "workspace" && entry.args[1] === "close"), false);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "tab" && entry.args[2] === "w-issue:t1"), false);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "pane" && entry.args[1] === "close"), false);
});

test("cleanup-pr closes only the review pane when its tab holds other work", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = `worktree ${fixture.repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${reviewPath(fixture)}\nHEAD def\ndetached\n\n`;
    state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
    state.panes = [
      { pane_id: "p-preview", workspace_id: "w-primary", tab_id: "w-primary:t2", cwd: fixture.repoRoot, agent_status: "idle" },
      { pane_id: "p-review", workspace_id: "w-primary", tab_id: "w-primary:t2", cwd: reviewPath(fixture), agent_status: "idle" }
    ];
  });

  const result = invoke(["cleanup-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  assert.ok(findCommand(log, "herdr", ["pane", "close", "p-review"]));
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "tab" && entry.args[1] === "close"), false);
});

test("cleanup-pr refuses while the review agent is working", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = `worktree ${fixture.repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${reviewPath(fixture)}\nHEAD def\ndetached\n\n`;
    state.workspaces = [repoWorkspace({ worktree: { checkout_path: fixture.repoRoot, repo_root: fixture.repoRoot, is_linked_worktree: false } })];
    state.panes = [{ pane_id: "p-review", workspace_id: "w-primary", tab_id: "w-primary:t2", cwd: reviewPath(fixture), agent_status: "working" }];
  });

  const result = invoke(["cleanup-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to close review pane p-review while its agent is working/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("remove")), false);
});

test("cleanup-pr closes a dedicated review workspace from before reviews moved into tabs", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = `worktree ${fixture.repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${reviewPath(fixture)}\nHEAD def\ndetached\n\n`;
    state.workspaces = [{
      workspace_id: "w-legacy-review",
      label: "repo · PR #20 · review/claude",
      agent_status: "idle",
      worktree: { checkout_path: reviewPath(fixture), repo_root: fixture.repoRoot, is_linked_worktree: true }
    }];
    state.panes = [{ pane_id: "p-legacy", workspace_id: "w-legacy-review", tab_id: "w-legacy-review:t1", cwd: reviewPath(fixture), agent_status: "idle" }];
  });

  const result = invoke(["cleanup-pr", "20"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  assert.ok(findCommand(log, "herdr", ["workspace", "close", "w-legacy-review"]));
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[0] === "tab" && entry.args[1] === "close"), false);
});

test("finish-issue refuses to strand a review hosted in the issue workspace", async (t) => {
  const fixture = await mockEnvironment(t);
  await patchState(fixture, (state) => {
    state.worktreePorcelain = existingIssuePorcelain(fixture.repoRoot, fixture.issuePath);
    state.workspaces = [{
      workspace_id: "w-issue",
      label: "#10 · Native worktree",
      agent_status: "idle",
      worktree: { checkout_path: fixture.issuePath, repo_root: fixture.repoRoot, is_linked_worktree: true }
    }];
    state.panes = [
      { pane_id: "p-author", workspace_id: "w-issue", tab_id: "w-issue:t1", cwd: fixture.issuePath, agent_status: "idle" },
      { pane_id: "p-review", workspace_id: "w-issue", tab_id: "w-issue:t2", cwd: reviewPath(fixture), agent_status: "idle" }
    ];
  });

  const result = invoke(["finish-issue", "10"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hosts review checkout .*review-claude in pane p-review/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "remove"), false);
});

test("managed start opens and reuses an existing issue worktree", async (t) => {
  const fixture = await mockEnvironment(t);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.worktreePorcelain = existingIssuePorcelain(fixture.repoRoot, fixture.issuePath);
  state.currentRoot = fixture.issuePath;
  state.alreadyOpen = true;
  await writeFile(fixture.statePath, JSON.stringify(state));

  const result = invoke(["start-issue", "10", "--agent", "pi"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.createdWorktree, false);
  assert.equal(output.reusedWorkspace, true);
  assert.equal(output.agentStarted, false);

  const log = await commandLog(fixture.logPath);
  assert.ok(findCommand(log, "herdr", ["worktree", "open", "--cwd", fixture.repoRoot, "--path", fixture.issuePath]));
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "create"), false);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "run"), false);
});

test("finish-issue removes a linked issue workspace through Herdr without force", async (t) => {
  const fixture = await mockEnvironment(t);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.worktreePorcelain = existingIssuePorcelain(fixture.repoRoot, fixture.issuePath);
  state.workspaces = [{
    workspace_id: "w-linked",
    label: "#10 · Native worktree",
    agent_status: "idle",
    worktree: { checkout_path: fixture.issuePath, is_linked_worktree: true }
  }];
  await writeFile(fixture.statePath, JSON.stringify(state));

  const result = invoke(["finish-issue", "10", "--delete-branch"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  const remove = findCommand(log, "herdr", ["worktree", "remove"]);
  assert.deepEqual(remove.args, ["worktree", "remove", "--workspace", "w-linked"]);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("remove")), false);
  assert.ok(log.some((entry) => entry.program === "git" && entry.args.includes("-d") && entry.args.includes("issue/10-native-worktree")));
});

test("finish-issue safely falls back for a legacy generic Herdr workspace", async (t) => {
  const fixture = await mockEnvironment(t);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.worktreePorcelain = existingIssuePorcelain(fixture.repoRoot, fixture.issuePath);
  state.workspaces = [{
    workspace_id: "w-legacy",
    label: "repo · #10 · Native worktree",
    agent_status: "idle"
  }];
  state.panes = [{ pane_id: "p-legacy", workspace_id: "w-legacy", tab_id: "w-legacy:t1", cwd: fixture.issuePath, agent_status: "idle" }];
  await writeFile(fixture.statePath, JSON.stringify(state));

  const result = invoke(["finish-issue", "10"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  assert.ok(findCommand(log, "herdr", ["workspace", "close", "w-legacy"]));
  assert.ok(log.some((entry) => entry.program === "git" && entry.args.includes("remove") && entry.args.includes(fixture.issuePath)));
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "remove"), false);
});

test("finish-issue refuses an active linked Herdr workspace", async (t) => {
  const fixture = await mockEnvironment(t);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.worktreePorcelain = existingIssuePorcelain(fixture.repoRoot, fixture.issuePath);
  state.workspaces = [{
    workspace_id: "w-linked",
    label: "#10 · Native worktree",
    agent_status: "working",
    worktree: { checkout_path: fixture.issuePath, is_linked_worktree: true }
  }];
  await writeFile(fixture.statePath, JSON.stringify(state));

  const result = invoke(["finish-issue", "10"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to remove active Herdr workspace/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "remove"), false);
});

test("managed start fails before fetch when native Herdr worktrees are unsupported", async (t) => {
  const fixture = await mockEnvironment(t, { unsupportedHerdr: true });
  const result = invoke(["start-issue", "10", "--agent", "none"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Herdr native worktree support is required/);
  const log = await commandLog(fixture.logPath);
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("fetch")), false);
  assert.equal(log.some((entry) => entry.program === "herdr" && entry.args[1] === "workspace"), false);
});

test("non-Herdr finish retains the direct Git cleanup path", async (t) => {
  const fixture = await mockEnvironment(t);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.worktreePorcelain = existingIssuePorcelain(fixture.repoRoot, fixture.issuePath);
  await writeFile(fixture.statePath, JSON.stringify(state));
  const env = { ...fixture.env };
  delete env.HERDR_ENV;

  const result = invoke(["finish-issue", "10"], env);
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  assert.ok(log.some((entry) => entry.program === "git" && entry.args.includes("remove") && entry.args.includes(fixture.issuePath)));
  assert.equal(log.some((entry) => entry.program === "herdr"), false);
});

test("non-Herdr start with agent none retains the direct Git path", async (t) => {
  const fixture = await mockEnvironment(t);
  const env = { ...fixture.env };
  delete env.HERDR_ENV;
  const result = invoke(["start-issue", "10", "--agent", "none"], env);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.runtime, "none");
  const log = await commandLog(fixture.logPath);
  assert.ok(log.some((entry) => entry.program === "git" && entry.args.includes("worktree") && entry.args.includes("add")));
  assert.equal(log.some((entry) => entry.program === "herdr"), false);
});

test("start-issue defaults to the pinned Opus profile instead of an ambient agent", async (t) => {
  const fixture = await mockEnvironment(t);
  const result = invoke(["start-issue", "10"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agent, "claude");

  const log = await commandLog(fixture.logPath);
  const launch = findCommand(log, "herdr", ["pane", "run", "p-create"]);
  assert.equal(launchedAgentCommand(launch), launchCommand({
    profile: "claude-opus",
    prompt: `${ISSUE_TASK}${OPUS_DESIGN_SUFFIX}`
  }));
});

test("launch-command prints the same string the helper launches", async (t) => {
  const fixture = await mockEnvironment(t);
  const result = invoke(["start-issue", "10", "--agent", "codex"], { ...fixture.env, HERDR_ENV: "1" });
  assert.equal(result.status, 0, result.stderr);
  const log = await commandLog(fixture.logPath);
  const launched = launchedAgentCommand(findCommand(log, "herdr", ["pane", "run", "p-create"]));
  const prompt = `${ISSUE_TASK}${WORKER_DESIGN_SUFFIX}`;

  const printed = invoke(["launch-command", "--profile", "codex-sol-write", "--prompt", prompt]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), launched);
});

const DELEGATION_CONTROLS = { claude: "--disallowed-tools Agent,Workflow", codex: "--disable multi_agent" };

test("rendered commands match the reported profile metadata at every supported effort", () => {
  for (const id of profileIds()) {
    const profile = AGENT_PROFILES[id];
    const efforts = profile.efforts.length > 0 ? profile.efforts : [undefined];
    for (const effort of efforts) {
      const command = launchCommand({ profile: id, effort, prompt: "task" });
      const where = `${id} at ${effort}`;
      const control = DELEGATION_CONTROLS[profile.program];
      if (profile.nativeDelegation === "disabled") {
        assert.ok(control, `${id} claims a disabled control its program cannot render`);
        assert.ok(command.includes(control), where);
      } else if (control) {
        assert.equal(command.includes(control), false, `${where} renders a control its metadata does not claim`);
      }
      if (profile.execution !== "ambient") assert.ok(command.includes(profile.execution), where);
      if (effort) assert.match(command, new RegExp(`(--effort ${effort}\\b|model_reasoning_effort="${effort}")`));
      assert.ok(command.includes(DELEGATION_BOUNDARY), `${where} omits the delegation boundary`);
    }
  }
});

test("a prompt that starts with a dash reaches the agent as a prompt", () => {
  for (const id of profileIds()) {
    const command = launchCommand({ profile: id, prompt: "-h" });
    assert.match(command, / -- '-h /, id);
  }
});

test("no profile uses a removed flag, a host-wide sandbox escape, or a floating model alias", () => {
  for (const id of profileIds()) {
    const command = launchCommand({ profile: id, prompt: "task" });
    assert.doesNotMatch(command, /--full-auto/, id);
    assert.doesNotMatch(command, /danger-full-access|--dangerously-bypass-approvals-and-sandbox/, id);
    assert.doesNotMatch(command, /--model (fable|opus|sonnet)\b/, id);
  }
});

test("unsupported launch settings fail visibly and name the supported values", () => {
  const unknownProfile = invoke(["launch-command", "--profile", "claude-astra", "--prompt", "task"]);
  assert.equal(unknownProfile.status, 1);
  assert.match(unknownProfile.stderr, /unknown launch profile: claude-astra; supported: claude-opus/);

  const unknownEffort = invoke(["launch-command", "--profile", "claude-opus", "--effort", "ultra", "--prompt", "task"]);
  assert.equal(unknownEffort.status, 1);
  assert.match(unknownEffort.stderr, /unsupported effort ultra for profile claude-opus; supported: low, medium, high, xhigh, max/);

  const missingPrompt = invoke(["launch-command", "--profile", "claude-opus"]);
  assert.equal(missingPrompt.status, 1);
  assert.match(missingPrompt.stderr, /--prompt is required/);

  const unknownAgent = invoke(["start-issue", "10", "--agent", "fable"], { ...process.env, HERDR_ENV: "1" });
  assert.equal(unknownAgent.status, 1);
  assert.match(unknownAgent.stderr, /agent must be pi, claude, codex, or none/);
});

test("profiles reports the pinned models, defaults, and verified CLI versions", () => {
  const result = invoke(["profiles"]);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.equal(listed.defaults.issueAgent, "claude");
  assert.equal(listed.defaults.reviewer, "claude");
  const model = (id) => listed.profiles.find((profile) => profile.id === id).model;
  assert.equal(model("claude-opus"), "claude-opus-5-5");
  assert.equal(model("claude-fable"), "claude-fable-5-1");
  assert.equal(model("codex-sol-write"), "gpt-6-sol");
  assert.equal(model("codex-sol-read"), "gpt-6-sol");
  assert.equal(model("codex-astra-write"), "gpt-6-astra");
  assert.equal(listed.profiles.find((profile) => profile.id === "pi-ambient").nativeDelegation, "uncontrolled");
  assert.equal(listed.verifiedClis.claude, "2.1.266");
});

// Astra is the opt-in frontier escalation. Reaching it must stay a typed choice: no agent name
// resolves to it, and its default effort follows OpenAI's Astra starting effort rather than Sol's.
test("the Astra profile is opt-in, not routed, and renders the frontier model", () => {
  assert.equal(Object.values(AGENT_PROFILE_IDS).includes("codex-astra-write"), false);
  assert.equal(AGENT_PROFILES["codex-astra-write"].defaultEffort, "medium");

  const printed = invoke(["launch-command", "--profile", "codex-astra-write", "--prompt", "escalated task"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(
    printed.stdout.trim(),
    `codex --model gpt-6-astra -c 'model_reasoning_effort="medium"' --disable multi_agent`
      + ` --ask-for-approval never --sandbox workspace-write -- 'escalated task ${DELEGATION_BOUNDARY}'`
  );

  const raised = invoke(["launch-command", "--profile", "codex-astra-write", "--effort", "max", "--prompt", "task"]);
  assert.equal(raised.status, 0, raised.stderr);
  assert.match(raised.stdout, /model_reasoning_effort="max"/);

  const unsupported = invoke(["launch-command", "--profile", "codex-astra-write", "--effort", "light", "--prompt", "task"]);
  assert.equal(unsupported.status, 1);
  assert.match(
    unsupported.stderr,
    /unsupported effort light for profile codex-astra-write; supported: low, medium, high, xhigh, max, ultra/
  );

  const unknownAgent = invoke(["start-issue", "10", "--agent", "astra"], { ...process.env, HERDR_ENV: "1" });
  assert.equal(unknownAgent.status, 1);
  assert.match(unknownAgent.stderr, /agent must be pi, claude, codex, or none/);
});

test("generated commands parse into the intended argv under a real shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "github-work-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const argvPath = join(root, "argv.json");
  for (const program of ["claude", "codex", "pi"]) {
    const path = join(bin, program);
    await writeFile(path, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(path, 0o755);
  }

  const prompt = "-h Review only: PR #42's diff. Don't merge.";
  const task = `${prompt} ${DELEGATION_BOUNDARY}`;
  const expected = {
    "claude-opus": ["--model", "claude-opus-5-5", "--effort", "high", "--disallowed-tools", "Agent,Workflow",
      "--permission-mode", "bypassPermissions", "--", task],
    "codex-sol-read": ["--model", "gpt-6-sol", "-c", 'model_reasoning_effort="medium"', "--disable", "multi_agent",
      "--ask-for-approval", "never", "--sandbox", "read-only", "--", task],
    "codex-astra-write": ["--model", "gpt-6-astra", "-c", 'model_reasoning_effort="medium"', "--disable", "multi_agent",
      "--ask-for-approval", "never", "--sandbox", "workspace-write", "--", task],
    "pi-ambient": ["--", task]
  };

  for (const [profile, argv] of Object.entries(expected)) {
    const command = launchCommand({ profile, prompt });
    const run = spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(await readFile(argvPath, "utf8")), argv, profile);
  }
});
