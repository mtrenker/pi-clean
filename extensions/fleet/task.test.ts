import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskFolder } from "./task.ts";

test("createTaskFolder writes task.md with explicit task-local progress and output paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });

    await createTaskFolder(root, {
      id: "001",
      slug: "audit-widget",
      name: "Audit widget",
      engine: "claude",
      model: "sonnet",
      profile: "deep",
      agent: "scout",
      depends: [],
      description: "Read `extensions/fleet/widget.ts` and verify the current rendering behavior. Acceptance: write findings and confirm the exact files involved.",
    });

    const taskMd = await readFile(join(root, ".pi", "tasks", "001-audit-widget", "task.md"), "utf-8");

    assert.match(taskMd, /Your task instructions are in `\.pi\/tasks\/001-audit-widget\/task\.md`\./);
    assert.match(taskMd, /Write progress updates only to `\.pi\/tasks\/001-audit-widget\/progress\.jsonl`/);
    assert.match(taskMd, /Raw engine output is captured separately in `\.pi\/tasks\/001-audit-widget\/output\.jsonl`\./);
    assert.match(taskMd, /never create or append to a repo-root `progress\.jsonl`/);
    assert.match(taskMd, /This task has no upstream task dependencies\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createTaskFolder writes explicit upstream handoff references for dependent tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-task-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });

    await createTaskFolder(root, {
      id: "001",
      slug: "discover-context",
      name: "Discover context",
      engine: "codex",
      model: "gpt-5.3-codex",
      agent: "scout",
      depends: [],
      description: "Inspect the auth flow and summarize the relevant files. Acceptance: identify the modules that downstream implementation work must touch.",
    });

    await createTaskFolder(root, {
      id: "002",
      slug: "implement-fix",
      name: "Implement fix",
      engine: "codex",
      model: "gpt-5.3-codex",
      agent: "worker",
      depends: ["001"],
      description: "Use the discovery task output to implement the auth fix. Acceptance: update the relevant files and preserve the upstream constraints.",
    });

    const taskMd = await readFile(join(root, ".pi", "tasks", "002-implement-fix", "task.md"), "utf-8");

    assert.match(taskMd, /Before starting substantive work, inspect every upstream task referenced above and use its outputs as direct inputs to this task\./);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/task\.md` for the original scope/);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/status\.json` to confirm whether the task completed successfully/);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/progress\.jsonl` for concise execution notes/);
    assert.match(taskMd, /Read `\.pi\/tasks\/001-discover-context\/output\.jsonl` for the raw engine transcript and final summary/);
    assert.match(taskMd, /Reuse concrete outputs from this dependency instead of rediscovering context\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
