# Task 005: Recovery

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: 004

## Context

You are implementing the `fleet` extension for `pi`. When an agent task fails, fleet auto-retries once using a `recovery.md` file that gives the next agent context about what went wrong and where to continue from.

Tasks 001-004 are done. Read these files before starting:
- `extensions/fleet/task.ts` — `TaskState`, `ProgressEntry`, `readStatus()`, `writeStatus()`, `readProgress()`, `taskDir()`
- `extensions/fleet/orchestrator.ts` — `Orchestrator`, `TaskStatusEvent`

## File to Create

### `extensions/fleet/recovery.ts`

#### How Recovery Works

1. Orchestrator detects a task failed (exit code != 0 or process error)
2. If `task.retries < 1`: orchestrator sets status to `"retrying"`, then calls `generateRecovery()` from this module
3. `generateRecovery()` writes `recovery.md` into the task folder
4. `generateRecovery()` calls `orchestrator.retry(taskId)` which re-spawns the engine
5. The re-spawned engine will find `recovery.md` in its task directory — the task.md already instructs agents to check for this file before starting work
6. If the retry also fails: orchestrator sets status to `"failed"` and notifies the user via `ctx.ui.notify()` (the notification callback is passed in)

#### `recovery.md` Format

```markdown
# Recovery: {task name}

## Previous Attempt
- **Started**: {startedAt}
- **Failed**: {now}
- **Retries**: {retries}
- **Error**: {error message or "non-zero exit code"}

## Last Progress
{last 10 progress entries from progress.jsonl, formatted as:
  - [{status}] {step}
}

## Last Output
(last 50 lines from output.jsonl, extracting text content from JSON)

## Instructions
A previous attempt at this task failed. Continue from where it left off.
The changes made so far may be partially applied — check git status first.
Review the progress and error output above before proceeding.
```

#### Functions to Export

```typescript
// Generate recovery.md for a failed task and trigger retry
export async function handleFailure(opts: {
  cwd: string;
  taskState: TaskState;
  orchestrator: Orchestrator;
  onNotify: (message: string) => void;  // pi ui.notify callback
}): Promise<void>

// Read the last N lines of output.jsonl and extract human-readable text
export async function extractOutputText(
  cwd: string,
  id: string,
  name: string,
  maxLines?: number   // default 50
): Promise<string>
```

#### `handleFailure` Logic

```
1. Read progress entries via readProgress()
2. Extract last output text via extractOutputText()
3. Format and write recovery.md to taskDir(cwd, id, name)/recovery.md
4. Call orchestrator.retry(taskState.id)

If this is already a retry (retries >= 1):
  - DO NOT write recovery.md again
  - DO NOT call orchestrator.retry()
  - Call onNotify(`Task ${id}-${name} failed after retry. Manual intervention required.`)
```

#### Output Text Extraction

The `output.jsonl` contains raw JSON lines from the engine stream. To extract readable text:
- For claude/pi stream-json: look for `type: "assistant"` events, extract text from content blocks
- For codex JSONL: look for `type: "message"` or `type: "shell_output"` events, extract `.content` or `.output`
- Fall back to the raw line if it can't be parsed as JSON

#### Integration with Orchestrator

The recovery module is called from `orchestrator.ts` in the `handleComplete` method. The orchestrator passes `handleFailure` a reference to itself and the `onNotify` callback. This keeps the orchestrator free of recovery logic.

Update `orchestrator.ts` to import and call `handleFailure` from this module in the failure branch of `handleComplete`.

## Acceptance Criteria
- `recovery.md` is written with correct content on first failure
- `orchestrator.retry()` is called after recovery.md is written
- On second failure, user is notified via `onNotify` callback
- No second recovery.md is written on retry failure
- `extractOutputText()` produces readable text from both claude and codex output formats
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
