# Agent launch profiles

Owner: Claude Opus 5. This document is the durable design for how this repository starts
interactive Claude, Codex, and Pi sessions. Implementation follows it; when the two disagree, the
code is wrong until this document is revised.

## Problem

Launch settings were duplicated. `scripts/github-work.mjs` pinned Opus and Sol in
`managedAgentCommand`, the `interactive-agent-sessions` skill repeated the same flags as prose and
shell recipes, and `docs/github-workflow.md` still described the removed Codex `--full-auto` alias.
`start-issue` defaulted to `pi`, whose model, effort, and tool policy come from personal settings,
while the skill named Claude Opus 5 as the default development model. Nothing stated whether a
worker may spawn its own workers.

## Single source of truth

`scripts/agent-profiles.mjs` holds every executable launch setting: program, model, effort range and
default, permission or sandbox flags, and the native-delegation control. Nothing else may spell a
model name or a permission flag.

- `scripts/github-work.mjs` imports the module for managed issue authors and PR reviewers.
- Skill recipes and ad-hoc launches read the same strings through
  `node scripts/github-work.mjs launch-command --profile <id> [--effort <level>] --prompt <text>`,
  which prints one shell command on stdout.
- `node scripts/github-work.mjs profiles` prints the resolved table as JSON for inspection and for
  documentation checks.

A recipe that hand-writes `claude --model ...` is a defect, not a shortcut.

## Profiles and defaults

| Profile | Program | Model | Default effort | Execution | Native delegation |
| --- | --- | --- | --- | --- | --- |
| `claude-opus` | `claude` | `claude-opus-5` | `high` | `--permission-mode bypassPermissions` | disabled |
| `claude-fable` | `claude` | `claude-fable-5-1` | `high` | `--permission-mode bypassPermissions` | disabled |
| `codex-sol-write` | `codex` | `gpt-5.6-sol` | `high` | `--ask-for-approval never --sandbox workspace-write` | disabled |
| `codex-sol-read` | `codex` | `gpt-5.6-sol` | `medium` | `--ask-for-approval never --sandbox read-only` | disabled |
| `pi-ambient` | `pi` | ambient | ambient | ambient | not applicable |

Helper defaults:

- `start-issue` defaults to `--agent claude`, which resolves to `claude-opus`. The previous `pi`
  default is now an explicit opt-in.
- `review-pr` keeps `--reviewer claude`, also `claude-opus`.
- `--agent none` still creates the worktree without starting an agent.
- Managed launches use the profile's default effort. For a different effort, create the worktree with
  `--agent none` and launch the root pane with `launch-command --effort <level>`.

`claude-fable` is reachable through `launch-command` only. Coordination is a selective choice for
parallel or long-running work, so no helper command defaults to it, and no launch path assigns work
to both vendors by default.

Model and effort are pinned per launch. Fable is pinned to `claude-fable-5-1`; the bare `fable`
alias is rejected because it resolves differently through the apps gateway.

## Effort

Claude accepts `low`, `medium`, `high`, `xhigh`, `max`. Codex accepts those plus `ultra`. Pi is
ambient and takes no effort argument from this repository.

The profile module validates the requested effort against the profile's own set and fails before
launch. Handling of an unrecognized value inside each CLI is version-dependent, so an unsupported
value never reaches it. Delegation settings do not vary with effort: the same control is applied at
`low` and at `ultra`.

## Native delegation

Managed sessions must not spawn their own hidden workers. Delegation stays visible in Herdr as
panes and tabs a human can read, interrupt, and resume, because operator repair time, not model
throughput, is the binding constraint.

What each profile actually does, verified against Claude Code 2.1.266, Codex CLI 0.153.4, and Herdr
0.8.2 on 2026-09-09:

- Codex: `--disable multi_agent`, equivalent to `-c features.multi_agent=false`. Verified with
  `codex --disable multi_agent features list`, which reports `multi_agent stable false` while the
  unoverridden default is `true` at every effort level. An unknown feature name exits non-zero with
  `Unknown feature flag`, so a typo fails visibly.
- Claude: `--settings '{"disabledBuiltinTools":["Task"]}'`. `Task` is the internal name of the
  subagent tool in this build; the CLI describes `--append-subagent-system-prompt` as applying to
  "every Task-tool subagent". `disabledBuiltinTools` removes a built-in tool instead of denying it
  through the permission system, which is why it is used rather than a deny rule that
  `--permission-mode bypassPermissions` would skip. Malformed `--settings` JSON exits non-zero; a
  settings JSON string is accepted, checked with `claude --settings '{"disabledBuiltinTools":["Task"]}' doctor`.
- Pi: no control, because Pi ships no sub-agents. Its own documentation says so and suggests
  spawning separate `pi` instances instead.

### Enforcement limits

These are boundaries, not guarantees. State them this way in any report:

- Claude's removal of `Task` could not be verified end to end without starting a paid session, and
  an unrecognized settings key would fail silently. The prompt text carries the binding instruction;
  the setting is a second layer.
- Every profile keeps a shell. Any of them could start another agent through `bash`, and no flag
  here prevents that.
- Codex `workspace-write` and Claude `bypassPermissions` limit prompting, not the host. A worktree
  isolates Git state, not the machine.
- Neither profile authorizes a remote mutation. Publishing, approving, merging, pushing, and
  deleting branches still need Martin's explicit approval.

## Compatibility assumptions

- Claude Code 2.1.266, Codex CLI 0.153.4, Herdr 0.8.2, `HERDR_ENV=1`, and Herdr 0.7.3 or newer for
  the native worktree API.
- Herdr lifecycle commands used by recipes: `herdr pane current`, `pane split`, `pane rename`,
  `pane run`, `pane wait-output`, `tab create`, `agent wait`. `herdr wait` no longer exists.
- The external `herdr` skill under `~/.agents/skills/` is stale and still documents `herdr wait`.
  Refreshing it is an operator action: `herdr --skill` prints the current version. This repository
  neither edits nor ships that file.
- Version drift is expected. A flag that disappears makes the launch fail visibly rather than
  silently degrade to a different model, effort, permission mode, or delegation right.

## Tradeoffs

- Defaulting `start-issue` to Opus costs more per issue than the ambient Pi default and gives a
  reproducible launch plus design ownership in the same session. Accepted; `--agent pi` remains.
- Pi stays supported but is marked ambient. Its model and effort come from personal settings, so its
  runs are not reproducible from this repository. Accepted rather than pinning Pi settings the
  repository does not own.
- Disabling native delegation removes parallel internal subagents, including read-only exploration,
  from managed sessions. Accepted: an invisible subagent produces work no human reviewed.
- `launch-command` adds a process call to each recipe. Accepted as the only way recipes and the
  helper share one source instead of two copies that drift.

## Non-goals

Model benchmarks or promotions, including Astra, Sonnet, and Terra/Luna. Host sandboxing. A
scheduler, agent framework, schema ecosystem, or telemetry service. Changes to personal settings or
external skills. Non-interactive subprocess delegation.

## Acceptance criteria

1. One module holds every launch setting, and both the helper and the skill recipes read it.
2. `start-issue` and `review-pr` defaults are stated in the helper, this document, and the skill,
   and a test asserts the resolved command.
3. No recipe or document uses `--full-auto`, `danger-full-access`, `herdr wait`, or the bare `fable`
   alias.
4. Every profile carries its delegation control at every supported effort, asserted by test.
5. An unsupported profile, effort, or agent fails with a non-zero exit and a message naming the
   supported values.
6. Documentation describes delegation control as a boundary with named limits, never as a
   guarantee.
