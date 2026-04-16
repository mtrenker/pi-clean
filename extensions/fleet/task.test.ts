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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
