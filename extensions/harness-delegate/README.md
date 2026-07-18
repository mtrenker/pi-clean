# Harness Delegate

Delegate a prompt from pi to an installed first-party CLI harness and stream the harness activity back into pi.

Currently supported:

- `claude` → Claude Code CLI
- `codex` → Codex CLI

This is useful when you want pi to orchestrate work but need the actual execution to happen through the vendor CLI tied to your subscription, instead of through a paid API key route.

## What it does

- exposes a `delegate_harness` tool to pi
- spawns `claude` or `codex` as a subprocess
- uses each CLI's JSON streaming mode
- renders live progress inline in pi
- returns the final result back to the main pi turn

## Defaults

### Claude Code

The extension runs Claude Code in print/JSON streaming mode with:

- `--no-session-persistence`
- `--verbose`
- `--output-format stream-json`
- `--permission-mode bypassPermissions`

The prompt is passed over stdin.

### Codex

The extension runs Codex with:

- `exec`
- `--json`
- `--ephemeral`
- `--skip-git-repo-check`
- `-C <cwd>`
- `--full-auto` by default

The prompt is passed as the final CLI argument.

## Tool parameters

- `provider`: `claude` or `codex`
- `prompt`: delegated task
- `cwd?`: working directory override
- `model?`: optional model override
- `reasoning?`: optional reasoning/effort level (`low`, `medium`, `high`, `xhigh`, `max`); Claude uses `--effort`, Codex uses `model_reasoning_effort` (`max` maps to `xhigh`)
- `appendSystemPrompt?`: Claude-only extra system prompt
- `allowedTools?`: Claude-only tool allow-list
- `permissionMode?`: Claude permission mode override
- `sandbox?`: Codex sandbox mode override (`read-only`, `workspace-write`, `danger-full-access`)
- `extraArgs?`: raw extra CLI args for advanced usage; appended after pi-clean defaults and first-class `reasoning`, so it can still override advanced CLI settings

## Usage examples

Ask pi things like:

- `Use Claude Code directly to investigate the auth flow and report back.`
- `Delegate this refactor to Codex and show me progress as it runs.`
- `Run Claude Code in read-only spirit with allowedTools ["Bash", "Read"] and summarize findings.`

You can also inspect installed harnesses with:

- `/harnesses`

## Flightdeck telemetry

When the package's [Flightdeck extension](../flightdeck/README.md) is loaded, every delegated process attempt emits one best-effort child-task lifecycle. Set `FLIGHTDECK_TELEMETRY_FILE` before starting Pi to append Flightdeck-compatible JSONL. Prompts, streamed output, tool data, and stderr are never included.

## Notes

- This extension assumes `claude` and/or `codex` are already installed and authenticated locally.
- It is intentionally single-delegation focused. Use one bounded issue and worktree at a time so the delegated result remains reviewable.
