---
name: github-pull-requests
description: Create, inspect, review, update, and safely complete GitHub pull requests with the gh CLI. Use for opening PRs from issue worktrees, checking CI, independent model reviews, addressing feedback, or preparing an authorized merge.
compatibility: Requires git, an authenticated GitHub CLI (gh), and Herdr for managed agent workspaces.
---

# GitHub pull requests

Read [the shared workflow policy](../_shared/github-workflow.md) before acting. It defines the
checkpoint, preview, commit, and layer concepts and the authorization each one needs.
Apply [agile-engineering](../agile-engineering/SKILL.md) when judging scope and validation.

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
- delivered behavior and its value, not a file-by-file change log;
- meaningful deviations from the linked issue or accepted design, without retelling either;
- each validation command and its result on one short line, including failures, linking lengthy output;
- relevant risks, limitations and unverified behavior; screenshots when they prove a claim.

Aim for one screen, not a word quota. Link the issue for intent and scope, and evidence for detail.
Keep information that changes a review or merge decision; omit empty sections and boilerplate
unless the repository requires them. Open it without showing it first when
[routine delivery](../_shared/github-workflow.md#routine-delivery) covers the task or the request
authorized it (`push it`, `create the PR`): commit, push, and open it without another question.
Otherwise show the final title, body, base, and head before `gh pr create`. Prefer `--body-file`.

## Inspect a pull request

```bash
gh pr view <number> --json number,title,body,state,isDraft,author,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup,closingIssuesReferences,url
gh pr diff <number> --name-only
gh pr checks <number>
```

Read linked issue context and repository instructions. Do not trust the PR description as proof
that code or tests are correct.

## Stacked pull requests

One pull request per issue is the default, and no consuming repository has used a stack yet. When a
change is worth reading in several units, [stacked pull requests](references/stacked-pull-requests.md)
has the layer branch naming, the operator steps on GitHub, the rules for changing a lower layer, and
merge and cleanup. A layer awaiting review counts against review capacity like any other pull
request, and `finish-issue --delete-branch` removes only the branch attached to the worktree.

## Independent review

Create a detached, isolated review worktree. The reviewer runs in a named tab of a workspace this
repository already has, so the review sits beside the work it reviews without a new workspace:

```bash
node /resolved/pi-clean/scripts/github-work.mjs review-pr <number> --reviewer claude
```

`claude` is the default reviewer and launches Claude Opus 5.5; `--reviewer codex` launches GPT-6 Sol
under a `workspace-write` sandbox. Both instruct the reviewer not to spawn native subagents and pass
their vendor's flag for it, so a reviewer that needs help asks for a second visible session.

Review the full diff for correctness, regressions, security, error handling, maintainability,
test quality, and issue acceptance criteria. Judge tests with the questions in
[Test what earns its place](../agile-engineering/SKILL.md#test-what-earns-its-place): a request
for a test names the failure it would catch, and a finding against a test names its concrete
defect or cost, such as that it cannot fail, pins nothing depended on, or duplicates other evidence.
Neither is a default finding. Check that the change completes the agreed behavior, including
affected callers and configuration, without adding speculative capabilities. Check that the PR
makes the value, deviations and unverified behavior clear without repeating the issue. A report
that names tests but leaves its claimed outcome unverified needs that gap stated. Hypothetical
future needs do not expand scope.
For a pull request in a stack, that diff is the
layer's own diff against its base branch, with the stack map for context, not the whole stack. Run focused validation when practical. Lead the report with the verdict and the decision it needs, then distinguish:

- blocking findings with file/line evidence and a concrete failure mode;
- non-blocking suggestions;
- questions caused by missing context.

The authoring agent must not be the sole independent reviewer. A review that has to judge a new or
materially changed design direction follows [the shared design-ownership rule](../_shared/github-workflow.md#delegated-design-ownership):
Opus reviews the design, and other reviewers flag unresolved design judgment rather than approving
or redesigning it. Do not edit the author worktree. Do not publish comments, approval, or requested
changes until authorized.

## Address feedback

The author works in the original issue worktree. Re-read each finding, verify it independently,
make focused changes, rerun relevant validation, and reply with evidence. Do not dismiss findings
solely because checks pass.

## Merge and cleanup

Merging always requires explicit user authorization. Immediately before merge, refresh PR state,
review decision, and checks. Follow repository merge strategy; do not bypass branch protection.

When Martin says a pull request merged, that is the grant to clean up its task without asking
again. After merge or intentional abandonment, clean review worktrees first and the issue worktree
last:

```bash
node /resolved/pi-clean/scripts/github-work.mjs cleanup-pr <pr-number>
node /resolved/pi-clean/scripts/github-work.mjs finish-issue <issue-number> --delete-branch
```

Before removing anything, both commands check that every local commit is in a pull request head
GitHub reports or in the remote default branch as `git ls-remote` reports it, so squash and rebase
merges clean up like merge commits. A clean status, a remote-tracking ref, and `git branch -d` are
not that evidence. `--delete-branch` then deletes the branch with `-D`, for the proven tip only, and
reports what preserved it. Each command refuses, having removed nothing, on local-only commits, a
dirty worktree, an active or blocked agent, a hosted review, a pane working outside the checkout in
a workspace it would close, or evidence it cannot obtain. Report a
refusal; do not work around it. [The design record](../../docs/reviewable-delivery.md#amendment-routine-delivery-and-verified-cleanup)
has the reasoning.

Run from the issue's own workspace, `finish-issue` cannot remove the session running it. It runs
every check, then opens a visible `#<n> · Cleanup` tab in the repository's primary workspace that
waits for your pane to settle and repeats the command. Report that tab and stop. Without a single
primary workspace it refuses and prints the command to run from the primary checkout once you have
stopped.

A shared checkout with no worktree, such as pi-clean's feature branch in the primary checkout, has
nothing for the helper to remove. Verify the same evidence, then return to the default branch:

```bash
gh pr view <number> --json state,headRefName,headRefOid,isCrossRepository  # MERGED, <branch>, false
TIP=$(git rev-parse --verify refs/heads/<branch>)        # the tip you prove, and the only one you delete
git fetch <remote> <default> pull/<number>/head          # objects for the check
git rev-list --count "$TIP" --not <headRefOid> "$(git ls-remote <remote> refs/heads/<default> | cut -f1)"  # 0, or stop
git switch <default> && git merge --ff-only <remote>/<default>
test "$(git rev-parse --verify refs/heads/<branch>)" = "$TIP" && git branch -D <branch>  # a moved branch stays
```

If `git switch` refuses because of uncommitted changes that are not yours, stop and report them. If
the last line deletes nothing, the branch moved after the check: report it and keep it.

`cleanup-pr` closes the panes whose directory is that review's worktree, closes their tab only when
it held nothing else, and closes a workspace only when that workspace's own checkout is the review
worktree. The host workspace, the author's tab, another review and any unrelated pane are left alone.
It refuses while a review agent is working or blocked. `finish-issue` refuses while its workspace
still hosts a review checkout, and names the review to clean up or move first.

Stop the preview and any dependency processes you started for it, and close their panes, before
cleaning up the worktree. The helper refuses a dirty worktree and a working or blocked agent; it says
nothing about other processes, and whether removing the worktree stops a process running in a pane is
not documented in `herdr worktree remove --help` and was not tested here. Confirm yours are gone, and
never stop a service you did not start or that something else shares.

The helper must refuse dirty worktrees. Remote branch deletion is a separate consequential action:
report a remote branch that is still there rather than deleting it.
`--delete-branch` handles one branch; a stack's other layer branches are removed deliberately, as
[the stacked pull requests reference](references/stacked-pull-requests.md#merge-and-clean-up-a-stack)
describes.
