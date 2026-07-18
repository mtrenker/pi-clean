import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import type * as LifecycleModule from "./lifecycle.js";

test("lifecycle registry is shared across Pi-style jiti module-cache boundaries", async () => {
  const lifecyclePath = join(process.cwd(), "extensions/flightdeck/lifecycle.ts");
  const subscriberLoader = createJiti(import.meta.url, { moduleCache: false });
  const producerLoader = createJiti(import.meta.url, { moduleCache: false });
  const subscriber = await subscriberLoader.import(lifecyclePath) as typeof LifecycleModule;
  const producer = await producerLoader.import(lifecyclePath) as typeof LifecycleModule;

  let seen = 0;
  const unsubscribe = subscriber.subscribeTaskLifecycle(() => { seen += 1; });
  try {
    await producer.emitTaskLifecycle({
      type: "started",
      lifecycleId: "loader-boundary",
      agentId: "agent",
      runId: "run",
      taskId: "task",
      provider: "claude",
      source: "delegate",
      staleAfterSeconds: 90,
      context: {},
      ts: "2026-07-14T17:00:00.000Z",
    });
    assert.equal(seen, 1);
  } finally {
    unsubscribe();
  }
});
