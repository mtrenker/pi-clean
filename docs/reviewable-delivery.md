# Reviewable delivery: checkpoints, previews, and stacked pull requests

Design owner: Claude Opus 5, recorded 2026-09-21 for issue #43. This is the durable design record
that `AGENTS.md` requires before dependent implementation. It keeps the decisions, the reasons, and
the evidence. The rules themselves live in the skills, stated once, and the last section maps each
rule to its file. When this record and a skill disagree, the skill is what agents load and the
record is out of date.

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

## Decisions

Each decision links to the file that carries its rule. The rules are not repeated here.

**Keep the checkpoint, the commit, and the pull request layer separate.** Conflating any two of them
produces either a workflow that pauses constantly or one that commits and publishes without
authorization. The concepts and their consequences are in
[the shared policy](../skills/_shared/github-workflow.md#reviewable-delivery).

**Keep design acceptance out of the authorization chain, without turning an authorized task into a
question per commit.** Accepting a design says the direction is right and says nothing about
publishing. Implementing a task you were asked to implement still includes committing its steps on
its branch; what needs a grant of its own is committing where the target repository requires
approval first, and that stricter rule always wins.

**Pause for a short, named list of decisions, and bring something running to each one.** A workflow
that pauses at every layer is worse than the problem it solves, so the list is deliberately short. It
includes an early renderable composition for consequential UI work, because redirecting is cheap
before the surface is built out and expensive afterwards.

**Let each target repository own its preview commands.** Start commands, port selection, data
isolation, and teardown depend on the repository. pi-clean owns the shape of the handoff, not the
commands. Managed worktrees isolate files, not ports or shared databases.

**Use GitHub's native stacked pull requests by hand, and automate nothing.** They have been in public
preview since 2026-07-30 and give one issue several small review units without splitting the feature
across issues. No stack manager, no new helper lifecycle commands, no `gh stack` install: the
workflow has to be exercised before anything is built on it. Layer branches take a flat suffix
because a nested name is impossible while the parent branch ref exists. On git 2.55.0,
`git branch issue/43-slug/layer2` fails with `cannot lock ref`, while `issue/43-slug--layer2`
succeeds.

**Do not let layers buy review capacity.** A layer awaiting review counts as a pull request awaiting
review, so splitting one issue into more layers does not widen the repository's WIP or admission
gates.

**Keep one author worktree and one Herdr workspace per issue.** Layer branches live inside that
worktree, and independent review keeps using detached review worktrees. No helper behavior changed;
what `start-issue` and `finish-issue` do when a worktree holds several branches is recorded in
[the workflow guide](github-workflow.md#prerequisites).

## Amendment: where an independent review runs

Recorded 2026-09-21, after the first review of this work. Martin: "creating new workspaces for a
review of a worktree is wild for me to follow." A separate filesystem does not have to mean a
separate workspace, and treating it that way scattered one issue's work across the window.

An independent review keeps its own detached worktree. What changes is where its session lives: a
named tab inside a workspace that already belongs to this repository, with its working directory in
that detached checkout. Isolation stays a filesystem property, placement becomes a window property,
and the two stop being confused.

**Host selection, in order.** Each step uses live identity, not a stored registry:

1. `--workspace <id>` when given. It must exist and belong to this repository, or the command fails.
2. The caller's own workspace, when the caller runs in a Herdr pane whose workspace belongs to this
   repository. Running `review-pr` from an issue worktree puts the review beside that issue.
3. The repository's primary workspace, the one whose checkout is the repository root rather than a
   linked worktree.
4. Otherwise the command fails and names the candidates. There is no fallback that creates a
   workspace.

Herdr gives each workspace a `worktree` block with `repo_root`, `checkout_path` and
`is_linked_worktree`. Two workspaces belong to the same repository when their `repo_root` matches the
root `git rev-parse --git-common-dir` reports, which is what makes this deterministic without the
helper keeping state of its own.

**Recognising a review that already exists.** A review is identified by the working directory of a
pane, not by a label or a remembered ID. A pane whose directory is that review's worktree is that
review, wherever someone has since moved it. The helper reports that placement and does not create a
second one, which is also why a workspace whose own checkout is a review worktree, from before this
amendment, is recognised and left alone rather than migrated.

**Order of operations.** Placement and agent state are read before the worktree is touched. Checking
out a new head under a reviewer that is still working would change the tree it is reading, so an
active review refuses the refresh instead of refusing after it.

**Cleanup closes what it opened, and nothing else.** Review cleanup closes the panes whose directory
is that review's worktree, closes their tab only when the tab held nothing else, and closes a
workspace only when that workspace's own checkout is the review worktree. A host workspace, the
author's tab, another review, a preview, and any unrelated pane are never closed.

**Finishing an issue does not strand a review.** An issue workspace can now host review tabs, so
removing it would take live review sessions and their checkouts with it. `finish-issue` refuses while
a review checkout is hosted there and says which one to clean up or move first.

**Labels say what a child is, not which repository it belongs to.** The parent workspace already
carries the repository name, so repeating it in every child is noise. An issue workspace is
`#<number> · <short title>`, its author tab is `Implementation`, and a review tab is
`PR #<number> · Review`, with the reviewer added only when a second reviewer needs distinguishing.
Branches, worktree paths, work IDs and repository roots do not change; this is display only.

A compact label cannot identify anything, because `#43` means a different issue in a different
repository. Nothing the helper reuses or closes is selected by label. Reuse and cleanup match on the
repository root Herdr reports for a workspace and on the working directory of a pane, so a workspace
someone renamed, and one still carrying the old repository-prefixed label, both keep working.

The rules are in [the shared policy](../skills/_shared/github-workflow.md#reviewable-delivery) and
[`github-pull-requests`](../skills/github-pull-requests/SKILL.md#independent-review); the commands
are in `scripts/github-work.mjs`.

## Tradeoffs

Rebase churn is the real cost of stacking. Every change to a lower layer forces the upper layers
forward, and bottom-up review contains that cost without removing it. If feedback routinely reworks
the bottom layer after the top exists, a stack will feel worse than one pull request. More pull
requests also mean more check runs and more merge-box states, and CI cost multiplies per layer where
a repository's `pull_request` workflows fire for layer branches.

A server-side rebase is the sharpest edge. It rewrites the remote layer branches, so the local
branches diverge and bringing them back into line becomes an operator step rather than a routine one.
Nothing about that requires pushing to the remote again; it requires someone deciding what the local
branches should hold.

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

Nothing below changes personal settings. The branch is
`issue/43-add-a-trial-workflow-for-stacked-prs-and-human-ui-` in the managed worktree:

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

Installing the branch as a pinned git ref is the other way to reach it, and it writes settings. The
local trial does not need it, so it is left to pi's own packages documentation rather than written
out here as a recipe nobody has run.

Signals that the process is working: each diff is small enough to read in one sitting, every UI
question arrives with a preview already loaded, and nothing was committed, published, or merged
without a separate authorization. Signals to stop and fall back to a single pull request with
checkpoints only: reconciling a lower-layer fix keeps landing on the operator, upper layer diffs stop
being interpretable, more than two layers queue for review, CI cost is
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
