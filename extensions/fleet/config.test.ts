import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveTaskExecution } from "./config.ts";


test("loadConfig bootstraps .pi/fleet.json with defaults when missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-config-"));

  try {
    const config = await loadConfig(root);
    const written = await readFile(join(root, ".pi", "fleet.json"), "utf-8");
    const parsed = JSON.parse(written);

    assert.equal(config.planPath, "PLAN.md");
    assert.equal(config.tasksDir, ".pi/tasks");
    assert.equal(config.defaults.engine, "claude");
    assert.equal(parsed.planPath, "PLAN.md");
    assert.equal(parsed.tasksDir, ".pi/tasks");
    assert.equal(parsed.defaults.engine, "claude");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("loadConfig throws when .pi/fleet.json contains invalid JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-config-"));

  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "fleet.json"), "{ invalid json\n", "utf-8");

    await assert.rejects(() => loadConfig(root), /JSON|Unexpected token|Expected property name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig deep-merges profile engine mappings with defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-config-"));

  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "fleet.json"),
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
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "fleet.json"),
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

test("resolveTaskExecution remaps deprecated OpenAI model aliases to supported 5.3+ models", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-config-"));

  try {
    const config = await loadConfig(root);

    const codexResolved = resolveTaskExecution(config, {
      id: "002",
      name: "Build widget",
      engine: "codex",
      model: "o3",
    });
    assert.equal(codexResolved.model, "gpt-5.3-codex");
    assert.match(codexResolved.warnings[0] ?? "", /deprecated model "o3"/);

    const codexMiniResolved = resolveTaskExecution(config, {
      id: "003",
      name: "Fast lane",
      engine: "codex",
      model: "gpt-5.1-codex-mini",
    });
    assert.equal(codexMiniResolved.model, "gpt-5.3-codex-spark");

    const genericResolved = resolveTaskExecution(config, {
      id: "004",
      name: "Long running agent",
      engine: "pi",
      model: "gpt-5.2",
    });
    assert.equal(genericResolved.model, "gpt-5.4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
