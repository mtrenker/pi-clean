// Fleet engine adapters — factory

import type { EngineAdapter } from "./types.js";
import type { EngineConfig } from "../config.js";
import { ClaudeEngineAdapter } from "./claude.js";
import { PiEngineAdapter } from "./pi.js";
import { CodexEngineAdapter } from "./codex.js";

export { ClaudeEngineAdapter } from "./claude.js";
export { PiEngineAdapter } from "./pi.js";
export { CodexEngineAdapter } from "./codex.js";
export type { Usage, EngineResult, EngineProcess, EngineAdapter } from "./types.js";

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the appropriate EngineAdapter for the given engine name.
 *
 * Supported engine names: `"pi"`, `"claude"`, `"codex"`.
 *
 * @throws Error for unknown engine names.
 */
export function createEngineAdapter(
  engineName: string,
  engineConfig: EngineConfig,
): EngineAdapter {
  switch (engineName) {
    case "claude":
      return new ClaudeEngineAdapter(engineConfig);
    case "pi":
      return new PiEngineAdapter(engineConfig);
    case "codex":
      return new CodexEngineAdapter(engineConfig);
    default:
      throw new Error(
        `Unknown engine "${engineName}". Supported engines: claude, pi, codex.`,
      );
  }
}
