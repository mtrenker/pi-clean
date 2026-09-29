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

Profiles resolve to exact commands in `scripts/agent-profiles.mjs`; see [Agent launch profiles](../../docs/agent-launch-profiles.md) and [Model selection](../../docs/model-selection.md).

Claude Opus 5.5 is the default and preferred development model. Use a different direct-development model only when Martin names it or repository policy requires it.

No intent routes to `codex-astra-write`. It pins OpenAI's frontier model as an opt-in escalation for a Codex task Sol has already failed or is plainly unsuited to, and Martin decides that escalation. Launch it with `--profile codex-astra-write`, and expect its default effort `medium` rather than Sol's `high`, because OpenAI states that reasoning efforts do not map exactly between model generations.

Route serial work directly to one session. Reach for a Fable coordinator when Martin asks for one, when bounded subtasks can genuinely run in parallel, or when the work runs long enough that a single session would lose the thread. Coordination is a choice, not a step: narrow or strictly sequential work goes straight to `claude-opus` or `codex-sol-write`, and `high` effort alone is not a reason to orchestrate. A coordinator assigns each subtask to the vendor that fits it; using both Claude and Codex on one task is useful for independent review or complementary investigation, never a quota to fill.

An explicit effort request overrides the matrix when the profile supports that value, but it does not override the Opus design-ownership rule.

## Design ownership

[The shared workflow policy](../_shared/github-workflow.md#delegated-design-ownership) is the one
place that defines who may design, who may implement, and what a design handoff must record. The
launch consequences here: a design or architecture intent always routes to `claude-opus`; the model
name `fable` never appears in a coding-worker assignment unless Martin asked for Fable
implementation on that task; and an explicit effort request never overrides that routing.

### Review-only prompt

`REVIEW_PROMPT` is the review-only prompt in [prompts](references/prompts.md#review-only-prompt).
Substitute the concrete target and repository or PR context before launch.

A review's `workspace-write` sandbox allows tools and tests to create local artifacts; it does not
relax the review-only instruction. Review Git changes before declaring the session settled. A review
that must judge a design direction routes to Opus under the design-ownership rule above.

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

For a re-review, append [the re-review addition](references/prompts.md#re-review-prompt-addition)
to `REVIEW_PROMPT`.

## Coordinated-task delegation prompt

Use `DELEGATION_PROMPT`, [the coordinated-task prompt](references/prompts.md#coordinated-task-delegation-prompt),
only when coordination is warranted: parallel bounded subtasks, long-running work, or an explicit
request from Martin. Substitute the concrete task and repository or issue context before launch.

The Fable coordinator is neither a third interchangeable implementation worker nor the design owner.
It assigns design to Opus, uses Opus and Codex as workers, keeps one writer per worktree, verifies
worker output before reporting, and stays visible and focusable; its workers stay in its workspace
whenever they share its worktree. The handoff and completion templates it uses are in
[templates](references/templates.md).

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

The printed command ends its options with `--`, so a prompt that starts with a dash is passed as text rather than read as a flag, and it carries the delegation boundary appended to your prompt.

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

A worker delegates in the open or not at all. `launch-command` appends the delegation boundary to every prompt it renders, so the instruction reaches ad-hoc launches and recipes as well as managed issue and review sessions. The Claude and Codex profiles add a flag at every effort level:

- Codex sessions pass `--disable multi_agent`. Verify with `codex --disable multi_agent features list`, which reports `multi_agent stable false` against a default of `true`. An unknown feature name exits non-zero.
- Claude sessions pass `--disallowed-tools Agent,Workflow`, the canonical names of the tool that spawns a subagent and the tool that runs a script orchestrating many subagents. Claude's permissions documentation says a bare tool name in a deny rule removes the tool from the model's context, so this is removal rather than a prompt `bypassPermissions` would skip, and a deny rule naming no known tool warns at startup. Its effect was not verified end to end, and it covers spawning rather than messaging tools that reach existing agents.
- `pi-ambient` has no flag. Pi ships no built-in sub-agents, but it loads extensions from personal settings and an extension can add one, so its delegation is uncontrolled and only the prompt carries the boundary.

Treat these as boundaries, not guarantees. Every profile still has a shell and could start an agent through it, the flags are unverified end to end, and none of them sandboxes the host. Say it that way in reports. Codex `ultra` still requires an explicit request from Martin, though it no longer implies worker spawning.

Delegate instead by launching a visible Herdr pane or named tab with `launch-command`, keeping one writer in a shared worktree.

## Permissions are not authorization

“YOLO” means only the exact local prompt-suppression profile:

- Claude: `--permission-mode bypassPermissions`. This bypasses Claude checks and provides no host sandbox.
- Codex: `--ask-for-approval never` plus the named `read-only` or `workspace-write` sandbox. `workspace-write` limits model-generated commands but still permits mutations in the worktree.

Neither profile authorizes publishing a review, approving or merging a PR, pushing, deleting branches, closing issues, releasing, or any other protected remote mutation. Those actions still require Martin's explicit authorization. Prompt injection and mistaken commands remain risks.

## Placement policy

Workspace identity follows the repository, not the agent. An issue worktree has exactly one semantic Herdr workspace, and a detached review checkout runs as a named tab inside a workspace that repository already has rather than a workspace of its own. Placement inside a workspace is a pane or tab choice; isolation is a worktree choice. Never trade one for the other.

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
| Independent PR review | Detached review worktree, named tab in an existing workspace | Use `scripts/github-work.mjs review-pr`; never review in the author worktree |
| Preview for a UI checkpoint | Named tab or sibling pane in the current issue workspace | Visible and interruptible; never a background job |

Read the current placement rather than assuming it. `herdr pane current` returns the running session's `workspace_id`, `tab_id`, and `pane_id`. Split from that pane, or create a tab with `herdr tab create --workspace "$WORKSPACE" --cwd "$PWD"`. Do not call `herdr workspace create` for a checkout that already has a workspace, and do not rename the issue workspace for a subtask; name the tab or pane instead.

A second workspace on the same issue worktree is not merely untidy. Herdr reports both as linked worktrees on one `checkout_path`, and `finish-issue` then refuses cleanup with `multiple Herdr workspaces represent issue worktree`.

If the current pane is not in the issue's semantic workspace, for example after `--agent none` or a manually opened folder, look for an existing workspace whose `worktree.checkout_path` is this worktree and place the delegate there. If none exists, rename the current workspace to the semantic label and use it.

A label says what a child is; the parent workspace already names the repository. Use `#26 · interactive sessions` for an issue workspace, `Implementation` for its author tab, `PR #42 · Review` for a review tab, and names such as `investigate/opus` or `Codex · review` for other tabs and panes. Never identify a workspace by its label, because `#26` means a different issue in a different repository. A tab is a subcontext in one window, never a substitute for worktree isolation.

Start the TUI with its initial prompt in the created terminal. Focus the new pane, tab, or workspace for direct interaction unless Martin asks to keep the current focus. Report the semantic workspace, tab, and pane label after launch; IDs may be included only as current routing handles.

Do not replace direct interaction with coordinator polling. The session must remain visible so Martin can inspect, interrupt, and continue it. If Martin asks to stay in the current pane, launch with no focus, report the location immediately, and leave the new terminal visible and focusable.

## Checkpoints and previews

[The shared workflow policy](../_shared/github-workflow.md) defines when to pause, what a checkpoint
contains, and what accepting a design does not authorize. This skill owns where the preview runs and
how the pause reaches Martin.

A preview is an ordinary long-running process, so it follows the placement policy above: a sibling
pane when it belongs next to the work, a named tab when it is long-lived or noisy, always in this
worktree's existing workspace. Never a background job, never `&`, never a second workspace for this
checkout, and never a redirected TUI. The start command comes from the target repository's own
documentation; this repository does not supply one, and improvising a command is not a substitute for
asking.

```bash
WORKSPACE=$(herdr pane current | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["workspace_id"])')
PREVIEW=$(herdr tab create --workspace "$WORKSPACE" --cwd "$PWD" --label 'preview' --no-focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr pane rename "$PREVIEW" 'Preview · dev server'
herdr pane run "$PREVIEW" '<start command documented by the target repository>'
```

Run installs, migrations, and fixture seeding before the checkpoint opens, in the same visible
placement. Then open the route yourself and confirm it rendered before asking.

Ask the question in your own session so Herdr can classify it: Herdr reports `blocked` when it
recognizes an approval or question UI. Whether a Claude Code question reliably raises it has not been
observed end to end here, so also send an operator-visible notification, which is what reaches Martin
if the state does not change:

```bash
herdr notification show 'owner/repo #123 checkpoint' --body 'Compare the two list densities at http://localhost:5173/items' --sound request
```

While the checkpoint is open, hold the preview still. The freeze in the shared policy covers writes
from tests and tools, not only commits: no edits, no branch switch or rebase, no install, no rebuild
or restart of the preview process. Reads and read-only checks are fine. Re-check the worktree state
when Martin answers instead of assuming it is as you left it.

## Recipes and templates

[Recipes](references/recipes.md) has the runnable launch sequences: a review in a safe shared
checkout, a focused read-only investigation, a delegated subtask inside the current issue workspace,
issue implementation with an explicit profile, a coordinated issue with Fable, waiting for a
delegate, and the watch-or-callback choice. Every recipe resolves `../../scripts/github-work.mjs`
against this skill directory and uses that absolute path as `WORK_HELPER`.

[Templates](references/templates.md) has the handoff block a delegate receives in its initial prompt
and the completion block it must return before its work is accepted. Fill in every field; write
"none" rather than leaving one out.
