---
name: interactive-agent-sessions
description: Start visible, focusable Claude Code or Codex TUI sessions in Herdr with predictable model, effort, permissions, prompts, orchestration, isolation, maintainability review, and review convergence. Use for requests such as "make a fable review", "start a fable review", delegated bigger tasks, Claude or Codex review/implementation/investigation sessions, repeated review rounds, YOLO or non-prompting launches, and interactive Herdr agent sessions.
compatibility: Requires HERDR_ENV=1, Herdr 0.7.3+ (verified on 0.8.2), Claude Code 2.1.266, Codex CLI 0.153.4, and the external herdr skill.
---

# Interactive agent sessions

Turn a short request into an operator-visible Claude or Codex TUI. This skill owns intent, prompt shape, and placement policy; `scripts/agent-profiles.mjs` owns the exact launch commands. The external `herdr` skill covers live Herdr response shapes, but check its commands against `herdr --help` before use: the copy on this machine still documents the removed `herdr wait`.

## Preconditions

1. Check `HERDR_ENV` before any Herdr command. If it is not exactly `1`, stop and explain that the request requires an interactive Herdr-managed pane. Do not fall back to a subprocess, background agent, or non-interactive command.
2. Load and follow the external `herdr` skill listed in the available skills, verifying any command it names against `herdr --help` or `herdr --skill` output. Re-read live IDs from Herdr and parse create/split responses; never guess or retain ephemeral workspace, tab, or pane IDs as durable identity.
3. Read the target repository's instructions before launching. GitHub issue and PR work must also follow the repository `github-issues` and `github-pull-requests` skills.

## Deterministic intent matrix

`make a fable review` and `start a fable review` are exact intent aliases: choose the first row without asking for routine launch settings.

| Intent | Profile | Effort | Initial prompt |
| --- | --- | --- | --- |
| Fable review | `claude-fable` | `high` | `REVIEW_PROMPT`; review only |
| Coordinated bigger task | `claude-fable` | `high` | `DELEGATION_PROMPT`; coordinator only |
| Design or architecture | `claude-opus` | `high` | design prompt with durable output |
| Claude review | `claude-opus` | `high` | `REVIEW_PROMPT` |
| Claude implementation | `claude-opus` | `high` | task prompt |
| Claude investigation | `claude-opus` | `medium` | investigation prompt that prohibits edits |
| Codex review | `codex-sol-write` | `high` | `REVIEW_PROMPT`; no unresolved design judgment |
| Codex implementation | `codex-sol-write` | `high` | approved design required |
| Codex investigation | `codex-sol-read` | `medium` | investigation prompt |

Profiles resolve to exact commands in `scripts/agent-profiles.mjs`; see [Agent launch profiles](../../docs/agent-launch-profiles.md).

Claude Opus 5 is the default and preferred development model. Use a different direct-development model only when Martin names it or repository policy requires it.

Route serial work directly to one session. Reach for a Fable coordinator when Martin asks for one, when bounded subtasks can genuinely run in parallel, or when the work runs long enough that a single session would lose the thread. Coordination is a choice, not a step: narrow or strictly sequential work goes straight to `claude-opus` or `codex-sol-write`, and `high` effort alone is not a reason to orchestrate. A coordinator assigns each subtask to the vendor that fits it; using both Claude and Codex on one task is useful for independent review or complementary investigation, never a quota to fill.

An explicit effort request overrides the matrix when the profile supports that value, but it does not override the Opus design-ownership rule.

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
Review only: <TARGET>. Do not edit files or implement fixes unless Martin explicitly requests fixes in this session. Read the relevant issue, accepted scope, durable design direction, full diff, and tests. Review correctness, regressions, error handling, security, and maintainability against the supported contract. Distinguish reachable blockers, maintainability risks, unresolved design gaps, and out-of-contract concerns. A blocker needs a concrete failure path in a supported environment; label theoretical or future-call-path concerns as non-blocking unless they expose a reachable security or data-loss risk. Martin is one developer responsible for many projects: assess whether he can find the entry points, trace state and invariants, diagnose failures, recover safely, and change the code without an agent. Flag hidden coupling, disproportionate abstraction or change size, duplicated policy, tests that obscure rather than explain the contract, and designs whose operation depends on reconstructing agent reasoning. Allow abstractions that remove more complexity than they add and leave clear names, boundaries, and documentation. Return evidence-backed findings ordered by severity. For each finding include its category, file and line evidence, the concrete failure mode and impact, the supported-contract assumption, and the smallest maintainable correction. State explicitly when there are no findings. Do not publish comments, approve, merge, delete branches, or perform other protected remote mutations.
```

A review's `workspace-write` sandbox allows tools and tests to create local artifacts; it does not relax the review-only instruction. Review Git changes before declaring the session settled. If the review requires judgment about a new or materially changed design direction, use Opus rather than Fable, Pi, or Codex for that design review; other models may still review implementation fidelity against the approved direction.

## Review quality and convergence

A review protects the supported product and keeps the code operable by one human. It is not an invitation to make every theoretical state part of the product contract.

### Operator continuity

Review maintainability as a concrete operating requirement:

- Name the entry points, state owners, invariants, failure boundaries, logs, and recovery paths Martin would use when agents are unavailable.
- Prefer control flow and abstractions that can be explained from the repository. An abstraction is welcome when it removes more complexity than it adds, has a deterministic contract, and has focused tests.
- Flag hidden state machines, policy spread across callers, surprising framework interception, generated or test scaffolding larger than the behavior it proves, and code growth disproportionate to the issue.
- Require consequential tradeoffs and accepted failure modes to live in the issue, code, or repository documentation rather than only in an agent transcript.
- Make maintainability findings evidence-based. Personal style preferences and speculative future extensibility are not blockers.

### Review rounds

Use a convergent review loop:

1. **Initial review:** inspect the complete change broadly against the issue, supported environments, durable design, and operator continuity requirements.
2. **Author response:** the author verifies each finding independently, records confirmed, rejected, and design-dependent dispositions, then makes bounded corrections. Do not patch a finding merely because a reviewer stated it.
3. **First re-review:** verify the dispositions and corrections, then inspect the changed areas for regressions. Report a new blocker only with a concrete reachable path and say whether the original change or the correction introduced or exposed it.
4. **Convergence gate:** if the re-review finds material new blockers, the diff grows materially, or fixes keep expanding the failure model, stop the patch loop before another implementation round. Assign a read-only convergence pass to Opus. It must produce a durable supported contract, reachable failure model, explicit non-goals, accepted risks, finding dispositions, simplification opportunities, and a bounded stop condition.
5. **Final review:** review the complete result against that contract and the latest corrections. New reachable security, data-loss, or correctness blockers still count; out-of-contract theoretical cases do not silently expand scope. Publish nothing without authorization.

Do not impose an arbitrary maximum number of reviews, but do not feed an open-ended sequence of fresh findings into the author. After two substantive rounds, further implementation requires the convergence gate unless the remaining correction is narrow and does not change the contract. A green check suite does not prove correctness, and a reviewer finding does not prove that the supported product is broken.

### Re-review prompt addition

Append this to `REVIEW_PROMPT` for a re-review:

```text
This is review round <N>. Read the previous findings and author dispositions before reviewing. First verify each disposition and correction. Then inspect the changed areas and complete diff for regressions against the accepted supported contract. Clearly label any new finding, explain why it is reachable now and whether the original change or a correction introduced or exposed it, and do not expand the contract with theoretical or unsupported states. If material new blockers or material diff growth indicate that the review is not converging, stop and request an Opus convergence pass instead of proposing another patch list.
```

## Coordinated-task delegation prompt

Use this only when coordination is warranted: parallel bounded subtasks, long-running work, or an explicit request from Martin. Substitute the concrete task and repository/issue context before launch:

```text
Coordinate this task: <TASK>. Read and follow the repository instructions and relevant issue or PR context. You are the coordinator only: do not edit implementation files or perform coding yourself, and never spawn or assign another Fable instance for coding. Martin has not authorized Fable implementation. Decompose the work into bounded, non-overlapping subtasks and give each one to the profile that fits it: `claude-opus` for design and for implementation, `codex-sol-write` where a second vendor adds independent review or complementary investigation, `codex-sol-read` for read-only investigation. Involve both vendors when that independence is worth its cost, not by default. Assign every product, UX, interaction, visual, architecture, API, or data-model design decision exclusively to Opus and make its direction durable before dependent implementation begins. Codex may investigate constraints, implement an approved design, review, or validate; it must not originate or materially revise unresolved design. Start every delegate with `node <path>/scripts/github-work.mjs launch-command`; never write a model, effort, or permission flag by hand, and never spawn a native subagent. Keep a single writer for any shared worktree unless isolated worktrees make concurrent mutation safe. Place every delegate that shares this worktree in the current semantic Herdr workspace as a sibling pane or a named tab, and never create a second workspace for a checkout that already has one; create a separate worktree and workspace only when a subtask needs a checkout this one must not disturb. Require a solution Martin can locate, trace, diagnose, recover, and change without an agent; abstractions must remove more complexity than they add and leave their contract durable in the repository. Use the review convergence gate when repeated findings expand scope or materially grow the diff instead of coordinating an open-ended patch loop. Inspect and synthesize delegated results, resolve discrepancies, run final validation, and remain accountable for the complete result. Respect repository WIP, worktree, review, and authorization rules. Do not merge or perform protected remote mutations without Martin's explicit authorization.
```

Fable is the coordinator, not a third interchangeable implementation worker or the design owner. By default it must not write code, edit implementation files, or delegate coding to another Fable. Only an explicit request from Martin for Fable implementation may override that boundary for the named task; a general request to delegate, orchestrate, review, or use Fable does not. It must assign design to Opus, use Opus and Codex as workers, prevent overlapping writes, and verify their outputs before reporting completion, using the handoff and completion templates below. Its workers stay in the coordinator's workspace whenever they share its worktree. Keep the Fable coordinator visible and focusable; its internally delegated workers do not replace the operator-visible coordinator session.

## Launch commands

Never type a model name, effort flag, or permission flag into a recipe. Ask the repository helper for the exact command, so a skill launch and a managed `start-issue` launch cannot drift:

```bash
WORK_HELPER=/absolute/path/to/pi-clean/scripts/github-work.mjs
LAUNCH=$(node "$WORK_HELPER" launch-command --profile claude-opus --effort high --prompt "$PROMPT")
herdr pane run "$PANE" "$LAUNCH"
```

`node "$WORK_HELPER" profiles` prints the pinned models, supported efforts, defaults, and verified CLI versions. `scripts/agent-profiles.mjs` holds the values; [Agent launch profiles](../../docs/agent-launch-profiles.md) explains the design.

Profiles: `claude-opus`, `claude-fable`, `codex-sol-write`, `codex-sol-read`, `pi-ambient`. Fable is pinned to `claude-fable-5-1`; the bare `fable` alias resolves differently through the apps gateway, so it is never used. `pi-ambient` takes its model, effort, and tool policy from personal settings and is therefore not reproducible from this repository; prefer a pinned profile.

An unsupported profile or effort exits non-zero and names the supported values. Never work around that by writing the command by hand: a silent fallback to a different model, effort, or permission mode is the failure this helper exists to prevent.

These are TUI entry points because no subcommand is present. For an interactive-session request, never use Claude `--print`/`-p`, `--background`/`--bg`, or `claude agents`; never use Codex `exec` or the non-interactive `codex review` command. Do not redirect or pipe the agent's TUI.

The removed Codex `--full-auto` alias is spelled `--ask-for-approval never --sandbox workspace-write`. Do not use `--dangerously-bypass-approvals-and-sandbox` or `--sandbox danger-full-access`; worktree isolation is not a host sandbox.

### Effort policy

| Task complexity | Claude | Codex | Use when |
| --- | --- | --- | --- |
| Narrow and obvious | `low` | `low` | One-file lookup, simple reproduction, or tightly bounded question |
| Routine focused work | `medium` | `medium` | Default investigation or small, well-understood change |
| Substantial | `high` | `high` | Default implementation and review with meaningful cross-file reasoning |
| Difficult | `xhigh` | `xhigh` | Difficult architecture, debugging, concurrency, migration, or high-risk review |
| Exceptional | `max` | `max` | The hardest ambiguous or safety-critical work after deciding `xhigh` is insufficient |

Codex adds `ultra` above `max`. Use it only when Martin asks for it; it is never a routine default, and it no longer implies worker spawning because every Codex profile disables `multi_agent`. The helper rejects an effort a profile does not support instead of falling back.

## Native delegation

A worker delegates in the open or not at all. Every profile disables the vendor's own worker spawning, at every effort level, and every managed prompt repeats the boundary:

- Codex sessions pass `--disable multi_agent`. Verify with `codex --disable multi_agent features list`, which reports `multi_agent stable false` against a default of `true`. An unknown feature name exits non-zero.
- Claude sessions pass `--settings '{"disabledBuiltinTools":["Task"]}'`. That key removes a built-in tool instead of denying it through the permission system, which is why it is used rather than a deny rule that `bypassPermissions` would skip. Its effect was not verified end to end.
- Pi ships no sub-agents, so it has nothing to disable.

Treat these as boundaries, not guarantees. Every profile still has a shell and could start an agent through it; the flags are unverified end to end without a paid session; and none of them sandboxes the host. Say it that way in reports. Codex `ultra` still requires an explicit request from Martin, though it no longer implies worker spawning.

Delegate instead by launching a visible Herdr pane or named tab with `launch-command`, keeping one writer in a shared worktree.

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

Resolve `../../scripts/github-work.mjs` relative to this skill directory and use its absolute path. Every recipe below assumes:

```bash
WORK_HELPER=/absolute/path/to/pi-clean/scripts/github-work.mjs
```

### Review in a safe shared checkout

Use only when the target can be reviewed without filesystem mutation. Swap `--profile claude-fable` for `codex-sol-write` or `claude-opus` to change reviewer.

```bash
REVIEW_PROMPT='Review only: the current change. Do not edit files or implement fixes unless Martin explicitly requests fixes in this session. Review correctness, security, regressions, and maintainability against the accepted supported contract. Distinguish reachable blockers, maintainability risks, design gaps, and out-of-contract concerns. A blocker needs a concrete reachable path. Assess whether one human can find the entry points, trace invariants and state, diagnose failures, recover, and change the code without an agent. Return evidence-backed findings ordered by severity, with category, file and line evidence, concrete impact, contract assumption, and the smallest maintainable correction. State explicitly when there are no findings. Do not publish comments, approve, merge, delete branches, or perform other protected remote mutations.'
LAUNCH=$(node "$WORK_HELPER" launch-command --profile claude-fable --effort high --prompt "$REVIEW_PROMPT")
CURRENT_PANE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
NEW_PANE=$(herdr pane split "$CURRENT_PANE" --direction right --cwd "$PWD" --focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane rename "$NEW_PANE" 'Fable · review'
herdr pane run "$NEW_PANE" "$LAUNCH"
```

For an independent PR review, do not use the shared-checkout recipe. Run the helper with the requested reviewer so it creates the detached review worktree and dedicated semantic workspace:

```bash
node "$WORK_HELPER" review-pr 42 --reviewer codex
```

Then focus and report the returned semantic workspace. The review-only authorization boundary still applies; never publish or merge the review without explicit approval.

### Focused read-only investigation

```bash
PROMPT='Investigate why the parser rejects empty input. Read only: do not edit files. Report evidence, likely cause, and the smallest safe correction.'
LAUNCH=$(node "$WORK_HELPER" launch-command --profile claude-opus --effort medium --prompt "$PROMPT")
CURRENT_PANE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
NEW_PANE=$(herdr pane split "$CURRENT_PANE" --direction right --cwd "$PWD" --focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane rename "$NEW_PANE" 'Claude · parser investigation'
herdr pane run "$NEW_PANE" "$LAUNCH"
```

Codex investigation uses `--profile codex-sol-read`, whose sandbox is `read-only`.

### Delegated subtask inside the current issue workspace

Use this when the coordinator already runs in an issue worktree and the subtask shares that checkout. Read the live workspace from the current pane and add a named tab; do not create a workspace.

```bash
PROMPT='Review only: the working-tree change for issue #123. Do not edit files. Return evidence-backed findings ordered by severity, with file and line evidence, concrete failure mode and impact, and a recommended correction. State explicitly when there are no findings.'
LAUNCH=$(node "$WORK_HELPER" launch-command --profile codex-sol-write --effort high --prompt "$PROMPT")
WORKSPACE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
TAB_PANE=$(herdr tab create --workspace "$WORKSPACE" --cwd "$PWD" --label 'review/codex' --no-focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr pane rename "$TAB_PANE" 'Codex · review'
herdr pane run "$TAB_PANE" "$LAUNCH"
```

For bounded work meant to sit next to the coordinator, split the current pane instead of creating a tab. A coding subtask uses the same placement, with the coordinator holding still while that one writer runs. Report the existing workspace label rather than announcing a new workspace.

### Issue implementation with an explicit profile

`start-issue` launches the `claude-opus` profile by default. Pass `--agent none` only when you need a different profile, then launch it in the returned root pane:

```bash
RESULT=$(node "$WORK_HELPER" start-issue 123 --agent none)
WORKSPACE=$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["herdrWorkspaceId"])')
PANE=$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["herdrPaneId"])')
PROMPT='Work on GitHub issue #123. Read the repository instructions and issue, implement it in this worktree, validate the changes, and prepare a pull request. Do not merge.'
LAUNCH=$(node "$WORK_HELPER" launch-command --profile codex-sol-write --effort high --prompt "$PROMPT")
herdr pane run "$PANE" "$LAUNCH"
herdr workspace focus "$WORKSPACE"
```

### Coordinated issue with Fable

Use the same issue-worktree setup when the work has parallel or long-running parts. Fable owns decomposition, assignment, synthesis, and final validation, but must not edit implementation files or assign coding to another Fable. It assigns design to Opus and coding to Opus or Codex.

```bash
DELEGATION_PROMPT='Coordinate GitHub issue #123 as a bigger delegated task. Read the repository instructions and issue. You are the coordinator only: do not edit implementation files or perform coding yourself, and never spawn or assign another Fable instance for coding. Martin has not authorized Fable implementation. Decompose the work into bounded, non-overlapping subtasks and assign each to the vendor that fits it, using both Claude Opus 5 (`claude-opus`) and GPT-5.6-sol (`codex-sol-write`) only where a second vendor adds independent review or complementary investigation. Assign every product, UX, interaction, visual, architecture, API, or data-model design decision exclusively to Opus and record its direction before dependent implementation. Assign coding only to `claude-opus` or `codex-sol-write`. Start every delegate with the repository helper command `github-work.mjs launch-command`; do not write a model or permission flag by hand, and do not spawn native subagents. Give each delegate a handoff block and require its completion block back before accepting the work. Require a solution Martin can locate, trace, diagnose, recover, and change without an agent; abstractions must remove more complexity than they add and leave their contracts in the repository. Keep a single writer in this worktree and place every delegate that shares it in this Herdr workspace as a sibling pane or a named tab, never a second workspace; create a separate worktree and workspace only for a subtask that needs an isolated checkout. If repeated review findings expand scope or materially grow the diff, stop the patch loop and run the Opus convergence gate before more implementation. Inspect and synthesize delegated results, run final validation, and prepare a pull request. Do not merge or perform protected remote mutations.'
LAUNCH=$(node "$WORK_HELPER" launch-command --profile claude-fable --effort high --prompt "$DELEGATION_PROMPT")
herdr pane run "$PANE" "$LAUNCH"
herdr workspace focus "$WORKSPACE"
```

If the helper reports a reused workspace and omits a root pane ID, use the external Herdr skill to re-read that workspace's current pane; do not guess an old ID. Keep one semantic workspace per active issue and report its label after launch.

### Waiting for a delegate

`herdr wait` no longer exists. On Herdr 0.8.2 the lifecycle commands are:

```bash
herdr agent wait "$NEW_PANE" --until working --timeout 120000
herdr agent wait "$NEW_PANE" --until idle --until done --until blocked --timeout 1800000
herdr pane wait-output "$NEW_PANE" --match 'No findings' --timeout 60000
```

Observe `working` before calling a launch successful. Then accept `idle`, `done`, or `blocked` as settled, and read the pane: `done` is ephemeral, so a waiter that requires only `done` can hang after someone focuses the pane. Bring a `blocked` agent to Martin instead of waiting longer. Keep the pane open so he can focus, inspect, interrupt, and resume it.

Run `herdr --help`, `herdr agent --help`, and `herdr pane --help` when a command's shape is in doubt. The external `herdr` skill under `~/.agents/skills/` is stale on this machine and still documents `herdr wait`; `herdr --skill` prints the current version. Refreshing that file is Martin's action, not this repository's: never edit it or any other personal settings file.

## Handoff and completion templates

A delegated session starts and ends in writing. Fill in every field; write "none" rather than leaving one out.

Handoff, sent as part of the delegate's initial prompt:

```text
Task: <one sentence>
Repository and revision: <owner/repo> at <git SHA>, branch <branch>, worktree <path>
Write scope: <paths you may change>. You are the only writer in this worktree while you run. Do not touch <paths off limits>.
Design: <approved Opus direction and where it is recorded> | <none; stop and request an Opus handoff if design is needed>
Tests to run: <exact commands>
Acceptance criteria: <numbered, testable>
Risks and known traps: <what has already gone wrong here>
Escalation: stop and report if <condition>. Do not push, publish, approve, merge, or delete anything. Do not spawn native subagents; ask for a visible Herdr pane instead.
```

Completion, required back from the delegate before its work is accepted:

```text
Revision: <git SHA or "working tree only">, branch <branch>
Files and behavior changed: <path: what changed and what a user sees>
Checks run: <command → result, including failures and skips>
Acceptance criteria: <each criterion → met, partially met with reason, or not met>
Limitations and accepted risks: <what this does not cover>
Needs operator authorization: <pushes, publications, merges, deletions, or nothing>
```

The coordinator verifies the claims rather than relaying them: re-run the checks, read the diff, and reconcile disagreements between delegates before reporting.
