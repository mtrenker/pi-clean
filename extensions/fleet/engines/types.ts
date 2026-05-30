// Fleet engine adapters — shared types

// ── Usage types ───────────────────────────────────────────────────────────────

/**
 * Raw usage data reported by engine adapters.  This is the wire-level form
 * returned by engine callbacks; cache fields are optional because not every
 * engine reports them.
 */
export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Normalized usage envelope — the canonical form stored in TaskState and
 * AggregateState.  All numeric fields are required (zero when absent); string
 * fields default to "" for legacy on-disk data that predates this schema.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Sum of all four token fields — always kept in sync by normalizeUsage. */
  totalTokens: number;
  /** Engine that produced this usage ("claude", "codex", "simulate", …); "" for legacy data. */
  source: string;
  /** ISO timestamp of the last live update; "" for legacy / static data. */
  updatedAt: string;
}

export function totalUsageTokens(usage: Partial<Usage> | undefined): number {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0)
  );
}

/**
 * Convert any raw or partial usage shape to the full normalized Usage envelope.
 * Handles legacy on-disk data that lacks the new fields.
 *
 * @param raw       Raw engine usage, a partial Usage, or undefined
 * @param source    Engine name — preserved if already non-empty in `raw`
 * @param updatedAt ISO timestamp — preserved if already non-empty in `raw`
 */
export function normalizeUsage(
  raw: Partial<EngineUsage & Usage> | undefined,
  source = "",
  updatedAt = "",
): Usage {
  const inputTokens = raw?.inputTokens ?? 0;
  const outputTokens = raw?.outputTokens ?? 0;
  const cacheCreationInputTokens = raw?.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = raw?.cacheReadInputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    source: (raw as Partial<Usage>)?.source || source,
    updatedAt: (raw as Partial<Usage>)?.updatedAt || updatedAt,
  };
}

export interface EngineResult {
  success: boolean;
  exitCode: number;
  error?: string;
}

export interface EngineProcess {
  readonly pid: number;
  onProgress(cb: (line: string) => void): void;
  /** Callback receives raw engine-level usage; orchestrator normalizes it to Usage. */
  onUsageUpdate(cb: (usage: EngineUsage) => void): void;
  onComplete(cb: (result: EngineResult) => void): void;
  kill(): void;
}

export interface EngineAdapter {
  spawn(opts: {
    taskPrompt: string;
    agentPrompt: string;
    model: string;
    thinking?: string;
    tools?: string[] | null;
    cwd: string;
    outputJsonlPath: string; // path to append raw output lines
  }): EngineProcess;
}
