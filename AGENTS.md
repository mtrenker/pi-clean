# Agent instructions

## Scope and skill location

When Martin asks to write, add, or change a skill while working in this repository, treat it as a
repository skill. Create or update it under `skills/<skill-name>/SKILL.md`, never under a personal
home skill directory. A personal skill is only intended when Martin explicitly asks from his home
directory.

## GitHub workflow

Use the `github-issues` skill for issue management and `github-pull-requests` for pull requests
and reviews.

- Search for duplicates and inspect the relevant GitHub Project before creating or prioritizing issues.
- Parent issues describe outcomes; independently deliverable child issues carry bounded scope and testable acceptance criteria.
- Start agent implementation only from unblocked Ready child issues explicitly marked `agent-ready` when the repository uses that gate.
- Respect repository WIP and human review limits; do not parallelize work with likely file or architecture-boundary overlap.
- Implement issues only in worktrees created by `scripts/github-work.mjs`; keep the primary
  checkout clean as the control plane.
- Branch names use `issue/<number>-<slug>`.
- Every non-trivial pull request links an issue.
- Use `Closes #<number>` only when the PR fully resolves that issue.
- The authoring agent must not be the sole independent reviewer.
- Never merge, approve, publish a review, or force-delete work without explicit authorization.

## Delegation and design ownership

When delegating work that establishes or materially changes a solution direction, Claude Opus 5
(`claude-opus-5`) must own the design. This includes product, UX, interaction, visual, architecture,
API, and data-model design. Other models may investigate constraints, implement an approved Opus
design, and validate it, but must not invent or materially revise unresolved design. Fable may
coordinate the work, but it must assign the design phase to Opus. Fable is not a code implementation
model: it must not edit implementation files or delegate coding to another Fable instance unless
Martin explicitly requests Fable implementation for that specific task. Use Opus or Codex as coding
workers. Make the Opus design durable in the issue, an artifact, or repository documentation before
dependent implementation proceeds.

## Worktrees and Herdr

- Worktrees live under `~/.local/share/agent-worktrees/github.com/<owner>/<repo>/`.
- Use one author worktree per issue and detached worktrees for independent PR reviews.
- Use one Herdr workspace per active issue or independent review.
- Use semantic workspace labels such as `pi-clean · #123 · description`; do not persist Herdr's
  ephemeral workspace or pane IDs as durable identity.
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
