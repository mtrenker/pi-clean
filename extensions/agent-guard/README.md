# Agent Guard Extension

Agent Guard is a pi coding-agent extension that protects sessions from
accidental secret leakage, path access violations, and catastrophic shell
commands. It runs transparently in the background and surfaces its status
through a footer badge, an in-session command, and a persistent audit log.

---

## Quick start

The extension activates automatically when pi loads it. You will see a badge
in the session footer:

```
🛡 guard:env+action
```

`env` means the secretGuard bundle is active (path protection, output
redaction, and related secret-guard behavior). `action` means
catastrophic-command blocking is active. `off` means both guards are
disabled (only possible if you have explicitly set `enabled: false` in your
policy file).

---

## What the extension guards

| Guard | What it does |
|-------|-------------|
| **secretGuard / env** | Env stripping is currently disabled; this guard slot is reserved for a future redesign of secret injection / filtering |
| **secretGuard / path** | Hard-blocks reads/writes to sensitive paths (e.g. `~/.ssh/id_*`); warns for less-sensitive paths (e.g. `**/.env`) |
| **secretGuard / redaction** | Scans tool output for secret-shaped strings and replaces them with `[REDACTED:<label>]` |
| **actionGuard** | Immediately blocks catastrophic shell commands (`rm -rf /`, fork bombs, `mkfs`, …) without prompting |

---

## How to inspect guard activity

### 1 — Status badge (always visible)

The footer badge `🛡 guard:<mode>` is shown for the entire session:

| Badge text | Meaning |
|-----------|---------|
| `🛡 guard:env+action` | Both secretGuard and actionGuard are enabled (default) |
| `🛡 guard:env` | secretGuard enabled, actionGuard disabled |
| `🛡 guard:action` | actionGuard enabled, secretGuard disabled |
| `🛡 guard:off` | Both guards disabled |

The badge disappears at session shutdown.

### 2 — Operator command: `/agent-guard`

Type `/agent-guard` at the pi prompt at any time during a session to get a
snapshot of the current policy and the last 30 audit events:

```
━━━ agent-guard status ━━━

secretGuard : enabled
  strip patterns : 7
  preserve vars  : 2
  hard-block paths: 6
  warn-only paths : 4
  redaction rules : 6

actionGuard : enabled
  catastrophic patterns: 9
    rm-rf-root, rm-rf-home, fork-bomb, dd-to-block-device, …

auditLog : .pi/agent-guard-audit.jsonl

━━━ recent audit events (last 30) ━━━
  [2026-04-23T12:00:01.000Z] system/session-start
  [2026-04-23T12:01:15.432Z] actionGuard/action-blocked: rm-rf-root blocked … cmd=rm -rf /
  [2026-04-23T12:02:30.000Z] secretGuard/path-blocked path=~/.ssh/id_rsa
  [2026-04-23T12:03:00.000Z] secretGuard/redacted
```

**What each event type means:**

| `guard/type` | Policy bucket | Trigger |
|-------------|--------------|---------|
| `system/session-start` | — | Session opened; guard loaded |
| `system/session-shutdown` | — | Session closed normally |
| `actionGuard/action-blocked` | `actionGuard.catastrophicPatterns` | A bash command matched a catastrophic pattern and was rejected |
| `secretGuard/env-preamble-prepended` | `secretGuard.stripEnvPatterns` | Reserved historical event type from the earlier env-unset implementation; not expected while env stripping is disabled |
| `secretGuard/path-blocked` | `secretGuard.hardBlockPaths` | A file-tool call was hard-blocked (access denied) |
| `secretGuard/path-warned` | `secretGuard.warnOnlyPaths` | A file-tool call was allowed but flagged as sensitive |
| `secretGuard/redacted` | `secretGuard.redactionPatterns` | Secret-shaped text found in tool output and replaced |

### 3 — Audit log file

All guard events are written as JSON lines to:

```
<project-root>/.pi/agent-guard-audit.jsonl
```

The path is relative to `ctx.cwd` (the working directory of the pi session).
It can be overridden per-project by setting `auditLogPath` in
`.pi/agent-guard.json` (see [Policy configuration](#policy-configuration) below).

**Log entry shape:**

```jsonc
{
  "ts": "2026-04-23T12:34:56.789Z",   // ISO-8601 timestamp
  "guard": "actionGuard" | "secretGuard" | "system",
  "type": "action-blocked" | "env-preamble-prepended" | "path-blocked"
         | "path-warned" | "redacted" | "session-start" | "session-shutdown",
  "toolName": "bash",    // present for tool-level events
  "command": "…",        // present for bash events (first 60 chars shown in /agent-guard)
  "path": "…",           // present for path-guard events
  "reason": "…",         // present when something was blocked (names the pattern label)
  "count": 3             // present for redaction events (number of replacements)
}
```

**Tail recent events from the shell:**

```sh
tail -f .pi/agent-guard-audit.jsonl
```

**Pretty-print with jq:**

```sh
# All blocked events
jq 'select(.type == "action-blocked" or .type == "path-blocked")' \
  .pi/agent-guard-audit.jsonl

# All redaction events
jq 'select(.type == "redacted")' .pi/agent-guard-audit.jsonl

# Events from the current hour
jq --arg h "$(date -u +%Y-%m-%dT%H)" 'select(.ts | startswith($h))' \
  .pi/agent-guard-audit.jsonl
```

---

## Policy configuration

The active policy is the merge of (highest to lowest precedence):

1. `<project-root>/.pi/agent-guard.json` — project-level overrides
2. `~/.pi/agent/agent-guard.json` — user-level overrides
3. Hardcoded defaults in `policy.ts`

**Minimal example — disable actionGuard for a project:**

```json
{
  "actionGuard": { "enabled": false }
}
```

**Custom audit log path:**

```json
{
  "auditLogPath": "logs/agent-guard-audit.jsonl"
}
```

**Current env-stripping status:**

Env stripping is intentionally disabled for now.

`secretGuard.stripEnvPatterns` and `preserveEnvVars` remain in the policy
schema for future compatibility, but no `unset ...` preamble is currently
prepended to bash commands.

See `docs/agent-guard/02-policy.md` for the full schema.

---

## Source layout

| File | Responsibility |
|------|---------------|
| `index.ts` | Extension entry point — wires all hooks and the `/agent-guard` command |
| `policy.ts` | Policy contract, defaults, and config merging |
| `env.ts` | `buildUnsetPreamble` / `buildFilteredEnv` |
| `action-guard.ts` | `checkAction` — catastrophic command blocking |
| `path-guard.ts` | `enforcePathGuard` / `classifyPath` — path access control |
| `redaction.ts` | `redactContent` — secret redaction in tool output |

---

## Goals

Agent Guard is designed to be a **low-friction, always-on safety layer** for
coding agent sessions:

- **Zero false positives on normal coding work** — compiling, testing, git,
  npm, and file edits all pass through without any interruption.
- **Hard blocks on catastrophic or irreversible operations** — disk wipe,
  `rm -rf /`, fork bombs, and filesystem format commands are rejected
  immediately.
- **Transparent secret hygiene** — secret-shaped strings in tool output are
  replaced before entering session history, and sensitive file paths remain
  protected. Env stripping is intentionally disabled for now pending a safer
  redesign.
- **Auditability** — every guard event is written to a structured JSONL log
  and surfaced through the `/agent-guard` operator command.

---

## Defaults

| Setting | Default value |
|---------|---------------|
| `secretGuard.enabled` | `true` |
| `actionGuard.enabled` | `true` |
| Strip env patterns | 7 (AWS, Anthropic, GitHub, OpenAI, DATABASE\_URL, `_SECRET`, `_TOKEN`, `_KEY`, `_PASSWORD` suffixes) |
| Preserved env vars | Policy field retained for future compatibility; currently not applied because env stripping is disabled |
| Hard-blocked paths | `~/.ssh/id_*`, `~/.aws/credentials`, `~/.netrc`, `**/.env`, `**/.env.local`, `**/.env.*.local`, GPG private keys, age keys, password-store |
| Warn-only paths | `~/.ssh/config`, `~/.ssh/known_hosts`, `~/.aws/config`, `**/.env.production`, `**/.env.staging`, `**/.env.development`, `**/.env.test` |
| Catastrophic patterns | 9: `rm-rf-root`, `rm-rf-home`, `fork-bomb`, `dd-to-block-device`, `stdout-to-block-device`, `mkfs`, `format-disk-mac`, `shred-root`, `chmod-777-root` |
| Redaction patterns | 6: `aws-access-key-id`, `anthropic-api-key`, `openai-api-key`, `github-pat`, `generic-api-key` (covers multiple token formats) |
| Audit log path | `.pi/agent-guard-audit.jsonl` (relative to session `cwd`) |

---

## Limitations

The following are **known MVP limitations** — not bugs, and not silently
accepted gaps, but explicitly scoped-out items:

| Limitation | Detail |
|-----------|--------|
| Shell obfuscation not blocked | Commands like `echo cm0gLXJmIC8= \| base64 -d \| bash` bypass the pattern guard. Requires shell AST parsing (deferred). |
| Secrets in command arguments not stripped | `curl -H "Authorization: Bearer sk-ant-…"` — the secret lives in an argument string, not an env var. Requires POSIX shell AST parsing (deferred). |
| Symlink escape not detected | A symlink pointing outside the guarded path patterns is not resolved before classification. |
| Case-sensitive on Linux | `~/.SSH/id_rsa` (uppercase SSH) is not caught on Linux (minimatch default). |
| `echo mkfs` is blocked | The `\bmkfs\b` pattern is intentionally conservative; any command containing `mkfs` as a standalone word is blocked. |
| `~/.ssh/id_rsa.pub` is blocked | The `id_*` glob matches public keys too. Operators can add an exception in `.pi/agent-guard.json`. |
| Env stripping disabled | Secret env vars are currently passed through unchanged; a safer allowlist / capability-based design is planned. |
| No OS-level sandboxing | The guard uses pattern matching, not kernel-level isolation. A sandbox (`bwrap`, `seccomp`, `sandbox-exec`) is a planned future upgrade. |

---

## Further reading

- `docs/agent-guard/01-architecture.md` — overall design and hook lifecycle
- `docs/agent-guard/02-policy.md` — full policy schema reference
- `docs/agent-guard/03-bash-guard-notes.md` — env filtering and action blocking details
- `docs/agent-guard/04-path-guard-notes.md` — path classification and enforcement
- `docs/agent-guard/05-redaction-notes.md` — output redaction details
- `docs/agent-guard/07-test-matrix.md` — full test coverage matrix (169 tests)
- `docs/agent-guard/08-validation.md` — **real-world workflow validation note** (Task 008)
