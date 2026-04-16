# Task 002: Engine Adapters

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: 001

## Context

You are implementing the `fleet` extension for `pi`. Fleet orchestrates work across `pi`, `claude`, and `codex` CLI engines by spawning them as subprocesses and parsing their streaming JSON output.

Task 001 has already created `extensions/fleet/index.ts`, `extensions/fleet/config.ts`, and `extensions/fleet/plan.ts`. Read those files before starting.

This task creates the engine adapter layer under `extensions/fleet/engines/`.

## How the Engines Work

### claude
Invoked as:
```
claude -p --output-format stream-json --dangerously-skip-permissions \
  --system-prompt "<agent prompt>" \
  --model <model> \
  "<task prompt>"
```
Outputs a stream of newline-delimited JSON objects. Relevant event types:
- `{ type: "assistant", message: { content: [...] } }` — assistant message chunks
- `{ type: "result", usage: { input_tokens, output_tokens }, subtype: "success"|"error_...", result: "..." }` — final result with usage

### pi
Invoked as:
```
pi -p --output-format stream-json \
  --system-prompt "<agent prompt>" \
  --model <model> \
  "<task prompt>"
```
Same stream-json format as claude (pi uses the same protocol).

### codex
Invoked as:
```
codex exec --json --dangerously-bypass-approvals-and-sandbox \
  -m <model> \
  "<agent prompt>\n\n<task prompt>"
```
(agent prompt is prepended to the task prompt since codex has no `--system-prompt` flag)

Outputs JSONL. Relevant event types:
- `{ type: "message", role: "assistant", content: "..." }` — assistant output
- `{ type: "shell_output", output: "..." }` — command output
- `{ type: "done", usage: { input_tokens, output_tokens } }` — completion with usage
- Non-zero exit code = failure

## Files to Create

### `extensions/fleet/engines/types.ts`

```typescript
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
    outputJsonlPath: string;  // path to append raw output lines
  }): EngineProcess;
}
```

### `extensions/fleet/engines/claude.ts`
`ClaudeEngineAdapter implements EngineAdapter`. Spawns the claude CLI, pipes stdout line by line. Each line is:
1. Written raw to `outputJsonlPath` (append)
2. Parsed as JSON — extract progress text from `assistant` events, usage from `result` events
3. Fires appropriate callbacks

Extract a human-readable progress string from assistant content blocks (concatenate text blocks, trim to 120 chars).

### `extensions/fleet/engines/pi.ts`
`PiEngineAdapter implements EngineAdapter`. Identical logic to ClaudeEngineAdapter (same stream-json format), different command.

### `extensions/fleet/engines/codex.ts`
`CodexEngineAdapter implements EngineAdapter`. Parses JSONL from codex. Prepend agent prompt to task prompt. Extract progress from `message` and `shell_output` events, usage from `done` event.

### `extensions/fleet/engines/index.ts`
Factory function:
```typescript
export function createEngineAdapter(engineName: string, engineConfig: EngineConfig): EngineAdapter
```
Returns the right adapter for the given engine name (`pi`, `claude`, `codex`). Throws for unknown engines.

## Acceptance Criteria
- All adapters implement `EngineAdapter` interface correctly
- Raw output is appended to `outputJsonlPath` line by line
- `onProgress` fires with a human-readable string whenever the agent produces output
- `onUsageUpdate` fires whenever token usage is available in the stream
- `onComplete` fires exactly once with success/failure when the process exits
- `kill()` terminates the subprocess cleanly (SIGTERM, then SIGKILL after 3s)
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
