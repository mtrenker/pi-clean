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
- concise explanation of behavior and design decisions;
- each validation command and its result on one short line, including failures, linking lengthy output;
- risks, limitations, migrations, or screenshots where relevant.

Keep the body within one screen: what changed and why, one line per validation command with its
result, and links to evidence rather than pasted output. Show the final title, body, base, and head
before `gh pr create` unless the request already authorized opening it; `push it` or `create the PR`
does, and then commit, push, and open it without another question. Prefer `--body-file`.

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
test quality, and issue acceptance criteria. Flag tests that add maintenance without guarding a
credible risk, as well as missing important checks. Hypothetical future needs do not expand scope.
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

After merge or intentional abandonment, clean review worktrees first and the issue worktree last:

```bash
node /resolved/pi-clean/scripts/github-work.mjs cleanup-pr <pr-number>
node /resolved/pi-clean/scripts/github-work.mjs finish-issue <issue-number> --delete-branch
```

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

The helper must refuse dirty worktrees. Remote branch deletion is a separate consequential action.
`--delete-branch` handles one branch; a stack's other layer branches are removed deliberately, as
[the stacked pull requests reference](references/stacked-pull-requests.md#merge-and-clean-up-a-stack)
describes.
