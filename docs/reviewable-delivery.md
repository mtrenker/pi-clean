# Reviewable delivery: checkpoints, previews, and stacked pull requests

Design owner: Claude Opus 5, recorded 2026-09-21 for issue #43. This is the durable design record
that `AGENTS.md` requires before dependent implementation. It states the decisions and the reasons.
The rules agents follow live in the skills; the last section maps each rule to its file.

Nothing here has been exercised in a live trial. Martin will try this branch from a consuming
repository before it merges.

## Problem

Martin reviews most features as one large diff at the end. He wants three things: smaller review
units without splitting one coherent feature across several issues, a stop for his judgment at
consequential UI/UX decisions rather than at every change, and something running to look at whenever
an agent asks him about an interface.

This optimizes for his ability to understand and redirect work before facing the whole feature. It
costs wall-clock time and some of his attention on purpose. Diff size is the evidence behind it.
Merge timing says nothing about review quality and is not used as evidence anywhere in this work.

## Four concepts

Conflating any two of these produces either a workflow that pauses constantly or one that commits
and publishes without authorization.

| Concept | What it is | What it is not |
| --- | --- | --- |
| Checkpoint | A pause where the agent shows a consequential UI/UX decision and waits for Martin's judgment | Not a commit, not a pull request, not permission for either |
| Preview | A running instance the agent has loaded itself, with the route to open and what to look at | Not a deliverable, deployment, or durable environment |
| Commit | One coherent local step in a branch's history | Not implied by an accepted checkpoint |
| Layer | A pull request whose diff is one reviewable unit, based on the layer below it | Not implied by a checkpoint, and not created or published on its own |

Accepting a design at a checkpoint authorizes continuing to implement in that direction and nothing
else. A checkpoint may be followed by a commit, a layer boundary, both, or neither. A layer boundary
is a good moment to offer a checkpoint but does not require one. Preparing a pull request means
drafting its title, body, base, and head and showing them.

## Authorization

Five kinds of authorization, none implied by another: experience acceptance, commit, publication
(push, open a pull request, mark a draft ready, request or publish a review), merge, and destructive
operation (rewriting or discarding work, force-push, branch or worktree deletion).

Martin grants an authorization either at the moment of the action or in advance for a bounded task,
which is how the existing policy already works: confirm a consequential action unless the current
request explicitly authorizes that exact action. An advance grant covers the actions it names for
that task and nothing above them in the list. "Implement this issue and commit as you go" authorizes
those commits without a separate question per commit; it authorizes no push, no pull request, and no
merge. Accepting a design at a checkpoint is not an authorization of any kind, and never substitutes
for a commit authorization where a repository requires one.

A stricter rule in the consuming repository still binds, and this design never relaxes it. Merging
always needs authorization refreshed against live state. The rule that the authoring agent must not
be the sole independent reviewer is unchanged.

## Checkpoints

The must-pause list is deliberately short, because a workflow that pauses at every layer is worse
than the problem it solves: an unresolved design decision, an unspecified composition about to be
decided, a milestone the issue itself names, a material deviation found during implementation, and,
for consequential UI/UX work, an early renderable composition or vertical slice while redirection is
still cheap. Routine implementation inside an accepted direction does not pause: a rename, a prop, an
obvious control, a test, a refactor with no visible consequence.

An early checkpoint may use a bounded prototype to make an unresolved visual choice inspectable. A
prototype shown for a decision is not accepted production design, and the checkpoint has to say so.

While a checkpoint is open the preview is frozen: the agent changes nothing that could alter what
Martin is looking at. This is stronger than not committing, and it covers writes from tests and
tools, not only edits. It is a rule about agent conduct, not a guarantee about the filesystem, so the
agent re-checks state when work resumes.

## Previews

A UI/UX checkpoint without a running instance the agent has loaded itself is incomplete. The process
runs in a visible Herdr pane or named tab in the issue's existing workspace, never as a background
job and never in a second workspace for the same checkout.

pi-clean owns the shape of the handoff. Each consuming repository owns the start command, the
port-selection rule, any data or fixture isolation, and the teardown, and documents them. Managed
worktrees isolate files, not ports or shared databases. When a repository does not document how to
start a surface, the agent says so and asks instead of improvising a command.

## Stacked pull requests

GitHub's native stacked pull requests, in public preview since 2026-07-30, give one issue several
small review units without splitting the feature across issues. The decision is to document a
bounded manual workflow and add no automation: no stack manager, no helper lifecycle commands, no
`gh stack` install. The workflow has to be exercised by hand before anything is automated.

Layer 1 is the branch `start-issue` already creates. Further layers branch from the layer below
inside the same worktree, with a flat suffix, because Git refuses a nested name while the parent
branch ref exists. Verified locally on git 2.55.0: `git branch issue/43-slug/layer2` fails with
`cannot lock ref`, while `issue/43-slug--layer2` succeeds.

A layer awaiting Martin's review counts as a pull request awaiting review. Splitting one issue into
more layers creates no extra review capacity and does not bypass the repository's admission gates.

The one part most likely to surprise: GitHub's server-side "Rebase stack" rewrites the remote layer
branches, so the local branches in the worktree diverge from their remotes. A fast-forward-only
update is therefore a safe check that reports whether divergence happened; it is not a rebase
workflow and will refuse once the remote has been rewritten. Reconciling a rewritten stack locally
means rewriting local history and force-pushing with lease, which is a destructive operation needing
its own authorization. A repository that forbids force-push, or that requires signed commits, should
plan the trial around not rewriting a published stack rather than assume a safe automatic path
exists.

## Worktrees and lifecycle

One issue keeps one managed author worktree and one Herdr workspace. Layer branches live inside that
worktree. Independent review keeps using detached review worktrees, which are unaffected.

Two helper behaviors matter when a worktree holds several branches, and neither changes in this work:

- On a rerun, `start-issue` derives the branch from whatever the worktree currently has checked out,
  so it reports the current layer, and passing a different `--branch` throws.
- `finish-issue --delete-branch` deletes exactly one branch, the one attached to the worktree at
  removal time, with `git branch -d`, which refuses an unmerged branch. Other layer branches remain
  and are removed deliberately, one at a time.

Check out the canonical issue branch and leave the worktree clean before `finish-issue`.

## Tradeoffs

Rebase churn is the real cost of stacking. Every change to a lower layer forces the upper layers
forward, and bottom-up review contains that cost without removing it. If feedback routinely reworks
the bottom layer after the top exists, a stack will feel worse than one pull request. More pull
requests also mean more check runs and more merge-box states, and CI cost multiplies per layer where
a repository's `pull_request` workflows fire for layer branches.

The fallback is ordinary single-pull-request delivery. Checkpoints and previews are worth having on
their own and do not depend on stacking.

## Uncertainties carried into the trial

- Stacked pull requests are in public preview and subject to change.
- Whether reviews or approvals survive a stack rebase or an automatic retarget is not documented.
  Treat an approval on a layer above a changed layer as void until re-read.
- Whether a repository's `pull_request` workflows fire for layer pull requests depends on that
  repository's own trigger filters. There is no general rule.
- A stacks REST API appears in the `github/gh-stack` repository's own documentation rather than on
  docs.github.com. Its mutating endpoints were not exercised and are not a supported path here.
- Whether a Claude Code question in the TUI reliably raises Herdr's `blocked` state has not been
  observed end to end, which is why the contract also asks for an explicit signal.

## Trying this branch

Nothing below changes personal settings. The branch is `issue/43-add-a-trial-workflow-for-stacked-prs-and-human-ui-`
in the managed worktree:

```bash
BRANCH_PACKAGE=~/.local/share/agent-worktrees/github.com/mtrenker/pi-clean/issues/43-add-a-trial-workflow-for-stacked-prs-and-human-ui-
```

Skill source and helper path are separate choices.

Load the branch's skills for one pi run, from the consuming repository. pi 0.85.1 documents
`--skill` as a repeatable file or directory that stays additive under `--no-skills`, and finds
`SKILL.md` directories recursively; this command was checked for flag acceptance on pi 0.85.1, and
seeing the skills in a live session is the first trial step:

```bash
pi --no-skills --skill "$BRANCH_PACKAGE/skills" --prompt-template "$BRANCH_PACKAGE/prompts"
```

Drop `--no-skills` to keep the installed skills discoverable alongside the branch copies; expect two
copies of each skill if the released package is also installed.

The skills tell an agent to resolve `../../scripts/github-work.mjs` against the active `SKILL.md`, so
a session loaded this way also uses this branch's helper. To exercise the branch's managed prompts
without loading its skills, run the helper from the branch directly, in a checkout of the consuming
repository:

```bash
node "$BRANCH_PACKAGE/scripts/github-work.mjs" start-issue <number>
```

This repository is a pi package, not a Claude Code plugin, so Claude Code has no equivalent
per-session flag. Give a Claude session the absolute paths instead: the skills are plain Markdown and
the helper runs from the branch path above.

Installing the branch is the alternative, and it does write settings. `pi install` pins a tag or a
commit, so pass the commit rather than the branch name, and remove it afterwards.

Signals that the process is working: each diff is small enough to read in one sitting, every UI
question arrives with a preview already loaded, and nothing was committed, published, or merged
without a separate authorization. Signals to stop and fall back to a single pull request with
checkpoints only: a lower-layer fix cannot be propagated without rewriting published branches, upper
layer diffs stop being interpretable, more than two layers queue for review, CI cost is
disproportionate, or pauses arrive for decisions that were never consequential.

## Where each rule lives

| Rule | File |
| --- | --- |
| Concepts, authorization, checkpoint and preview contracts, review capacity | `skills/_shared/github-workflow.md` |
| Stacked pull request workflow, per-layer review, lower-layer fixes, cleanup limits | `skills/github-pull-requests/SKILL.md` |
| Preview and checkpoint placement, freeze, blocked signal | `skills/interactive-agent-sessions/SKILL.md` |
| When UI work needs an early renderable checkpoint | `skills/experience-design-quality/SKILL.md` |
| Layers within one issue, review capacity in issue selection | `skills/github-issues/SKILL.md` and its Project reference |
| Managed author and reviewer prompts | `scripts/github-work.mjs` |

## Sources

Verified 2026-09-21 against docs.github.com: [about stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs),
[reference](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests),
[creating](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-stacked-pull-requests),
[managing](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests),
and [merging](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests).
Local tools checked the same day: git 2.55.0, gh 2.101.0 with `gh stack` not installed, herdr 0.9.1,
pi 0.85.1.
