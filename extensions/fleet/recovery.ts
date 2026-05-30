// Fleet extension — Recovery
// Generates recovery.md for failed tasks and triggers a retry.

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

import { readProgress, taskDir, type TaskState } from "./task.js";
import type { Orchestrator } from "./orchestrator.js";
import { deriveSyncHints, type AttentionHint } from "./attention.js";

// ── Output text extraction ────────────────────────────────────────────────────

/**
 * Read the last N lines of output.jsonl and extract human-readable text.
 * Handles claude stream-json format and codex JSONL format.
 */
export async function extractOutputText(
  cwd: string,
  id: string,
  name: string,
  maxLines = 50,
): Promise<string> {
  const outputPath = join(taskDir(cwd, id, name), "output.jsonl");

  let content: string;
  try {
    content = await readFile(outputPath, "utf-8");
  } catch {
    return "(no output available)";
  }

  const rawLines = content
    .split("\n")
    .filter((line) => line.trim() !== "");

  // Take last maxLines raw lines before extracting text
  const lastRawLines = rawLines.slice(-maxLines);

  const textLines: string[] = [];

  for (const line of lastRawLines) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not valid JSON — include raw line
      textLines.push(line);
      continue;
    }

    const extracted = extractTextFromEvent(parsed);
    if (extracted !== null) {
      textLines.push(extracted);
    }
    // If null, the event is non-textual (system events, usage, etc.) — skip
  }

  return textLines.length > 0 ? textLines.join("\n") : "(no text output found)";
}

/**
 * Extract readable text from a single parsed JSON event line.
 * Returns null if the event has no human-readable text content.
 */
function extractTextFromEvent(event: Record<string, unknown>): string | null {
  const type = event["type"];

  // Claude stream-json: assistant messages with content blocks
  if (type === "assistant") {
    const message = event["message"] as Record<string, unknown> | undefined;
    if (!message) return null;

    const content = message["content"];
    if (!Array.isArray(content)) return null;

    const parts: string[] = [];
    for (const block of content as Record<string, unknown>[]) {
      if (block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      }
      // Skip "thinking" blocks — they're internal reasoning, not output
    }
    return parts.length > 0 ? parts.join("") : null;
  }

  // Codex JSONL: message events
  if (type === "message") {
    const messageContent = event["content"];
    if (typeof messageContent === "string") {
      return messageContent;
    }
    return null;
  }

  // Codex JSONL: shell_output events
  if (type === "shell_output") {
    const output = event["output"];
    if (typeof output === "string") {
      return output;
    }
    return null;
  }

  // No recognizable text content
  return null;
}

// ── Recovery markdown generation ──────────────────────────────────────────────

function formatRecoveryMd(
  taskState: TaskState,
  progressLines: string,
  outputText: string,
  now: string,
): string {
  return `# Recovery: ${taskState.name}

## Previous Attempt
- **Started**: ${taskState.startedAt ?? "unknown"}
- **Failed**: ${now}
- **Retries**: ${taskState.retries}
- **Error**: ${taskState.error ?? "non-zero exit code"}

## Last Progress
${progressLines}

## Last Output
${outputText}

## Instructions
A previous attempt at this task failed. Continue from where it left off.
The changes made so far may be partially applied — check git status first.
Review the progress and error output above before proceeding.
`;
}

// ── handleFailure ─────────────────────────────────────────────────────────────

/**
 * Derive the attention hints that apply to a task's current failure state.
 * Exported so callers (e.g. index.ts notification handlers) can reference the
 * same dedupeKey that Flightdeck uses.
 */
export function deriveFailureHints(
  taskState: TaskState,
  runId?: string,
): AttentionHint[] {
  // Build the minimal AttentionTaskInput from TaskState.
  // Usage normalization guarantees totalTokens and source are present.
  return deriveSyncHints(
    [
      {
        id: taskState.id,
        name: taskState.name,
        status: taskState.status,
        retries: taskState.retries,
        error: taskState.error,
        blockedBy: null, // not relevant for failure hints
        lastHeartbeatAt: taskState.lastHeartbeatAt,
        staleAfterSeconds: taskState.staleAfterSeconds,
        usage: taskState.usage,
        completedAt: taskState.completedAt,
        startedAt: taskState.startedAt,
      },
    ],
    { runId },
  );
}

/**
 * Generate recovery.md for a failed task and trigger retry, OR notify the user
 * if this is already a retry failure.
 */
export async function handleFailure(opts: {
  cwd: string;
  taskState: TaskState;
  orchestrator: Orchestrator;
  onNotify: (message: string) => void;
  runId?: string;
}): Promise<void> {
  const { cwd, taskState, orchestrator, onNotify, runId } = opts;
  const { id, name, retries } = taskState;

  if (retries >= 1) {
    // Already retried once — permanently failed.  Derive the operator_review_needed
    // attention hint so the notification includes the stable dedupeKey that
    // Flightdeck uses to surface this issue.
    const hints = deriveFailureHints(taskState, runId);
    const reviewHint = hints.find((h) => h.category === "operator_review_needed");
    const dedupeInfo = reviewHint ? ` [hint:${reviewHint.dedupeKey}]` : "";
    onNotify(
      `Task ${id}-${name} failed after retry. Manual intervention required.${dedupeInfo}`,
    );
    return;
  }

  // First failure — generate recovery.md and retry
  const now = new Date().toISOString();

  // 1. Read progress entries
  const progressEntries = await readProgress(cwd, id, name);
  const lastProgress = progressEntries.slice(-10);
  const progressLines =
    lastProgress.length > 0
      ? lastProgress.map((e) => `  - [${e.status}] ${e.step}`).join("\n")
      : "  (no progress recorded)";

  // 2. Extract last output text
  const outputText = await extractOutputText(cwd, id, name);

  // 3. Write recovery.md
  const recoveryContent = formatRecoveryMd(taskState, progressLines, outputText, now);
  const dir = taskDir(cwd, id, name);
  await writeFile(join(dir, "recovery.md"), recoveryContent, "utf-8");

  // 4. Trigger retry
  await orchestrator.retry(id);
}
