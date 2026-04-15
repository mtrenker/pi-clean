// Fleet engine adapter — claude CLI (stream-json format)

import type { EngineAdapter, EngineProcess } from "./types.js";
import type { EngineConfig } from "../config.js";
import { spawnStreamJson } from "./_stream-json-process.js";

// ── ClaudeEngineAdapter ───────────────────────────────────────────────────────

/**
 * Spawns the `claude` CLI with `--output-format stream-json` and parses its
 * newline-delimited JSON output.
 *
 * Invocation:
 *   claude -p --output-format stream-json --dangerously-skip-permissions \
 *     --system-prompt "<agentPrompt>" \
 *     --model <model> \
 *     "<taskPrompt>"
 *
 * Stream events consumed:
 *   { type: "assistant", message: { content: [...] } }  → onProgress
 *   { type: "result",    usage: { input_tokens, output_tokens } } → onUsageUpdate
 */
export class ClaudeEngineAdapter implements EngineAdapter {
  constructor(private readonly engineConfig: EngineConfig) {}

  spawn(opts: {
    taskPrompt: string;
    agentPrompt: string;
    model: string;
    cwd: string;
    outputJsonlPath: string;
  }): EngineProcess {
    return spawnStreamJson({
      command: this.engineConfig.command,
      baseArgs: this.engineConfig.args,
      agentPrompt: opts.agentPrompt,
      model: opts.model,
      taskPrompt: opts.taskPrompt,
      cwd: opts.cwd,
      outputJsonlPath: opts.outputJsonlPath,
    });
  }
}
