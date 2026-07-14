import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
