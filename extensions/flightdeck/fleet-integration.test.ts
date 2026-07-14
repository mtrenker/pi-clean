import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultFleetConfig } from "../fleet/config.ts";
import { Orchestrator } from "../fleet/orchestrator.ts";
import { createTaskFolder } from "../fleet/task.ts";
import { subscribeTaskLifecycle } from "./lifecycle.ts";
import { FlightdeckTelemetryAdapter } from "./telemetry.ts";

test("Fleet Claude/Codex transitions use the canonical Fleet run and task IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-flightdeck-"));
  const executable = join(root, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: "message", role: "assistant", content: "private progress must not enter telemetry" }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 25, output_tokens: 7 } }));
  process.exit(0);
}, 50);
`, "utf8");
  await chmod(executable, 0o755);

  const config = defaultFleetConfig();
  config.concurrency = 1;
  config.defaults.engine = "codex";
  config.defaults.model = "gpt-test";
  config.engines.codex = { command: executable, args: [] };

  await createTaskFolder(root, {
    id: "001",
    name: "Telemetry task",
    slug: "telemetry-task",
    engine: "codex",
    model: "gpt-test",
    agent: "worker",
    depends: [],
    description: "Exercise Fleet lifecycle telemetry with a concrete fake Codex process.",
  });
  // Deliberately omit legacy-optional git metadata: telemetry enrichment must
  // not prevent the already-spawned task from running.
  await writeFile(join(root, ".pi", "tasks", "run.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "fleet-run-fixed",
    startedAt: "2026-07-14T16:00:00.000Z",
    status: "running",
    cwd: root,
    planPath: "PLAN.md",
    configSources: [{ label: "built-in", present: false }],
    concurrency: 1,
  }), "utf8");

  const lines: string[] = [];
  const adapter = new FlightdeckTelemetryAdapter({
    sinkPath: "/virtual/events.jsonl",
    append: async (_path, line) => { lines.push(line); },
  });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));
  const orchestrator = new Orchestrator(root, config);

  try {
    const done = new Promise<void>((resolve) => orchestrator.once("fleet:done", () => resolve()));
    await orchestrator.start();
    await done;
    await adapter.flush();

    const events = lines.map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "agent.task.started"));
    assert.ok(events.some((event) => event.event === "agent.task.running"));
    assert.ok(events.some((event) => event.event === "agent.tokens.used"));
    assert.ok(events.some((event) => event.event === "agent.task.completed"));
    assert.ok(events.every((event) => event.attributes.runId === "fleet-run-fixed"));
    assert.ok(events.every((event) => event.attributes.taskId === "001"));
    assert.ok(events.every((event) => event.attributes.source === "fleet"));
    assert.doesNotMatch(lines.join(""), /private progress/);
  } finally {
    unsubscribe();
    await rm(root, { recursive: true, force: true });
  }
});
