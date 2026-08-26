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
| Fable review | Claude `fable` | `high` | Claude bypass permissions | `REVIEW_PROMPT`; review only |
| Delegated bigger task | Claude `fable` coordinator over Claude `claude-opus-5` and Codex `gpt-5.6-sol` | `high` | Claude bypass permissions | `DELEGATION_PROMPT`; coordinator only |
| Design or architecture | Claude `claude-opus-5` | `high` | Claude bypass permissions | design prompt with durable output |
| Claude review | Claude `claude-opus-5` | `high` | Claude bypass permissions | `REVIEW_PROMPT` |
| Claude implementation | Claude `claude-opus-5` | `high` | Claude bypass permissions | task prompt |
| Claude investigation | Claude `claude-opus-5` | `medium` | Claude bypass permissions; prompt must prohibit edits | investigation prompt |
| Codex review | Codex `gpt-5.6-sol` | `high` | no approvals, `workspace-write` sandbox | `REVIEW_PROMPT`; no unresolved design judgment |
| Codex implementation | Codex `gpt-5.6-sol` | `high` | no approvals, `workspace-write` sandbox | approved design required |
| Codex investigation | Codex `gpt-5.6-sol` | `medium` | no approvals, `read-only` sandbox | investigation prompt |

Claude Opus 5 is the default and preferred development model. Use a different direct-development model only when Martin names it or repository policy requires it. When Martin asks to delegate a bigger task, or explicitly asks for Fable orchestration, launch Claude Fable as the coordinator rather than using a direct Opus or Codex implementation session. A bigger task is broad enough to benefit from multiple bounded workstreams, such as cross-cutting implementation plus independent investigation, review, or validation. Do not add orchestration to narrow work merely because it uses `high` effort. An explicit effort request overrides the matrix when the selected model supports that value, but it does not override the Opus design-ownership rule.

## Design ownership

Any delegated work that establishes or materially changes a solution direction must assign the
design phase to Claude Opus 5 (`claude-opus-5`). This includes product, UX, interaction, visual,
architecture, API, and data-model design.

- Fable may decompose and coordinate the task, but it must delegate design to Opus rather than
  designing the solution itself.
- Fable is not a code implementation model. It must not edit implementation files, take a coding
  subtask itself, or spawn/delegate coding to another Fable instance unless Martin explicitly asks
  for Fable implementation for that specific task. The model name `fable` must never appear in a
  coding-worker assignment by default; use Opus or Codex.
- Pi and Codex may investigate constraints, implement a settled Opus design, and independently
  validate it. They must not originate or materially revise unresolved design.
- Record the Opus direction in the issue, a design artifact, or repository documentation before
  dependent implementation begins. The output must state the chosen direction, consequential
  tradeoffs, constraints, and implementation acceptance criteria.
- Routine local implementation choices within that approved direction do not require another Opus
  pass. If implementation exposes a material design gap, pause that part and return it to Opus.

When a request combines design and implementation, either give the whole task to Opus or sequence
an Opus design task before any other implementation agent. Never ask Codex to "design and build"
or let a coordinator treat Opus and Codex as interchangeable during the design phase.

### Review-only prompt

Substitute the concrete target and repository/PR context before launch:

```text
Review only: <TARGET>. Do not edit files or implement fixes unless Martin explicitly requests fixes in this session. Inspect the relevant issue context, full diff, tests, regressions, error handling, maintainability, and security. Return only evidence-backed findings ordered by severity. For each finding include file and line evidence, the concrete failure mode and impact, and a recommended correction. State explicitly when there are no findings. Do not publish comments, approve, merge, delete branches, or perform other protected remote mutations.
```

A review's `workspace-write` sandbox allows tools and tests to create local artifacts; it does not relax the review-only instruction. Review Git changes before declaring the session settled. If the review requires judgment about a new or materially changed design direction, use Opus rather than Fable, Pi, or Codex for that design review; other models may still review implementation fidelity against the approved direction.

### Bigger-task delegation prompt

Substitute the concrete task and repository/issue context before launch:

```text
Coordinate this bigger task: <TASK>. Read and follow the repository instructions and relevant issue or PR context. You are the coordinator only: do not edit implementation files or perform coding yourself, and never spawn or assign another Fable instance for coding. Martin has not authorized Fable implementation. Decompose the work into bounded, non-overlapping subtasks and orchestrate substantive work across Claude Opus 5 (`claude-opus-5`) and GPT-5.6-sol (`gpt-5.6-sol`). Assign every product, UX, interaction, visual, architecture, API, or data-model design decision exclusively to Opus and make its direction durable before dependent implementation begins. Assign coding only to Opus or GPT-5.6-sol. Use GPT-5.6-sol for complementary investigation, implementation within the approved design, independent code review, or validation; it must not originate or materially revise unresolved design. Keep a single writer for any shared worktree unless isolated worktrees make concurrent mutation safe. Place every delegate that shares this worktree in the current semantic Herdr workspace as a sibling pane or a named tab, and never create a second workspace for a checkout that already has one; create a separate worktree and workspace only when a subtask needs a checkout this one must not disturb. Inspect and synthesize delegated results, resolve discrepancies, run final validation, and remain accountable for the complete result. Respect repository WIP, worktree, review, and authorization rules. Do not merge or perform protected remote mutations without Martin's explicit authorization.
```

Fable is the coordinator, not a third interchangeable implementation worker or the design owner. By default it must not write code, edit implementation files, or delegate coding to another Fable. Only an explicit request from Martin for Fable implementation may override that boundary for the named task; a general request to delegate, orchestrate, review, or use Fable does not. It must assign design to Opus, use Opus and Codex as workers, prevent overlapping writes, and verify their outputs before reporting completion. Its workers stay in the coordinator's workspace whenever they share its worktree. Keep the Fable coordinator visible and focusable; its internally delegated workers do not replace the operator-visible coordinator session.

## Version-sensitive launch table

Keep command details here rather than scattering variants through recipes. These flags were verified with Claude Code `2.1.220` and Codex CLI `0.144.5`. The installed Codex model metadata for `gpt-5.6-sol` advertises `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.

| Profile | Exact interactive command template |
| --- | --- |
| Claude Fable review or coordinator (never default coding worker) | `claude --model fable --effort high --permission-mode bypassPermissions "$PROMPT"` |
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

Workspace identity follows the checkout, not the agent. One worktree has exactly one semantic Herdr workspace, and any agent whose working directory is an existing issue or review worktree belongs in that worktree's workspace. Placement inside a workspace is a pane or tab choice; isolation is a worktree choice. Never trade one for the other.

Decide placement in this order:

1. Does the delegate need a checkout this one must not disturb, such as a different branch, base, or issue? If yes, give it a separate worktree and its own semantic workspace through `scripts/github-work.mjs start-issue` or `review-pr`. Never assemble that pair by hand.
2. Otherwise the delegate shares this worktree and stays in the current workspace. Use a sibling pane for bounded work meant to be watched next to the coordinator, such as a quick investigation, a test run, or a log tail. Use a named tab for a subtask with its own lifetime or output volume, such as an implementation subtask, a review of the in-progress diff, or a long investigation, and when the current tab already holds two panes.
3. Keep one writer at a time in a shared worktree. Read-only delegates may run alongside the writer. A writing delegate takes that role exclusively: the coordinator stops editing while it runs and lends the role to only one agent at a time. Concurrent writers still require separate worktrees.

| Work | Placement | Filesystem rule |
| --- | --- | --- |
| Bounded same-context investigation | Sibling pane in the current tab | Read-only; sharing the checkout must be safe |
| Separate read-only subcontext in the same worktree | Named tab in the current workspace | Still shares the worktree; a tab is not isolation |
| Delegated subtask of the current issue, including a coding subtask | Sibling pane or named tab in the current issue workspace | Same worktree, one writer at a time; never a second workspace |
| Starting another issue, or mutating any other checkout | Dedicated issue worktree and semantic Herdr workspace | Use `scripts/github-work.mjs start-issue`; never mutate from a sibling pane |
| Independent PR review | Detached review worktree and semantic Herdr workspace | Use `scripts/github-work.mjs review-pr`; never review in the author worktree |

Read the current placement rather than assuming it. `herdr pane current` returns the running session's `workspace_id`, `tab_id`, and `pane_id`. Split from that pane, or create a tab with `herdr tab create --workspace "$WORKSPACE" --cwd "$PWD"`. Do not call `herdr workspace create` for a checkout that already has a workspace, and do not rename the issue workspace for a subtask; name the tab or pane instead.

A second workspace on the same issue worktree is not merely untidy. Herdr reports both as linked worktrees on one `checkout_path`, and `finish-issue` then refuses cleanup with `multiple Herdr workspaces represent issue worktree`.

If the current pane is not in the issue's semantic workspace, for example after `--agent none` or a manually opened folder, look for an existing workspace whose `worktree.checkout_path` is this worktree and place the delegate there. If none exists, rename the current workspace to the semantic label and use it.

Use workspace labels such as `pi-clean · #26 · interactive sessions` and `pi-clean · PR #42 · review/codex`, tab labels such as `impl/opus`, `review/codex`, or `investigate/opus`, and pane labels such as `Codex · review`. Tabs are only subcontexts within one worktree, never substitutes for worktree isolation.

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

### Delegated subtask inside the current issue workspace

Use this when the coordinator already runs in an issue worktree and the subtask shares that checkout. Read the live workspace from the current pane and add a named tab; do not create a workspace.

```bash
PROMPT='Review only: the working-tree change for issue #123. Do not edit files. Return evidence-backed findings ordered by severity, with file and line evidence, concrete failure mode and impact, and a recommended correction. State explicitly when there are no findings.'
WORKSPACE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
TAB_PANE=$(herdr tab create --workspace "$WORKSPACE" --cwd "$PWD" --label 'review/codex' --no-focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr pane rename "$TAB_PANE" 'Codex · review'
herdr pane run "$TAB_PANE" "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"high\"' --ask-for-approval never --sandbox workspace-write $(printf %q "$PROMPT")"
```

For bounded work meant to sit next to the coordinator, split the current pane instead of creating a tab. A coding subtask uses the same placement, with the coordinator holding still while that one writer runs. Report the existing workspace label rather than announcing a new workspace.

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

Use the same issue-worktree setup, but launch Fable in the returned root pane with the concrete delegation prompt. Fable owns decomposition, assignment, synthesis, and final validation, but must not edit implementation files or assign coding to another Fable. It assigns design to Opus and coding to Opus or Codex.

```bash
DELEGATION_PROMPT='Coordinate GitHub issue #123 as a bigger delegated task. Read the repository instructions and issue. You are the coordinator only: do not edit implementation files or perform coding yourself, and never spawn or assign another Fable instance for coding. Martin has not authorized Fable implementation. Decompose the work into bounded, non-overlapping subtasks across Claude Opus 5 (`claude-opus-5`) and GPT-5.6-sol (`gpt-5.6-sol`). Assign every product, UX, interaction, visual, architecture, API, or data-model design decision exclusively to Opus and record its direction before dependent implementation. Assign coding only to Opus or GPT-5.6-sol. Use GPT-5.6-sol for complementary investigation, implementation within the approved design, independent code review, or validation; it must not originate or materially revise unresolved design. Keep a single writer in this worktree and place every delegate that shares it in this Herdr workspace as a sibling pane or a named tab, never a second workspace; create a separate worktree and workspace only for a subtask that needs an isolated checkout. Inspect and synthesize delegated results, run final validation, and prepare a pull request. Do not merge or perform protected remote mutations.'
herdr pane run "$PANE" "claude --model fable --effort high --permission-mode bypassPermissions $(printf %q "$DELEGATION_PROMPT")"
herdr workspace focus "$WORKSPACE"
```

If the helper reports a reused workspace and omits a root pane ID, use the external Herdr skill to re-read that workspace's current pane; do not guess an old ID. Keep one semantic workspace per active issue and report its label after launch.
