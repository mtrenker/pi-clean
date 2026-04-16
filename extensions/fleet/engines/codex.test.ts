import test from "node:test";
import assert from "node:assert/strict";

import { extractCodexUsage, extractLatestCodexUsageFromJsonl } from "./codex-usage.ts";

test("extractCodexUsage reads usage from done events", () => {
  const usage = extractCodexUsage({
    type: "done",
    usage: {
      input_tokens: 123,
      output_tokens: 45,
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 123,
    outputTokens: 45,
  });
});

test("extractCodexUsage reads usage from turn.completed events", () => {
  const usage = extractCodexUsage({
    type: "turn.completed",
    usage: {
      input_tokens: 1213525,
      cached_input_tokens: 1160832,
      output_tokens: 11509,
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 1213525,
    outputTokens: 11509,
  });
});

test("extractCodexUsage returns null when usage is absent", () => {
  assert.equal(extractCodexUsage({ type: "item.completed" }), null);
});

test("extractLatestCodexUsageFromJsonl returns the latest usage event in output history", () => {
  const usage = extractLatestCodexUsageFromJsonl([
    JSON.stringify({ type: "item.completed" }),
    JSON.stringify({ type: "done", usage: { input_tokens: 100, output_tokens: 10 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 250, output_tokens: 25 } }),
  ].join("\n"));

  assert.deepEqual(usage, {
    inputTokens: 250,
    outputTokens: 25,
  });
});
