---
name: github-issues
description: Manage GitHub issues with the gh CLI, including searching, creating, grooming, labeling, prioritizing, and preparing issues for implementation. Use when work involves GitHub issues, issue numbers, backlog maintenance, or turning findings into tracked work.
compatibility: Requires git and an authenticated GitHub CLI (gh).
---

# GitHub issues

Read [the shared workflow policy](../_shared/github-workflow.md) before acting.

## Inspect before mutation

Resolve the current repository and inspect its issue forms and labels:

```bash
gh repo view --json nameWithOwner,defaultBranchRef
gh label list --limit 100 --json name,description,color
gh issue list --state open --limit 100 --json number,title,labels,url
```

Search for duplicates using meaningful words from the proposed title and behavior. Inspect likely
matches with `gh issue view <number> --json number,title,body,labels,state,comments,url`.

## Create an issue

Draft the complete issue before publishing it. Follow the repository's issue form where present.
A useful issue normally contains:

- problem or desired outcome;
- context and evidence;
- explicit scope and non-goals;
- acceptance criteria that can be verified;
- constraints, dependencies, and risks;
- validation expectations.

Do not invent labels. Use only labels returned by `gh label list`. Prefer `--body-file` over shell
inline Markdown. Show the title, body, and labels before `gh issue create` unless already explicitly
authorized.

## Groom an issue

Read the entire issue and relevant comments. Check that it is still valid, non-duplicative,
appropriately scoped, and implementable without guessing. A ready issue has:

- a concrete outcome rather than a prescribed implementation where alternatives remain open;
- bounded scope and named non-goals;
- testable acceptance criteria;
- known dependencies and blockers;
- repository-valid labels;
- enough context for an agent starting in a fresh worktree.

Propose edits and label changes before applying them. Preserve useful original context rather than
silently replacing it.

## Start implementation

Use the shared helper rather than editing the primary checkout:

```bash
node /resolved/pi-clean/scripts/github-work.mjs start-issue <number> --agent pi
```

The primary checkout is a control plane. Implementation belongs in the returned worktree. Reuse
an existing issue worktree when the helper reports one.

## Completion

Do not close an issue merely because code was written. It is complete only when its acceptance
criteria are met, required checks pass, and the repository's merge policy is satisfied. Use
`Closes #<number>` in a PR only when the PR fully resolves the issue; otherwise use `Refs #<number>`.
