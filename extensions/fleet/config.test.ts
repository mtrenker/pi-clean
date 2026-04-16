import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveTaskExecution } from "./config.ts";

test("loadConfig deep-merges profile engine mappings with defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-config-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    await writeFile(
      join(root, ".pi", "tasks", "config.json"),
      JSON.stringify({
        profiles: {
          deep: {
            codex: { model: "custom-codex", thinking: "high" },
          },
        },
      }),
      "utf-8",
    );

    const config = await loadConfig(root);

    assert.equal(config.profiles?.deep?.codex?.model, "custom-codex");
    assert.equal(config.profiles?.deep?.claude?.model, "sonnet");
    assert.equal(config.profiles?.deep?.pi?.model, "anthropic/claude-sonnet-4-6");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTaskExecution uses merged claude profile mapping after repo overrides codex only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-config-"));

  try {
    await mkdir(join(root, ".pi", "tasks"), { recursive: true });
    await writeFile(
      join(root, ".pi", "tasks", "config.json"),
      JSON.stringify({
        profiles: {
          fast: {
            codex: { model: "custom-fast-codex", thinking: "low" },
          },
          balanced: {
            codex: { model: "custom-balanced-codex", thinking: "medium" },
          },
          deep: {
            codex: { model: "custom-deep-codex", thinking: "high" },
          },
        },
      }),
      "utf-8",
    );

    const config = await loadConfig(root);
    const resolved = resolveTaskExecution(config, {
      id: "001",
      name: "Audit current fleet widget rendering and progress data flow",
      engine: "claude",
      model: "",
      profile: "deep",
    });

    assert.equal(resolved.model, "sonnet");
    assert.equal(resolved.thinking, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
