# Shared GitHub workflow policy

## Sources of truth

- GitHub issue: intent, scope, acceptance criteria, and durable discussion.
- GitHub pull request: delivered change, validation evidence, and review history.
- Git worktree: isolated filesystem for one author or reviewer role.
- Herdr: live workspace, panes, and agent processes. Herdr IDs are ephemeral.
- Flightdeck: read-only operational overview populated by scans and telemetry.

Use the stable work ID `github:<owner>/<repo>:issue:<number>` for issue work. Use
`github:<owner>/<repo>:pr:<number>:review:<reviewer>` for independent reviews.

## Safety

Read-only `gh` and `git` commands may run without confirmation. Before creating or editing an
issue, publishing a comment/review, approving, closing, merging, or deleting a remote branch,
show the intended mutation and obtain confirmation unless the user's current request explicitly
authorizes that exact action. Merging always requires explicit confirmation.

Never expose authentication output, secrets, environment dumps, prompts, raw file contents, or
full command output in telemetry. Never use `rm -rf` to remove a worktree. Never remove a dirty
worktree or force-delete a branch without explicit authorization.

## Repository discovery

Before acting:

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef
git status --short --branch
```

Read the repository's `AGENTS.md`, `.github/ISSUE_TEMPLATE/`, and pull request template. Local
repository policy overrides generic formatting guidance in these skills.

## Isolated work

Issue implementation and PR review use `../../scripts/github-work.mjs`, resolved against the
directory containing the active skill's `SKILL.md`. Execute its absolute path, not a path relative
to the target repository:

```bash
node /resolved/pi-clean/scripts/github-work.mjs start-issue 123 --agent pi
node /resolved/pi-clean/scripts/github-work.mjs review-pr 456 --reviewer claude
node /resolved/pi-clean/scripts/github-work.mjs status
```

Worktrees live under:

```text
~/.local/share/agent-worktrees/github.com/<owner>/<repo>/issues/<number>-<slug>/
~/.local/share/agent-worktrees/github.com/<owner>/<repo>/prs/<number>/review-<reviewer>/
```

One branch and author worktree belong to one issue. Reviewers use separate detached worktrees.
Do not modify an author's worktree during independent review.

If `FLIGHTDECK_TELEMETRY_FILE` is configured, the helper emits best-effort Flightdeck-compatible
`worktree.created`, `agent.run.started`, and `worktree.removed` events only when those transitions
actually occur. Flightdeck remains observational and must not control GitHub, Git, Herdr, or agents.
