import type { Usage } from "./types.js";
import { totalUsageTokens } from "./types.js";

export function extractClaudeUsage(evt: Record<string, unknown>): Usage | null {
  const usageRaw = readUsageRaw(evt);
  if (!usageRaw) return null;
  const usage = parseClaudeUsage(usageRaw);
  return totalUsageTokens(usage) > 0 ? usage : null;
}

export function extractClaudeUsageFromJsonl(content: string): Usage | null {
  let accumulated: Usage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      const usage = extractClaudeUsage(evt);
      if (!usage) continue;

      if (evt["type"] === "assistant") {
        accumulated = addUsage(accumulated, usage);
      } else {
        accumulated = maxUsage(accumulated, usage);
      }
      sawUsage = true;
    } catch {
      // Ignore malformed lines and keep scanning for later valid usage events.
    }
  }

  return sawUsage ? accumulated : null;
}

function readUsageRaw(evt: Record<string, unknown>): Record<string, number> | null {
  if (evt["type"] === "assistant") {
    const message = evt["message"] as Record<string, unknown> | undefined;
    return (message?.["usage"] as Record<string, number> | undefined) ?? null;
  }

  return (evt["usage"] as Record<string, number> | undefined) ?? null;
}

function parseClaudeUsage(usageRaw: Record<string, number>): Usage {
  const usage: Usage = {
    inputTokens: usageRaw["input_tokens"] ?? 0,
    outputTokens: usageRaw["output_tokens"] ?? 0,
  };

  const cacheCreation = usageRaw["cache_creation_input_tokens"] ?? 0;
  const cacheRead = usageRaw["cache_read_input_tokens"] ?? 0;
  if (cacheCreation > 0) usage.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) usage.cacheReadInputTokens = cacheRead;

  return usage;
}

function addUsage(left: Usage, right: Usage): Usage {
  const next: Usage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };

  const cacheCreation = (left.cacheCreationInputTokens ?? 0) + (right.cacheCreationInputTokens ?? 0);
  const cacheRead = (left.cacheReadInputTokens ?? 0) + (right.cacheReadInputTokens ?? 0);
  if (cacheCreation > 0) next.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) next.cacheReadInputTokens = cacheRead;

  return next;
}

function maxUsage(left: Usage, right: Usage): Usage {
  const next: Usage = {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
  };

  const cacheCreation = Math.max(left.cacheCreationInputTokens ?? 0, right.cacheCreationInputTokens ?? 0);
  const cacheRead = Math.max(left.cacheReadInputTokens ?? 0, right.cacheReadInputTokens ?? 0);
  if (cacheCreation > 0) next.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) next.cacheReadInputTokens = cacheRead;

  return next;
}
