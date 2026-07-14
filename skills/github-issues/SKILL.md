---
name: github-issues
description: Manage GitHub issues and Projects with the gh CLI, including searching, creating, grooming, hierarchy, dependencies, labels, milestones, prioritization, and preparing work for humans, agents, or fleets. Use for issue work, backlog/project maintenance, or turning findings into tracked execution.
compatibility: Requires git and an authenticated GitHub CLI (gh).
---

# GitHub issues

Read [the shared workflow policy](../_shared/github-workflow.md) before acting.

## Inspect before mutation

Resolve the current repository and inspect its issue forms, labels, milestones, open work, and relevant Project when one exists:

```bash
gh repo view --json nameWithOwner,defaultBranchRef
gh label list --limit 100 --json name,description,color
gh issue list --state open --limit 100 --json number,title,labels,milestone,url
gh api repos/{owner}/{repo}/milestones?state=all --paginate
```

For configured cross-repository inspection, use the deterministic planning CLI instead of rebuilding Project queries and structural checks from prose. Resolve `../../scripts/github-planning.mjs` against this `SKILL.md` directory, then run one of:

```bash
node /resolved/pi-clean/scripts/github-planning.mjs snapshot [portfolio] --format json
node /resolved/pi-clean/scripts/github-planning.mjs groom [portfolio] --format json
node /resolved/pi-clean/scripts/github-planning.mjs daily [portfolio] --format json
node /resolved/pi-clean/scripts/github-planning.mjs validate-draft [portfolio] --draft <path>
```

The CLI is read-only and fails rather than presenting partial data as clean. Treat its stable finding codes as deterministic evidence, not semantic priority or a readiness score. See [`../../docs/github-planning.md`](../../docs/github-planning.md) for the configuration contract, schema, ordering, reason codes, and failure behavior.

When the task involves planning, prioritization, agent readiness, or a Project, read [the Project-aware workflow reference](references/project-workflow.md) and inspect the existing Project before proposing mutations. Prefer one relevant Project with focused views over duplicate Projects.

Search for duplicates using the CLI's draft result and meaningful words from the proposed title and behavior. Inspect likely matches with `gh issue view <number> --json number,title,body,labels,state,comments,url`.

## Create an issue

Draft the complete issue as JSON and run `github-planning.mjs validate-draft` before publishing it. The result must show repository issue-form expectations, valid-label findings, plausible duplicate candidates, and the complete `proposedMutation`. Follow the repository's issue form where present.
A useful issue normally contains:

- problem or desired outcome;
- context and evidence;
- explicit scope and non-goals;
- acceptance criteria that can be verified;
- constraints, dependencies, and risks;
- validation expectations.

Do not invent labels. Use only labels accepted by draft validation. Prefer `--body-file` over shell inline Markdown. Show the title, body, labels, assignees, parent, dependencies, milestone, and every Project field change before `gh issue create` unless already explicitly authorized. Draft validation never authorizes or performs publication.

Use parent issues for outcomes and child issues for independently deliverable units. Use native dependency relationships for blocking order. Create only the first executable wave rather than publishing a speculative full roadmap.

## Groom an issue

Read the entire issue and relevant comments. Check that it is still valid, non-duplicative,
appropriately scoped, and implementable without guessing. A ready issue has:

- a concrete outcome rather than a prescribed implementation where alternatives remain open;
- bounded scope and named non-goals;
- testable acceptance criteria;
- known parent, dependencies, and blockers;
- repository-valid labels;
- architecture constraints and validation expectations;
- enough context for an agent starting in a fresh worktree.

Treat `agent-ready` as a strict admission gate when the repository uses it: a cold agent must not need to reconstruct chat history or make unresolved product, architecture, visual, security, or migration decisions. Use `needs-human` when human judgment is the next work. Never move work into Ready solely because it exists.

Propose issue, relationship, label, milestone, and Project-field changes before applying them. Preserve useful original context rather than silently replacing it.

## Select work

When a repository uses the recommended Project workflow, implementation candidates come from unblocked Ready issues. Agent or fleet work additionally requires the repository's agent-readiness marker. Respect Project WIP and human review limits; do not start parent issues, Backlog items, or multiple tasks likely to edit the same boundary.

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
