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
| **actionGuard / shadow classifier** | Off by default. Sends each call the guards above allow to a classifier model in the background and logs `routine`, `review` or `block`. Never blocks, prompts or delays a call ([details](#shadow-classifier)) |

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
| `…+shadow` | The shadow classifier is enabled and its model was found at session start |

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

classifier : shadow via voyager-classifiers/clef
  this session: routine 112, review 3, block 1, skipped 4, errors 0
  log: ~/.pi/agent/agent-guard-classifier.jsonl

auditLog : ~/.pi/agent/agent-guard-audit.jsonl

━━━ recent audit events (last 30) ━━━
  [2026-04-23T12:01:15.432Z] actionGuard/action-blocked: rm-rf-root blocked … cmd=rm -rf /
  [2026-04-23T12:02:30.000Z] secretGuard/path-blocked path=~/.ssh/id_rsa
  [2026-04-23T12:03:00.000Z] secretGuard/redacted
```

**What each event type means:**

| `guard/type` | Policy bucket | Trigger |
|-------------|--------------|---------|
| `actionGuard/action-blocked` | `actionGuard.catastrophicPatterns` | A bash command matched a catastrophic pattern and was rejected |
| `secretGuard/env-preamble-prepended` | `secretGuard.stripEnvPatterns` | Reserved historical event type from the earlier env-unset implementation; not expected while env stripping is disabled |
| `secretGuard/path-blocked` | `secretGuard.hardBlockPaths` | A file-tool call was hard-blocked (access denied) |
| `secretGuard/path-warned` | `secretGuard.warnOnlyPaths` | A file-tool call was allowed but flagged as sensitive |
| `secretGuard/redacted` | `secretGuard.redactionPatterns` | Secret-shaped text found in tool output and replaced |

### 3 — Audit log file

Actionable guard events are written as JSON lines to a global user log by default:

```
~/.pi/agent/agent-guard-audit.jsonl
```

This avoids creating `.pi/agent-guard-audit.jsonl` inside every project just because a pi session was opened. The path can be overridden globally or per-project by setting `auditLogPath` in `~/.pi/agent/agent-guard.json` or `.pi/agent-guard.json` (see [Policy configuration](#policy-configuration) below). Absolute paths are used as-is, `~/...` paths resolve relative to the home directory, and relative paths resolve against the session cwd.

**Log entry shape:**

```jsonc
{
  "ts": "2026-04-23T12:34:56.789Z",   // ISO-8601 timestamp
  "guard": "actionGuard" | "secretGuard",
  "type": "action-blocked" | "env-preamble-prepended" | "path-blocked"
         | "path-warned" | "redacted",
  "toolName": "bash",    // present for tool-level events
  "command": "…",        // present for bash events (first 60 chars shown in /agent-guard)
  "path": "…",           // present for path-guard events
  "reason": "…",         // present when something was blocked (names the pattern label)
  "count": 3             // present for redaction events (number of replacements)
}
```

**Tail recent events from the shell:**

```sh
tail -f ~/.pi/agent/agent-guard-audit.jsonl
```

**Pretty-print with jq:**

```sh
# All blocked events
jq 'select(.type == "action-blocked" or .type == "path-blocked")' \
  ~/.pi/agent/agent-guard-audit.jsonl

# All redaction events
jq 'select(.type == "redacted")' ~/.pi/agent/agent-guard-audit.jsonl

# Events from the current hour
jq --arg h "$(date -u +%Y-%m-%dT%H)" 'select(.ts | startswith($h))' \
  ~/.pi/agent/agent-guard-audit.jsonl
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
  "auditLogPath": "~/logs/agent-guard-audit.jsonl"
}
```

Use a relative path only when you intentionally want per-project logs.

**Current env-stripping status:**

Env stripping is intentionally disabled for now.

`secretGuard.stripEnvPatterns` and `preserveEnvVars` remain in the policy
schema for future compatibility, but no `unset ...` preamble is currently
prepended to bash commands.

See `docs/agent-guard/02-policy.md` for the full schema.

---

## Shadow classifier

An opt-in second opinion on tool calls, to measure how a local decision model
would judge real work before anything enforces its verdicts. It is an extra
signal, not a sandbox or a guarantee; `routine` does not mean safe.

**Opt in** in the global file `~/.pi/agent/agent-guard.json`, naming a
classifier model Pi already knows (for example one registered by a personal
extension, or a llama.cpp router):

```json
{ "actionGuard": { "classifier": { "enabled": true, "provider": "voyager-classifiers", "model": "clef" } } }
```

`actionGuard.classifier` is read from the global file only. A project's
`.pi/agent-guard.json` can set `"classifier": { "enabled": false }` and nothing
else, so a cloned repository cannot opt you in or send arguments elsewhere.
`actionGuard.enabled: false` also turns it off. Requires Pi 1.1.0 or later;
on older Pi it reports itself unavailable once per session.

**What it sees:** the tool name, the tool arguments and the cwd, plus a fixed
policy text. Secret-shaped strings are redacted first (the same patterns as
output redaction, so nothing when `secretGuard` is off). Strings over 1,000
characters keep their first and last 500; an input still over 2,000 characters
is skipped. It never sees session history, the prompt, tool results or file
contents, so it judges the action, not whether you asked for it. Operator
`!cmd` and calls already blocked by agent-guard are not classified.

**Behavior:** one request in flight per session, up to 8 waiting, 10 s
timeout, no retries. A `block` verdict shows a warning after the call, which
has usually already run. Failures (`error`, `malformed`, `aborted`, `skipped`
with reason `oversized`, `invalid-input` or `queue-full`, `unavailable`) are
logged as such and never counted as `routine`.

**Log:** one JSON line per call in `~/.pi/agent/agent-guard-classifier.jsonl`
(`actionGuard.classifier.logPath`), separate from the audit log, not rotated,
safe to delete. Lines carry `prompt`, `toolName`, `toolCallId`, `outcome`,
`label`, rounded `probabilities`, `truncated`, `inputChars`, `inputTokens`,
`waitMs` and `latencyMs`. Only `review` and `block` lines include a 200-character
excerpt of the redacted input; use `toolCallId` to find a `routine` call in the
session file.

```sh
jq 'select(.label == "block" or .label == "review")' ~/.pi/agent/agent-guard-classifier.jsonl
```

**Prompt:** the question, labels and policy text are constants in
`classifier.ts`; changing them bumps `PROMPT_VERSION`. The current `v2`
differs from the evidence-run prompt in #62 (`v1`) only by dropping "deletes
project build output" from the `review` label, which contradicted the policy
sentence calling that routine. The synthetic measurements in #62 were taken
with v1 and are not evidence of accuracy on real traffic, which is what the
log is for.

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
| `classifier.ts` | Shadow classifier: prompt constants, state building, queue, verdict log |

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
| Audit log path | `~/.pi/agent/agent-guard-audit.jsonl` |
| Shadow classifier | Off; log `~/.pi/agent/agent-guard-classifier.jsonl` |

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
| Shadow classifier only observes | Its verdicts are logged and never block. Probabilities are uncalibrated, opaque scripts and obfuscated code were coin flips in testing, and harm in the omitted middle of a long argument is not seen. |
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
