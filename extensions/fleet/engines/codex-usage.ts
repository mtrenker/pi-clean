import type { EngineUsage } from "./types.js";

export function extractCodexUsage(evt: Record<string, unknown>): EngineUsage | null {
  const usageRaw = evt["usage"] as Record<string, number> | undefined;
  if (!usageRaw) return null;

  return {
    inputTokens: usageRaw["input_tokens"] ?? 0,
    outputTokens: usageRaw["output_tokens"] ?? 0,
  };
}

export function extractLatestCodexUsageFromJsonl(content: string): EngineUsage | null {
  let latest: EngineUsage | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      const usage = extractCodexUsage(evt);
      if (!usage) continue;
      latest = usage;
    } catch {
      // Ignore malformed lines and keep scanning for later valid usage events.
    }
  }

  return latest;
}
