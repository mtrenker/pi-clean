# Shared GitHub workflow policy

## Sources of truth

- Product notes and architecture docs: research, vision, and durable decisions.
- GitHub parent issue: product or architecture outcome and child progress.
- GitHub child issue: one independently deliverable unit with intent, scope, acceptance criteria, and durable discussion.
- Native issue dependencies: execution ordering and blockers.
- GitHub milestone: a concrete release or externally meaningful outcome.
- GitHub Project: operational priority, readiness, status, and focused views; never a duplicate issue store.
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

Read the repository's `AGENTS.md`, `.github/ISSUE_TEMPLATE/`, and pull request template. Inspect its relevant GitHub Project when planning, prioritizing, or selecting work. Local repository policy overrides generic formatting guidance in these skills.

When a repository defines Ready and agent-ready states, start implementation only from unblocked child issues that satisfy those gates. Parent outcomes, Inbox items, and Backlog items are not implementation work. Human review capacity bounds active agent work and review concurrency.

## Delegated design ownership

Any delegated work that establishes or materially changes a solution direction must assign the
design to Claude Opus 5 (`claude-opus-5`). Design includes product, UX, interaction, visual,
architecture, API, and data-model decisions. Fable may coordinate, and Pi or Codex may investigate
constraints, implement an approved design, or validate it, but they must not originate or materially
revise unresolved design. Fable must not edit implementation files or assign coding to another Fable
instance unless Martin explicitly requests Fable implementation for that specific task; use Opus or
Codex as coding workers. Capture the Opus direction durably in the issue, an artifact, or repository
documentation and make it an explicit dependency of downstream implementation.

Routine implementation choices within an approved direction do not require a new design pass. If
an implementation agent discovers a material design gap, it must stop that part of the work and
request an Opus design handoff instead of improvising.

## Isolated work

Issue implementation and PR review use `../../scripts/github-work.mjs`, resolved against the
directory containing the active skill's `SKILL.md`. Execute its absolute path, not a path relative
to the target repository:

```bash
node /resolved/pi-clean/scripts/github-work.mjs start-issue 123
node /resolved/pi-clean/scripts/github-work.mjs review-pr 456 --reviewer claude
node /resolved/pi-clean/scripts/github-work.mjs status
```

Worktrees live under:

```text
~/.local/share/agent-worktrees/github.com/<owner>/<repo>/issues/<number>-<slug>/
~/.local/share/agent-worktrees/github.com/<owner>/<repo>/prs/<number>/review-<reviewer>/
```

Issue authors and reviewers default to the `claude-opus` profile: `claude-opus-5` at effort `high`,
prompting suppressed, native subagents disabled. Pass `--agent codex`, `--agent pi`, or `--agent none`
to change that. `launch-command --profile <id> --prompt <text>` prints the exact command for any other
session, so no recipe repeats a model or permission flag.

One branch and author worktree belong to one issue. Reviewers use separate detached worktrees.
Do not modify an author's worktree during independent review.

If `FLIGHTDECK_TELEMETRY_FILE` is configured, the helper emits best-effort Flightdeck-compatible
`worktree.created`, `agent.run.started`, and `worktree.removed` events only when those transitions
actually occur. Flightdeck remains observational and must not control GitHub, Git, Herdr, or agents.
