---
name: github-pull-requests
description: Create, inspect, review, update, and safely complete GitHub pull requests with the gh CLI. Use for opening PRs from issue worktrees, checking CI, independent model reviews, addressing feedback, or preparing an authorized merge.
compatibility: Requires git, an authenticated GitHub CLI (gh), and Herdr for managed agent workspaces.
---

# GitHub pull requests

Read [the shared workflow policy](../_shared/github-workflow.md) before acting. It defines the
checkpoint, preview, commit, and layer concepts and the authorization each one needs.

## Open a pull request

Work from the issue worktree, not the primary checkout. Before proposing a PR:

```bash
git status --short --branch
git diff --check
git log --oneline --decorate <base>..HEAD
git diff --stat <base>...HEAD
```

Run the repository's required validation. Push only the branch you are publishing: the issue branch,
or one layer branch of a stack. Draft a PR using the local pull request template and include:

- linked issue (`Closes #N` only for complete resolution);
- concise explanation of behavior and design decisions;
- validation commands and outcomes;
- risks, limitations, migrations, or screenshots where relevant.

Show the final title/body/base/head before `gh pr create` unless the user explicitly authorized
opening it. Prefer `--body-file`.

## Inspect a pull request

```bash
gh pr view <number> --json number,title,body,state,isDraft,author,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup,closingIssuesReferences,url
gh pr diff <number> --name-only
gh pr checks <number>
```

Read linked issue context and repository instructions. Do not trust the PR description as proof
that code or tests are correct.

## Stacked pull requests

Use a stack when one issue produces several units worth reading separately. One pull request with
checkpoints remains the default and the fallback. GitHub's stacked pull requests are in public
preview and subject to change. A stack is a chain of pull requests in one repository, each based on
the branch below it and the bottom one on the trunk; cross-fork stacks and GitHub Desktop are not
supported.

Layer 1 is the branch `start-issue` creates. Later layers branch from the layer below, inside the
same author worktree, with a flat suffix:

```bash
git switch -c issue/<number>-<slug>--<layer-slug>
```

Nested layer names are impossible: Git refuses `issue/<number>-<slug>/<layer>` while the parent
branch ref exists. Never check out a layer branch outside the managed worktree. One issue keeps one
worktree and one Herdr workspace however many layers it has, and a layer awaiting review counts
against review capacity like any other pull request.

Open a layer as you would any pull request, with publication authorization and its base set to the
branch below:

```bash
gh pr create --base issue/<number>-<slug> --draft --body-file <file>
```

Each layer's body links the issue, names the layer below it, and says what is deliberately left to a
later layer. Use `Closes #<number>` only on the layer that completes the issue.

Forming the stack is an operator action on the GitHub website: choose **Create stack** when opening a
pull request whose base is the branch below, accept the recommendation banner GitHub shows for
already-chained pull requests, or use **Add to stack** from the stack icon. Stacks are not formed
automatically by pushing chained branches. `gh stack` is an official extension that can also create
and rebase stacks; it is not installed here, and adopting it is a separate decision.

### Review a layer

Each pull request shows only its own layer's diff, and the merge box shows a stack map of every pull
request and its status. Required reviews, status checks, CODEOWNERS, and code scanning are evaluated
as if each pull request targets the stack base rather than the branch below it.

Review bottom up, and review a layer only while it is not being changed. Whether an approval survives
a stack rebase or an automatic retarget is not documented, so treat an approval on a layer above a
changed layer as void until it is re-read.

```bash
gh pr view <number> --json number,title,state,isDraft,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup,url
gh pr diff <number>
gh pr checks <number>
```

### Change a lower layer

A change to a lower layer makes the stack non-linear, and the layers above it have to move. Inspect
first, with commands that only read:

```bash
git fetch <remote>
git status --porcelain                                   # this worktree: empty means clean
git log --oneline <remote>/<branch>..<branch>            # commits only the local branch has
git log --oneline <branch>..<remote>/<branch>            # commits only the remote has
git merge-base --is-ancestor <branch> <remote>/<branch>  # 0 yes, 1 no, anything else is an error
```

Read `--is-ancestor` by exit status, and treat a status other than 0 or 1 as a failed check rather
than an answer. Stop and report when a tree is dirty, holds untracked files, or has commits the
remote does not; preserving that work is the operator's call, not yours.

`git stash list` is worth reading too, but it does not decide anything on its own: the stash lives in
the shared directory `git rev-parse --git-common-dir` reports, so it lists entries from every
worktree of this repository. An entry that belongs to other work is not a reason to stop.

GitHub's **Rebase stack** button runs a server-side cascading rebase, which rewrites the remote layer
branches, so the local branches diverge from their remotes. Adopting a rewritten remote locally
pushes nothing: where the local branch has no commits of its own it only has to be moved onto the new
remote tip, and where it has commits of its own they are replayed onto that tip and pushed normally.
Both are the operator's call. Report what each side holds, leave the local refs in place so the old
tips stay reachable, and do not reset, check out with `--force`, or clean anything to get there.

`git merge --ff-only <remote>/<branch>` is not part of that inspection. It moves the branch and the
working tree when it can, so it belongs only in an update the operator has authorized, after
`--is-ancestor` says a fast-forward is possible.

Force-push is a different thing: it rewrites a branch other people already have, and is needed only
when the remote has to take a history it does not contain. It requires explicit authorization naming
the branch, after you show what would be lost, and it pins the lease to the tip you inspected rather
than trusting a bare lease against a remote-tracking ref that `git fetch` has just moved:

```bash
git push --force-with-lease=<branch>:<sha you inspected and showed> <remote> <branch>
```

Commits created by a server-side rebase are not signed, so a repository that requires signed commits
cannot use that button.

### Merge and clean up a stack

Merging a stacked pull request lands it and every unmerged pull request below it on the stack base as
one operation, bottom up. You can merge any contiguous group starting from the lowest unmerged pull
request, but not a middle one on its own. Afterwards the next unmerged pull request is automatically
rebased to target the stack base. Merging needs a linear stack; the merge box offers **Rebase stack**
when it is not linear. Merge queues are supported and auto-merge is not, and through the API a stack
needs the asynchronous merge endpoint rather than the synchronous one. The supported operator path is
the web merge box, with merge authorization refreshed against live state immediately beforehand.

What a merge triggers in checks, deployment, or release belongs to the target repository and is not
promised here. Remote branch deletion after merge depends on that repository's
`delete_branch_on_merge` setting and never removes local branches.

`finish-issue --delete-branch` deletes exactly one branch, the one attached to the worktree at
removal time, using `git branch -d`, which refuses an unmerged branch. Other layer branches stay.
Check out the canonical issue branch and leave the worktree clean before running it, then remove
leftovers deliberately:

```bash
git branch --list 'issue/<number>-*'
git branch -d <branch>
```

One branch at a time, never `-D`, and never in a loop without reading the list first.

## Independent review

Create a detached, isolated review worktree and Herdr workspace:

```bash
node /resolved/pi-clean/scripts/github-work.mjs review-pr <number> --reviewer claude
```

`claude` is the default reviewer and launches Claude Opus 5; `--reviewer codex` launches GPT-5.6-sol
under a `workspace-write` sandbox. Both instruct the reviewer not to spawn native subagents and pass
their vendor's flag for it, so a reviewer that needs help asks for a second visible session.

Review the full diff for correctness, regressions, security, error handling, maintainability,
test quality, and issue acceptance criteria. For a pull request in a stack, that diff is the
layer's own diff against its base branch, with the stack map for context, not the whole stack. Run focused validation when practical. Distinguish:

- blocking findings with file/line evidence and a concrete failure mode;
- non-blocking suggestions;
- questions caused by missing context;
- verified strengths worth preserving.

The authoring agent must not be the sole independent reviewer. When correctness depends on a new
or materially changed product, UX, interaction, visual, architecture, API, or data-model direction,
use Claude Opus 5 for the design review. Pi or Codex may review implementation fidelity and code
quality against an approved design, but must flag unresolved design judgment for Opus rather than
approving or redesigning it themselves. Do not edit the author worktree. Do not publish comments,
approval, or requested changes until authorized.

## Address feedback

The author works in the original issue worktree. Re-read each finding, verify it independently,
make focused changes, rerun relevant validation, and reply with evidence. Do not dismiss findings
solely because checks pass.

## Merge and cleanup

Merging always requires explicit user authorization. Immediately before merge, refresh PR state,
review decision, and checks. Follow repository merge strategy; do not bypass branch protection.

After merge or intentional abandonment, clean review worktrees first and the issue worktree last:

```bash
node /resolved/pi-clean/scripts/github-work.mjs cleanup-pr <pr-number>
node /resolved/pi-clean/scripts/github-work.mjs finish-issue <issue-number> --delete-branch
```

Stop the preview and any dependency processes you started for it, and close their panes, before
cleaning up the worktree. The helper refuses a dirty worktree and a working or blocked agent; it says
nothing about other processes, and whether removing the worktree stops a process running in a pane is
not documented in `herdr worktree remove --help` and was not tested here. Confirm yours are gone, and
never stop a service you did not start or that something else shares.

The helper must refuse dirty worktrees. Remote branch deletion is a separate consequential action.
`--delete-branch` handles one branch; a stack's other layer branches are removed deliberately, as
described above.
