---
name: github-issues
description: Manage GitHub issues and Projects with the gh CLI, including searching, creating, grooming, hierarchy, dependencies, labels, milestones, prioritization, and preparing work for humans or agents. Use for issue work, backlog/project maintenance, or turning findings into tracked execution.
compatibility: Requires git and an authenticated GitHub CLI (gh).
---

# GitHub issues

Read [the shared workflow policy](../_shared/github-workflow.md) before acting.

## Inspect before mutation

Scale inspection to the task: a status question or a single-issue read needs `gh issue view`, not a
sweep. Before creating, grooming, or prioritizing, resolve the current repository and inspect its issue forms, labels, milestones, open work, and relevant Project when one exists:

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

Search for duplicates with `gh issue list --search` on meaningful words from the proposed title and behavior, plus the draft validation result where a planning configuration exists. Inspect likely matches with `gh issue view <number> --json number,title,body,labels,state,comments,url`.

## Create an issue

Where a planning configuration exists (`github-planning.mjs config` succeeds), draft the issue as JSON and run `validate-draft` before publishing: its result shows the repository's issue-form expectations, label findings, plausible duplicates, and the complete `proposedMutation`. Without one the CLI exits with `CONFIG_NOT_FOUND`; then check labels and duplicates with the `gh` commands above, and do not treat the missing configuration as a blocker. Follow the repository's issue form where present.
A useful issue states the outcome, the next useful increment and where it stops, how to check it,
and what is left out, plus any constraints, dependencies, and risks. Link existing context and
evidence instead of repeating it. For example:

```markdown
## Outcome
Operators can see which required checks failed without opening CI logs.

## Next increment
List failed check names in `github-work status`. Stop there and show the output; a pull request
comment is a later increment.

## Check
In a worktree whose pull request has a failing required check, `status` names that check.

## Left out
Re-running checks. Context: [the CI discussion](URL).
```

Do not invent labels. Use only labels the repository defines, which draft validation also checks. Prefer `--body-file` over shell inline Markdown. Show the title, body, labels, assignees, parent, dependencies, milestone, and every Project field change before `gh issue create` unless already explicitly authorized. Draft validation never authorizes or performs publication.

Use parent issues for outcomes and child issues for independently deliverable units. Use native dependency relationships for blocking order. Create only the first executable wave rather than publishing a speculative full roadmap.

## Groom an issue

Read the entire issue and relevant comments. Check that it is still valid, non-duplicative,
appropriately scoped, and implementable without guessing. A ready issue has:

- a concrete outcome rather than a prescribed implementation where alternatives remain open;
- a bounded next increment with a stopping point, and named non-goals;
- testable acceptance criteria;
- known parent, dependencies, and blockers;
- repository-valid labels;
- architecture constraints and validation expectations;
- enough context for an agent starting in a fresh worktree.

Treat `agent-ready` as a strict admission gate when the repository uses it: a cold agent must not need to reconstruct chat history or make unresolved product, architecture, visual, security, or migration decisions. Unresolved design blocks readiness under [the shared design-ownership rule](../_shared/github-workflow.md#delegated-design-ownership); represent a substantial design pass as an Opus-owned blocking child issue or an explicit dependency. Use `needs-human` when human judgment is the next work. Never move work into Ready solely because it exists.

Propose issue, relationship, label, milestone, and Project-field changes before applying them. Preserve useful original context rather than silently replacing it.

## Report a project grooming pass

Lead with the update shape from the shared policy, then follow [the grooming report format](references/grooming-report.md):
linked titles on first mention, relationships in plain language, and for every item that needs
attention why it matters, the specific change, and the resulting next state. Include every Ready,
active, in-review, or blocked-near-Ready item; summarize the healthy rest by count.

## Select work

When a repository uses the recommended Project workflow, implementation candidates come from unblocked Ready issues. Agent work additionally requires the repository's agent-readiness marker. Respect Project WIP and human review limits; do not start parent issues, Backlog items, or multiple tasks likely to edit the same boundary.

## Start implementation

Use the shared helper rather than editing the primary checkout:

```bash
node /resolved/pi-clean/scripts/github-work.mjs start-issue <number>
```

The default agent is `claude`, which launches Claude Opus 5.5 at effort `high`. Before choosing a
different one, inspect whether the issue contains unresolved design. Design work stays with Opus.
Pass `--agent codex` or `--agent pi` only when the Opus direction is already durable and the issue is
bounded to investigation, implementation within it, or validation.

The primary checkout is a control plane. Implementation belongs in the returned worktree. Reuse
an existing issue worktree when the helper reports one.

One issue keeps one managed worktree and one Herdr workspace. That worktree delivers one pull
request, or a stack of layer pull requests when the change is worth reading in several units; see
[`github-pull-requests`](../github-pull-requests/SKILL.md) for the layer workflow. Layers create no
extra capacity, because each layer awaiting review counts as a pull request awaiting review.

Implementation also follows the increment, checkpoint, and preview contract in
[the shared workflow policy](../_shared/github-workflow.md): deliver the issue's next increment, show
it, and stop, unless the issue or the user explicitly asks for the whole issue to be finished; pause for a consequential or unspecified UI/UX decision with something running for the
user to look at; and treat design acceptance as permission to keep implementing, not to commit,
publish, or merge.

## Completion

Do not close an issue merely because code was written. It is complete only when its acceptance
criteria are met, required checks pass, and the repository's merge policy is satisfied. Use
`Closes #<number>` in a PR only when the PR fully resolves the issue; otherwise use `Refs #<number>`.
