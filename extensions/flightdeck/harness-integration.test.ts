import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "@mariozechner/jiti";

import type * as HarnessDelegateModule from "../harness-delegate/index.js";
import { subscribeTaskLifecycle } from "./lifecycle.js";
import { FlightdeckTelemetryAdapter } from "./telemetry.js";

test("delegate_harness success, failure, and abort each produce one truthful terminal lifecycle", async () => {
  const packageRoot = process.cwd();
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@mariozechner/pi-ai": join(packageRoot, "node_modules/@mariozechner/pi-ai/dist/index.js"),
      "@mariozechner/pi-agent-core": join(packageRoot, "node_modules/@mariozechner/pi-agent-core/dist/index.js"),
      "@mariozechner/pi-coding-agent": join(packageRoot, "node_modules/@mariozechner/pi-coding-agent/dist/index.js"),
      "@mariozechner/pi-tui": join(packageRoot, "node_modules/@mariozechner/pi-tui/dist/index.js"),
    },
  });
  const harness = await jiti.import(join(packageRoot, "extensions/harness-delegate/index.ts")) as typeof HarnessDelegateModule;
  const runHarnessWithLifecycle = harness.runHarnessWithLifecycle;
  const root = await mkdtemp(join(tmpdir(), "pi-harness-flightdeck-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const prompt = process.argv.at(-1) || "";
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
if (prompt === "abort") {
  setInterval(() => console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", id: "wait", command: "wait", status: "running" } })), 20);
} else {
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 3, cached_input_tokens: 2 } }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "answer", text: "done" } }));
  process.exit(prompt === "fail" ? 3 : 0);
}
`, "utf8");
  await chmod(executable, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const lines: string[] = [];
  const adapter = new FlightdeckTelemetryAdapter({
    sinkPath: "/virtual/events.jsonl",
    append: async (_path, line) => { lines.push(line); },
  });
  const unsubscribe = subscribeTaskLifecycle((event) => adapter.handle(event));

  try {
    const success = await runHarnessWithLifecycle({
      toolCallId: "success-call",
      params: { provider: "codex", prompt: "success", cwd: root, model: "gpt-test" },
    });
    assert.equal(success.state, "success");

    const failure = await runHarnessWithLifecycle({
      toolCallId: "failure-call",
      params: { provider: "codex", prompt: "fail", cwd: root, model: "gpt-test" },
    });
    assert.equal(failure.state, "error");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 70);
    const aborted = await runHarnessWithLifecycle({
      toolCallId: "abort-call",
      params: { provider: "codex", prompt: "abort", cwd: root, model: "gpt-test" },
      signal: controller.signal,
    });
    assert.equal(aborted.state, "aborted");

    const events = lines.map((line) => JSON.parse(line));
    for (const toolCallId of ["success-call", "failure-call", "abort-call"]) {
      const lifecycle = events.filter((event) => event.attributes.agentId.endsWith(toolCallId));
      assert.equal(lifecycle.filter((event) => event.event === "agent.task.started").length, 1);
      assert.equal(lifecycle.filter((event) => event.event === "agent.task.completed" || event.event === "agent.task.failed").length, 1);
    }
    const abortEvents = events.filter((event) => event.attributes.agentId.endsWith("abort-call"));
    assert.equal(abortEvents.filter((event) => event.event === "agent.tokens.used").length, 0);
    assert.deepEqual(adapter.getStatus().counts, { active: 0, completed: 1, failed: 1, aborted: 1, stale: 0 });
  } finally {
    unsubscribe();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
