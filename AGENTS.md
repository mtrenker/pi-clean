# Agent instructions

## GitHub workflow

Use the `github-issues` skill for issue management and `github-pull-requests` for pull requests
and reviews.

- Search for duplicates and inspect the relevant GitHub Project before creating or prioritizing issues.
- Parent issues describe outcomes; independently deliverable child issues carry bounded scope and testable acceptance criteria.
- Start agent or fleet implementation only from unblocked Ready child issues explicitly marked `agent-ready` when the repository uses that gate.
- Respect repository WIP and human review limits; do not parallelize work with likely file or architecture-boundary overlap.
- Implement issues only in worktrees created by `scripts/github-work.mjs`; keep the primary
  checkout clean as the control plane.
- Branch names use `issue/<number>-<slug>`.
- Every non-trivial pull request links an issue.
- Use `Closes #<number>` only when the PR fully resolves that issue.
- The authoring agent must not be the sole independent reviewer.
- Never merge, approve, publish a review, or force-delete work without explicit authorization.

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

Do not edit generated runtime files under `.pi/tasks/` or `.pi/archive/` unless the task is
specifically about fleet runtime state.
