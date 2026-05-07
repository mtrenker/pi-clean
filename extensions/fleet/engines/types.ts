// Fleet engine adapters — shared types

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
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

export function normalizeUsage(usage: Partial<Usage> | undefined): Usage {
  const normalized: Usage = {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };

  if (usage?.cacheCreationInputTokens) {
    normalized.cacheCreationInputTokens = usage.cacheCreationInputTokens;
  }
  if (usage?.cacheReadInputTokens) {
    normalized.cacheReadInputTokens = usage.cacheReadInputTokens;
  }

  return normalized;
}

export interface EngineResult {
  success: boolean;
  exitCode: number;
  error?: string;
}

export interface EngineProcess {
  readonly pid: number;
  onProgress(cb: (line: string) => void): void;
  onUsageUpdate(cb: (usage: Usage) => void): void;
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
