/**
 * Agent Guard — Extension Entry Point
 *
 * Wires all hooks for the agent-guard extension:
 *
 *   1. tool_call (bash)         — block catastrophic commands (env preamble currently disabled)
 *   2. tool_call (read/write/edit) — path guard via enforcePathGuard (path-guard.ts)
 *   3. tool_result              — output redaction via redactContent (redaction.ts)
 *   4. user_bash                — env preamble hook for !cmd / !!cmd paths (currently disabled)
 *   5. session_start            — set footer status badge, load policy
 *   6. session_shutdown         — clear footer status badge
 *   7. /agent-guard cmd         — show policy summary and recent audit log
 *
 * All guard logic is delegated to sub-modules; no guard logic lives here.
 *
 * Sub-modules:
 *   - env.ts          — env helper stubs (env stripping currently disabled)
 *   - action-guard.ts — checkAction
 *   - path-guard.ts   — enforcePathGuard / classifyPath
 *   - redaction.ts    — redactContent  (added by Task 005)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";

import {
  type ExtensionAPI,
  type BashOperations,
  isToolCallEventType,
  createLocalBashOperations,
} from "@mariozechner/pi-coding-agent";

import { loadPolicy, type GuardPolicy } from "./policy.js";
import { buildUnsetPreamble } from "./env.js";
import { checkAction } from "./action-guard.js";
import { enforcePathGuard, classifyPath, resolveInputPath, type LogFn } from "./path-guard.js";
import { redactContent } from "./redaction.js";

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEvent {
  ts: string;
  guard: "secretGuard" | "actionGuard" | "system";
  type: string;
  toolName?: string;
  command?: string;
  path?: string;
  reason?: string;
  count?: number;
}

/**
 * Creates an audit logger that appends JSON lines to `logPath`.
 * The directory is created if it does not exist (best-effort; errors are
 * swallowed so logging failures never crash the session).
 *
 * The returned function is typed as `LogFn` (accepts `Record<string, unknown>`)
 * so it is compatible with `enforcePathGuard` from `path-guard.ts`, while also
 * accepting the stricter `AuditEvent` type at structured call sites.
 */
function createAuditLogger(logPath: string): LogFn {
  return async function log(event: Record<string, unknown>): Promise<void> {
    const withTs = event["ts"] ? event : { ts: new Date().toISOString(), ...event };
    try {
      const dir = path.dirname(logPath);
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify(withTs) + "\n";
      await appendFile(logPath, line, "utf8");
    } catch {
      // Logging errors must never surface to the operator or break the session.
    }
  };
}

// ---------------------------------------------------------------------------
// Audit command helper
// ---------------------------------------------------------------------------

function tailLines(filePath: string, n: number): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trimEnd().split("\n");
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Policy is loaded lazily on session_start (so ctx.cwd is available).
  // We keep a module-level reference so all hooks close over it.
  let policy: GuardPolicy | null = null;
  let log: LogFn | null = null;

  // -------------------------------------------------------------------------
  // session_start — load policy, set status badge
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    policy = loadPolicy(ctx.cwd);
    const auditLogPath = path.resolve(ctx.cwd, policy.auditLogPath);
    log = createAuditLogger(auditLogPath);

    await log({
      ts: new Date().toISOString(),
      guard: "system",
      type: "session-start",
    });

    const parts: string[] = [];
    if (policy.secretGuard.enabled) parts.push("env");
    if (policy.actionGuard.enabled) parts.push("action");
    const label = parts.length > 0 ? parts.join("+") : "off";

    ctx.ui.setStatus(
      "agent-guard",
      ctx.ui.theme.fg("accent", `🛡 guard:${label}`),
    );
  });

  // -------------------------------------------------------------------------
  // session_shutdown — clear status badge
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, ctx) => {
    if (log) {
      await log({
        ts: new Date().toISOString(),
        guard: "system",
        type: "session-shutdown",
      });
    }
    ctx.ui.setStatus("agent-guard", undefined);
  });

  // -------------------------------------------------------------------------
  // tool_call — bash: block catastrophic commands + optional env preamble
  //             read/write/edit: path guard via enforcePathGuard
  // -------------------------------------------------------------------------
  pi.on("tool_call", async (event, ctx) => {
    // Policy may not be loaded yet if tool_call fires before session_start
    // (should not happen in practice, but guard defensively).
    if (!policy) return undefined;

    // --- Bash ---
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command as string;

      // 1. Check for catastrophic commands BEFORE mutating the command string.
      if (policy.actionGuard.enabled) {
        const check = checkAction(command, policy);
        if (check.blocked) {
          await log?.({
            ts: new Date().toISOString(),
            guard: "actionGuard",
            type: "action-blocked",
            command,
            reason: check.reason,
          });
          return { block: true, reason: check.reason };
        }
      }

      // 2. Prepend env-unset preamble (currently disabled; helper returns "").
      if (policy.secretGuard.enabled) {
        const preamble = buildUnsetPreamble(policy);
        if (preamble) {
          event.input.command = preamble + "\n" + command;
          await log?.({
            ts: new Date().toISOString(),
            guard: "secretGuard",
            type: "env-preamble-prepended",
            toolName: "bash",
          });
        }
      }

      return undefined;
    }

    // --- File tools: path guard ---
    if (["read", "write", "edit"].includes(event.toolName)) {
      const inputPath = (event.input as { path?: string }).path;
      if (inputPath && log) {
        // Check the classification first so we can show a UI notification for
        // warn-only paths (enforcePathGuard logs the event but does not notify).
        const absolutePath = resolveInputPath(inputPath, ctx.cwd);
        const verdict = classifyPath(absolutePath, policy);

        const result = await enforcePathGuard(
          event.toolName,
          inputPath,
          ctx.cwd,
          policy,
          log,
        );

        if (result) {
          // Hard-blocked — return the block immediately.
          return result;
        }

        // Warn-only — allow through but notify the operator.
        if (verdict === "warn-only" && ctx.hasUI) {
          ctx.ui.notify(
            `⚠ agent-guard: accessing sensitive path "${inputPath}"`,
            "warning",
          );
        }
      }
    }

    return undefined;
  });

  // -------------------------------------------------------------------------
  // user_bash — prepend env-unset preamble for !cmd / !!cmd
  //             (currently disabled; helper returns an empty string)
  // -------------------------------------------------------------------------
  pi.on("user_bash", (_event, __ctx) => {
    if (!policy || !policy.secretGuard.enabled) return undefined;

    const preamble = buildUnsetPreamble(policy);
    if (!preamble) return undefined;

    const local = createLocalBashOperations();
    const operations: BashOperations = {
      exec(command, cwd, options) {
        return local.exec(preamble + "\n" + command, cwd, options);
      },
    };
    return { operations };
  });

  // -------------------------------------------------------------------------
  // tool_result — output redaction
  //
  // Scans the text content of each guarded tool result for secret-looking
  // material and replaces matches with [REDACTED:<label>] placeholders before
  // the content is committed to session history.
  //
  // Each content block is redacted independently so that non-text blocks
  // (images, etc.) are preserved unchanged.  Returns undefined when no
  // redactions were made so the original content is committed as-is.
  // -------------------------------------------------------------------------
  pi.on("tool_result", async (event, _ctx) => {
    if (!policy) return undefined;
    if (!["bash", "read", "write", "edit"].includes(event.toolName)) return undefined;

    type ContentBlock = { type: string; text?: string; [key: string]: unknown };

    let totalCount = 0;
    const newContent = (event.content as ContentBlock[]).map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const { redacted, count } = redactContent(block.text, policy!);
      totalCount += count;
      return count > 0 ? { ...block, text: redacted } : block;
    });

    if (totalCount === 0) return undefined;

    await log?.({
      ts: new Date().toISOString(),
      guard: "secretGuard",
      type: "redacted",
      toolName: event.toolName,
      count: totalCount,
    });

    return { content: newContent };
  });

  // -------------------------------------------------------------------------
  // /agent-guard command
  // -------------------------------------------------------------------------
  pi.registerCommand("agent-guard", {
    description: "Show agent-guard status, policy summary, and recent audit log",
    handler: async (_args, ctx) => {
      if (!policy) {
        ctx.ui.notify("agent-guard: policy not yet loaded (no active session).", "warning");
        return;
      }

      const auditLogPath = path.resolve(ctx.cwd, policy.auditLogPath);
      const recentLines = tailLines(auditLogPath, 30);

      const lines: string[] = [
        "━━━ agent-guard status ━━━",
        "",
        `secretGuard : ${policy.secretGuard.enabled ? "enabled" : "disabled"}`,
        `  strip patterns : ${policy.secretGuard.stripEnvPatterns.length}`,
        `  preserve vars  : ${policy.secretGuard.preserveEnvVars.length}`,
        `  hard-block paths: ${policy.secretGuard.hardBlockPaths.length}`,
        `  warn-only paths : ${policy.secretGuard.warnOnlyPaths.length}`,
        `  redaction rules : ${policy.secretGuard.redactionPatterns.length}`,
        "",
        `actionGuard : ${policy.actionGuard.enabled ? "enabled" : "disabled"}`,
        `  catastrophic patterns: ${policy.actionGuard.catastrophicPatterns.length}`,
        `    ${policy.actionGuard.catastrophicPatterns.map((p) => p.label).join(", ")}`,
        "",
        `auditLog : ${policy.auditLogPath}`,
        "",
        "━━━ recent audit events (last 30) ━━━",
      ];

      if (recentLines.length === 0) {
        lines.push("  (no events yet)");
      } else {
        for (const raw of recentLines) {
          try {
            const ev = JSON.parse(raw) as AuditEvent;
            lines.push(`  [${ev.ts}] ${ev.guard}/${ev.type}${ev.reason ? `: ${ev.reason}` : ""}${ev.command ? ` cmd=${ev.command.slice(0, 60)}` : ""}${ev.path ? ` path=${ev.path}` : ""}`);
          } catch {
            lines.push(`  ${raw}`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
