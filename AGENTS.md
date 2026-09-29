# Agent instructions

## Scope and skill location

When Martin asks to write, add, or change a skill while working in this repository, treat it as a
repository skill. Create or update it under `skills/<skill-name>/SKILL.md`, never under a personal
home skill directory. A personal skill is only intended when Martin explicitly asks from his home
directory.

## Prose

Follow the `prose-quality` skill for human-facing prose, including replies, commits, PR and issue
bodies, reviews, docs, release notes, and social drafts.

## GitHub workflow

Use the `github-issues` skill for issue management and `github-pull-requests` for pull requests
and reviews.

- Search for duplicates and inspect the relevant GitHub Project before creating or prioritizing issues.
- Parent issues describe outcomes; independently deliverable child issues carry bounded scope and testable acceptance criteria.
- Start agent implementation only from unblocked Ready child issues explicitly marked `agent-ready` when the repository uses that gate.
- Respect repository WIP and human review limits; do not parallelize work with likely file or architecture-boundary overlap.
- Follow the reviewable delivery contract in `skills/_shared/github-workflow.md`: pause for a
  consequential UI/UX decision with a running preview, and keep design acceptance separate from
  commit, publication, and merge authorization. Each stack layer awaiting review counts against
  the review limit.
- For this repository (`mtrenker/pi-clean`) only, work on a feature branch in the primary
  checkout unless Martin explicitly requests a worktree. Pi loads extensions from this checkout,
  so this lets Martin test the branch directly. This exception overrides worktree-only placement
  rules in the workflow skills and instructions below; it does not apply to other repositories.
  Preserve unrelated local changes and keep one writer at a time. Do not run `start-issue` or
  `review-pr` merely to create a worktree under this exception. Issue readiness, independent
  review, validation, and authorization requirements still apply.
- Branch names use `issue/<number>-<slug>`; extra review layers for the same issue use
  `issue/<number>-<slug>--<layer-slug>` in that same checkout.
- Every non-trivial pull request links an issue.
- Use `Closes #<number>` only when the PR fully resolves that issue.
- The authoring agent must not be the sole independent reviewer.
- Never merge, approve, publish a review, or force-delete work without explicit authorization.

## Delegation and design ownership

[Delegated design ownership](skills/_shared/github-workflow.md#delegated-design-ownership) in the
shared workflow policy is the rule, in full: Claude Opus 5.5 owns any delegated design, Opus or
Codex do the coding, and Fable coordinates without editing implementation files unless Martin
explicitly asks for Fable implementation on that task. Follow it from there rather than from a
paraphrase.

Launch settings for delegated sessions live in `scripts/agent-profiles.mjs` and are documented in
[`docs/agent-launch-profiles.md`](docs/agent-launch-profiles.md); which model each profile pins, and
the evidence behind it, is in [`docs/model-selection.md`](docs/model-selection.md). Get a command from
`node scripts/github-work.mjs launch-command`; never write a model, effort, or permission flag into
a recipe. Every launch carries a prompt instruction against native worker spawning, and the Claude
and Codex profiles add a vendor flag for it; Pi's extension surface is not controlled by these
profiles. Delegate as a visible Herdr pane or tab.

## Worktrees and Herdr

For pi-clean's default branch-based workflow, reuse the checkout's existing Herdr workspace.
Independent reviewers may inspect the shared checkout read-only while the author pauses changes;
review independence does not require a separate checkout. If isolation is needed, ask Martin for a
worktree rather than creating one automatically. The worktree placement rules below apply when a
worktree is requested, or when working in another repository.

- Worktrees live under `~/.local/share/agent-worktrees/github.com/<owner>/<repo>/`.
- Use one author worktree per issue and detached worktrees for independent PR reviews.
- Use one Herdr workspace per active issue. An independent review keeps its own detached
  worktree and runs as a named tab in a workspace of this repository, never in a new one.
- Agents delegated from inside an issue worktree stay in that worktree's workspace as sibling
  panes or named tabs. Create a separate worktree and workspace only when a subtask needs a
  checkout the current one must not disturb; a tab is placement, not isolation.
- Keep one writer at a time in a shared worktree. Read-only delegates may run alongside it.
- Labels name what a child is, not which repository it belongs to: `#123 · short title` for an
  issue workspace, `Implementation` for its author tab, `PR #456 · Review` for a review tab. Never
  identify a workspace by its label; use the repository root and checkout Herdr reports. Do not
  persist Herdr's ephemeral workspace or pane IDs as durable identity.
- Never remove a dirty worktree or use `rm -rf` for worktree cleanup.

## Validation

For TypeScript extension changes, run focused tests and:

```bash
npx tsc --noEmit
```

For the GitHub work helper, run:

```bash
node --check scripts/github-work.mjs
npm run test:github-work
node scripts/github-work.mjs help
```
