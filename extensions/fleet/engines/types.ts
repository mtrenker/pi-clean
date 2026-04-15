// Fleet engine adapters — shared types

export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
    cwd: string;
    outputJsonlPath: string; // path to append raw output lines
  }): EngineProcess;
}
