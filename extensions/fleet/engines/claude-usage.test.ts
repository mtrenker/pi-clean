import test from "node:test";
import assert from "node:assert/strict";

import { extractClaudeUsage, extractClaudeUsageFromJsonl } from "./claude-usage.ts";

test("extractClaudeUsage reads cache-aware usage from assistant events", () => {
  const usage = extractClaudeUsage({
    type: "assistant",
    message: {
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 5,
      },
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 1000,
  });
});

test("extractClaudeUsageFromJsonl sums assistant usage and treats result usage as aggregate fallback", () => {
  const usage = extractClaudeUsageFromJsonl([
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1 } },
    }),
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 20, cache_creation_input_tokens: 50, output_tokens: 2 } },
    }),
    JSON.stringify({
      type: "result",
      usage: { input_tokens: 30, cache_creation_input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 3 },
    }),
  ].join("\n"));

  assert.deepEqual(usage, {
    inputTokens: 30,
    outputTokens: 3,
    cacheCreationInputTokens: 50,
    cacheReadInputTokens: 100,
  });
});
