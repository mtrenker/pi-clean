---
name: interactive-agent-sessions
description: Start visible, focusable Claude Code or Codex TUI sessions in Herdr with predictable model, effort, permissions, prompts, orchestration, and isolation. Use for requests such as "make a fable review", "start a fable review", delegated bigger tasks, Claude or Codex review/implementation/investigation sessions, YOLO or non-prompting launches, and interactive Herdr agent sessions.
compatibility: Requires HERDR_ENV=1, Herdr 0.7.3+, Claude Code, Codex CLI, and the external herdr skill.
---

# Interactive agent sessions

Turn a short request into an operator-visible Claude or Codex TUI. This skill owns intent, launch profiles, prompt shape, and placement policy. The external `herdr` skill remains canonical for live Herdr commands and response shapes.

## Preconditions

1. Check `HERDR_ENV` before any Herdr command. If it is not exactly `1`, stop and explain that the request requires an interactive Herdr-managed pane. Do not fall back to a subprocess, background agent, or non-interactive command.
2. Load and follow the external `herdr` skill listed in the available skills. Re-read live IDs from Herdr and parse create/split responses; never guess or retain ephemeral workspace, tab, or pane IDs as durable identity.
3. Read the target repository's instructions before launching. GitHub issue and PR work must also follow the repository `github-issues` and `github-pull-requests` skills.

## Deterministic intent matrix

`make a fable review` and `start a fable review` are exact intent aliases: choose the first row without asking for routine launch settings.

| Intent | Harness and model | Effort | Local execution profile | Initial prompt |
| --- | --- | --- | --- | --- |
| Fable review | Claude `fable` | `high` | Claude bypass permissions | `REVIEW_PROMPT` |
| Delegated bigger task | Claude `fable` coordinator over Claude `claude-opus-5` and Codex `gpt-5.6-sol` | `high` | Claude bypass permissions | `DELEGATION_PROMPT` |
| Claude review | Claude `claude-opus-5` | `high` | Claude bypass permissions | `REVIEW_PROMPT` |
| Claude implementation | Claude `claude-opus-5` | `high` | Claude bypass permissions | task prompt |
| Claude investigation | Claude `claude-opus-5` | `medium` | Claude bypass permissions; prompt must prohibit edits | investigation prompt |
| Codex review | Codex `gpt-5.6-sol` | `high` | no approvals, `workspace-write` sandbox | `REVIEW_PROMPT` |
| Codex implementation | Codex `gpt-5.6-sol` | `high` | no approvals, `workspace-write` sandbox | task prompt |
| Codex investigation | Codex `gpt-5.6-sol` | `medium` | no approvals, `read-only` sandbox | investigation prompt |

Claude Opus 5 is the default and preferred development model. Use a different direct-development model only when Martin names it or repository policy requires it. When Martin asks to delegate a bigger task, or explicitly asks for Fable orchestration, launch Claude Fable as the coordinator rather than using a direct Opus or Codex implementation session. A bigger task is broad enough to benefit from multiple bounded workstreams, such as cross-cutting implementation plus independent investigation, review, or validation. Do not add orchestration to narrow work merely because it uses `high` effort. An explicit effort request overrides the matrix when the selected model supports that value.

### Review-only prompt

Substitute the concrete target and repository/PR context before launch:

```text
Review only: <TARGET>. Do not edit files or implement fixes unless Martin explicitly requests fixes in this session. Inspect the relevant issue context, full diff, tests, regressions, error handling, maintainability, and security. Return only evidence-backed findings ordered by severity. For each finding include file and line evidence, the concrete failure mode and impact, and a recommended correction. State explicitly when there are no findings. Do not publish comments, approve, merge, delete branches, or perform other protected remote mutations.
```

A review's `workspace-write` sandbox allows tools and tests to create local artifacts; it does not relax the review-only instruction. Review Git changes before declaring the session settled.

### Bigger-task delegation prompt

Substitute the concrete task and repository/issue context before launch:

```text
Coordinate this bigger task: <TASK>. Read and follow the repository instructions and relevant issue or PR context. Decompose the work into bounded, non-overlapping subtasks and orchestrate substantive work across both Claude Opus 5 (`claude-opus-5`) and GPT-5.6-sol (`gpt-5.6-sol`). Prefer Claude Opus 5 for primary development. Use GPT-5.6-sol for complementary investigation, an independent review, or validation. Keep a single writer for any shared worktree unless isolated worktrees make concurrent mutation safe. Inspect and synthesize delegated results, resolve discrepancies, run final validation, and remain accountable for the complete result. Respect repository WIP, worktree, review, and authorization rules. Do not merge or perform protected remote mutations without Martin's explicit authorization.
```

Fable is the coordinator, not a third interchangeable implementation worker. It must use both named worker models for substantive contributions, prevent overlapping writes, and verify their outputs before reporting completion. Keep the Fable coordinator visible and focusable; its internally delegated workers do not replace the operator-visible coordinator session.

## Version-sensitive launch table

Keep command details here rather than scattering variants through recipes. These flags were verified with Claude Code `2.1.220` and Codex CLI `0.144.5`. The installed Codex model metadata for `gpt-5.6-sol` advertises `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.

| Profile | Exact interactive command template |
| --- | --- |
| Claude Fable review or coordinator | `claude --model fable --effort high --permission-mode bypassPermissions "$PROMPT"` |
| Claude default development | `claude --model claude-opus-5 --effort "$EFFORT" --permission-mode bypassPermissions "$PROMPT"` |
| Codex workspace-write | `codex --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ask-for-approval never --sandbox workspace-write "$PROMPT"` |
| Codex read-only | `codex --model gpt-5.6-sol -c 'model_reasoning_effort="medium"' --ask-for-approval never --sandbox read-only "$PROMPT"` |

These are TUI entry points because no subcommand is present. For an interactive-session request, never use Claude `--print`/`-p`, `--background`/`--bg`, or `claude agents`; never use Codex `exec` or the non-interactive `codex review` command. Do not redirect or pipe the agent's TUI.

Do not use the removed Codex `--full-auto` alias. On the verified CLI, spell its safe intent as `--ask-for-approval never --sandbox workspace-write`. Do not use `--dangerously-bypass-approvals-and-sandbox` or `--sandbox danger-full-access`; worktree isolation is not a host sandbox.

### Effort policy

| Task complexity | Claude | Codex | Use when |
| --- | --- | --- | --- |
| Narrow and obvious | `low` | `low` | One-file lookup, simple reproduction, or tightly bounded question |
| Routine focused work | `medium` | `medium` | Default investigation or small, well-understood change |
| Substantial | `high` | `high` | Default implementation and review with meaningful cross-file reasoning |
| Difficult | `xhigh` | `xhigh` | Difficult architecture, debugging, concurrency, migration, or high-risk review |
| Exceptional | `max` | `max` | The hardest ambiguous or safety-critical work after deciding `xhigh` is insufficient |

Codex `ultra` is stronger than the cross-harness table and enables automatic task delegation. Use it only when Martin explicitly asks for `ultra` or delegated Codex work; never make it a routine default. Unsupported values must fail visibly rather than silently falling back.

## Permissions are not authorization

“YOLO” means only the exact local prompt-suppression profile:

- Claude: `--permission-mode bypassPermissions`. This bypasses Claude checks and provides no host sandbox.
- Codex: `--ask-for-approval never` plus the named `read-only` or `workspace-write` sandbox. `workspace-write` limits model-generated commands but still permits mutations in the worktree.

Neither profile authorizes publishing a review, approving or merging a PR, pushing, deleting branches, closing issues, releasing, or any other protected remote mutation. Those actions still require Martin's explicit authorization. Prompt injection and mistaken commands remain risks.

## Placement policy

| Work | Placement | Filesystem rule |
| --- | --- | --- |
| Bounded same-context investigation | Sibling pane in the current tab | Read-only; sharing the checkout must be safe |
| Separate read-only subcontext in the same worktree | Named tab in the current workspace | Still shares the worktree; a tab is not isolation |
| Issue implementation or any mutation | Dedicated issue worktree and semantic Herdr workspace | Use `scripts/github-work.mjs start-issue`; never mutate from a sibling pane |
| Independent PR review | Detached review worktree and semantic Herdr workspace | Use `scripts/github-work.mjs review-pr`; never review in the author worktree |

Use labels such as `pi-clean · #26 · interactive sessions` and `pi-clean · PR #42 · review/codex`. Tabs are only subcontexts within one worktree, never substitutes for worktree isolation.

Start the TUI with its initial prompt in the created terminal. Focus the new pane, tab, or workspace for direct interaction unless Martin asks to keep the current focus. Report the semantic workspace, tab, and pane label after launch; IDs may be included only as current routing handles.

Do not replace direct interaction with coordinator polling. The session must remain visible so Martin can inspect, interrupt, and continue it. If Martin asks to stay in the current pane, launch with no focus, report the location immediately, and leave the new terminal visible and focusable.

## Recipes

Resolve `../../scripts/github-work.mjs` relative to this skill directory and use its absolute path when worktree management is required.

### Fable review in a safe shared checkout

Use only when the target can be reviewed without filesystem mutation:

```bash
REVIEW_PROMPT='Review only: the current change. Do not edit files or implement fixes unless Martin explicitly requests fixes in this session. Return only evidence-backed findings ordered by severity, with file and line evidence, concrete failure mode and impact, and a recommended correction. State explicitly when there are no findings. Do not publish comments, approve, merge, delete branches, or perform other protected remote mutations.'
CURRENT_PANE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
NEW_PANE=$(herdr pane split "$CURRENT_PANE" --direction right --cwd "$PWD" --focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane rename "$NEW_PANE" 'Fable · review'
herdr pane run "$NEW_PANE" "claude --model fable --effort high --permission-mode bypassPermissions $(printf %q "$REVIEW_PROMPT")"
```

### Codex review in a safe shared checkout

```bash
REVIEW_PROMPT='Review only: the current change. Do not edit files or implement fixes unless Martin explicitly requests fixes in this session. Return only evidence-backed findings ordered by severity, with file and line evidence, concrete failure mode and impact, and a recommended correction. State explicitly when there are no findings. Do not publish comments, approve, merge, delete branches, or perform other protected remote mutations.'
CURRENT_PANE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
NEW_PANE=$(herdr pane split "$CURRENT_PANE" --direction right --cwd "$PWD" --focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane rename "$NEW_PANE" 'Codex · review'
herdr pane run "$NEW_PANE" "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"high\"' --ask-for-approval never --sandbox workspace-write $(printf %q "$REVIEW_PROMPT")"
```

For an independent PR review, do not use either shared-checkout recipe. Run the repository helper with the requested reviewer so it creates the detached review worktree and dedicated semantic workspace:

```bash
node /absolute/path/to/pi-clean/scripts/github-work.mjs review-pr 42 --reviewer codex
```

Then focus and report the returned semantic workspace. The review-only authorization boundary still applies; never publish or merge the review without explicit approval.

### Focused read-only investigation

```bash
PROMPT='Investigate why the parser rejects empty input. Read only: do not edit files. Report evidence, likely cause, and the smallest safe correction.'
CURRENT_PANE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
NEW_PANE=$(herdr pane split "$CURRENT_PANE" --direction right --cwd "$PWD" --focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane rename "$NEW_PANE" 'Claude · parser investigation'
herdr pane run "$NEW_PANE" "claude --model claude-opus-5 --effort medium --permission-mode bypassPermissions $(printf %q "$PROMPT")"
```

Codex investigation uses the read-only template from the launch table.

### Issue implementation with an explicit profile

First let the repository helper create the issue worktree and semantic Herdr workspace without starting its built-in agent profile; then launch the chosen exact profile in the returned root pane:

```bash
WORK_HELPER=/absolute/path/to/pi-clean/scripts/github-work.mjs
RESULT=$(node "$WORK_HELPER" start-issue 123 --agent none)
WORKSPACE=$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["herdrWorkspaceId"])')
PANE=$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["herdrPaneId"])')
PROMPT='Work on GitHub issue #123. Read the repository instructions and issue, implement it in this worktree, validate the changes, and prepare a pull request. Do not merge.'
herdr pane run "$PANE" "claude --model claude-opus-5 --effort high --permission-mode bypassPermissions $(printf %q "$PROMPT")"
herdr workspace focus "$WORKSPACE"
```

### Bigger delegated issue with Fable orchestration

Use the same issue-worktree setup, but launch Fable in the returned root pane with the concrete delegation prompt. Do not launch Opus and Codex as unrelated sibling implementation sessions; Fable owns decomposition, assignment, synthesis, and final validation.

```bash
DELEGATION_PROMPT='Coordinate GitHub issue #123 as a bigger delegated task. Read the repository instructions and issue. Decompose it into bounded, non-overlapping subtasks and orchestrate substantive work across both Claude Opus 5 (`claude-opus-5`) and GPT-5.6-sol (`gpt-5.6-sol`). Prefer Opus 5 for primary development and GPT-5.6-sol for complementary investigation or independent review and validation. Keep a single writer in this worktree, inspect and synthesize delegated results, run final validation, and prepare a pull request. Do not merge or perform protected remote mutations.'
herdr pane run "$PANE" "claude --model fable --effort high --permission-mode bypassPermissions $(printf %q "$DELEGATION_PROMPT")"
herdr workspace focus "$WORKSPACE"
```

If the helper reports a reused workspace and omits a root pane ID, use the external Herdr skill to re-read that workspace's current pane; do not guess an old ID. Keep one semantic workspace per active issue and report its label after launch.
