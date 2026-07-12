---
name: github-pull-requests
description: Create, inspect, review, update, and safely complete GitHub pull requests with the gh CLI. Use for opening PRs from issue worktrees, checking CI, independent model reviews, addressing feedback, or preparing an authorized merge.
compatibility: Requires git, an authenticated GitHub CLI (gh), and Herdr for managed agent workspaces.
---

# GitHub pull requests

Read [the shared workflow policy](../_shared/github-workflow.md) before acting.

## Open a pull request

Work from the issue worktree, not the primary checkout. Before proposing a PR:

```bash
git status --short --branch
git diff --check
git log --oneline --decorate <base>..HEAD
git diff --stat <base>...HEAD
```

Run the repository's required validation. Push only the issue branch. Draft a PR using the local
pull request template and include:

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

## Independent review

Create a detached, isolated review worktree and Herdr workspace:

```bash
node /resolved/pi-clean/scripts/github-work.mjs review-pr <number> --reviewer claude
```

Review the full diff for correctness, regressions, security, error handling, maintainability,
test quality, and issue acceptance criteria. Run focused validation when practical. Distinguish:

- blocking findings with file/line evidence and a concrete failure mode;
- non-blocking suggestions;
- questions caused by missing context;
- verified strengths worth preserving.

The authoring agent must not be the sole independent reviewer. Do not edit the author worktree.
Do not publish comments, approval, or requested changes until authorized.

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

The helper must refuse dirty worktrees. Remote branch deletion is a separate consequential action.
