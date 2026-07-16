import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { flightdeckLaunchEnvironment } from "./github-work.mjs";

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
    else if (commandArgs[0] === "branch") process.exit(0);
    else fail("unexpected git command: " + commandArgs.join(" "));
  }
} else if (program === "herdr") {
  if (args[0] === "pane" && args[1] === "list") json({ result: { panes: [] } });
  else if (args[0] === "pane" && args[1] === "run") process.exit(0);
  else if (args[0] === "worktree" && args[1] === "list") {
    if (state.unsupportedHerdr) fail("unknown command: worktree", 2);
    json({ result: { type: "worktree_list", source: {}, worktrees: [] } });
  } else if (args[0] === "worktree" && args[1] === "create") {
    json({ result: { type: "worktree_created", workspace: { workspace_id: "w-create", label: state.label }, root_pane: { pane_id: "p-create" }, worktree: { path: state.issuePath, is_linked_worktree: true } } });
  } else if (args[0] === "worktree" && args[1] === "open") {
    json({ result: { type: "worktree_opened", workspace: { workspace_id: "w-open", label: state.label }, root_pane: { pane_id: "p-open" }, worktree: { path: state.issuePath, is_linked_worktree: true }, already_open: state.alreadyOpen ?? true } });
  } else if (args[0] === "worktree" && args[1] === "remove") {
    json({ result: { type: "worktree_removed", workspace_id: args[3], path: state.issuePath, forced: false } });
  } else if (args[0] === "workspace" && args[1] === "list") {
    json({ result: { workspaces: state.workspaces ?? [] } });
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
    label: "repo · #10 · Native worktree",
    worktreePorcelain: `worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n\n`,
    ...overrides
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(logPath, "");
  return {
    issuePath,
    repoRoot,
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

function existingIssuePorcelain(repoRoot, issuePath) {
  return `worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${issuePath}\nHEAD def\nbranch refs/heads/issue/10-native-worktree\n\n`;
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
    "--path", fixture.issuePath, "--label", "repo · #10 · Native worktree", "--no-focus"
  ]);
  assert.ok(findCommand(log, "herdr", ["pane", "run", "p-create"]));
  assert.equal(log.some((entry) => entry.program === "git" && entry.args.includes("add")), false);

  const telemetry = (await readFile(fixture.telemetryPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(telemetry.map((event) => event.event), ["worktree.created", "agent.run.started"]);
  assert.equal("herdrWorkspaceId" in telemetry[0].attributes, false);
  assert.equal("herdrPaneId" in telemetry[0].attributes, false);
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
    label: "repo · #10 · Native worktree",
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
    label: "repo · #10 · Native worktree",
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
