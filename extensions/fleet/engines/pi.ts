// Fleet engine adapter — pi CLI (stream-json format, identical to claude)

import type { EngineAdapter, EngineProcess } from "./types.js";
import type { EngineConfig } from "../config.js";
import { spawnStreamJson } from "./_stream-json-process.js";

// ── PiEngineAdapter ───────────────────────────────────────────────────────────

/**
 * Spawns the `pi` CLI with `--output-format stream-json` and parses its
 * newline-delimited JSON output.  The output format is identical to the
 * `claude` adapter — only the command differs.
 *
 * Invocation:
 *   pi -p --output-format stream-json \
 *     --system-prompt "<agentPrompt>" \
 *     --model <model> \
 *     "<taskPrompt>"
 *
 * Stream events consumed:
 *   { type: "assistant", message: { content: [...] } }  → onProgress
 *   { type: "result",    usage: { input_tokens, output_tokens } } → onUsageUpdate
 */
export class PiEngineAdapter implements EngineAdapter {
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
