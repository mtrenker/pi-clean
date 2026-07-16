# GitHub issue, worktree, Herdr, and PR workflow

This package separates durable project state from live execution:

| Layer | Responsibility |
| --- | --- |
| Product and architecture docs | Research, vision, and durable decisions |
| GitHub parent issues | Outcomes and sub-issue progress |
| GitHub child issues | Independently deliverable intent, scope, acceptance criteria, and discussion |
| Native issue dependencies | Blocking order between work units |
| Milestones | Concrete releases or externally meaningful outcomes |
| GitHub Project | Operational priority, readiness, status, and focused views |
| GitHub pull requests | Delivered changes, checks, and durable review history |
| Git worktrees | Isolated filesystems for authors and independent reviewers |
| Herdr | Live workspaces, agents, tests, servers, and logs |
| Flightdeck | Read-only operational overview and attention signals |

The `github-issues` and `github-pull-requests` skills define the agent workflow. The read-only `scripts/github-planning.mjs` helper provides configured cross-repository snapshots, structural findings, draft validation, and the `/github-daily` evidence sequence; see [Deterministic GitHub planning](github-planning.md). The `scripts/github-work.mjs` helper separately owns worktree and Herdr lifecycle mechanics.

## Project planning and work admission

Use one lightweight Project for a product or repository ecosystem rather than separate Projects for each team, milestone, or architecture area. Keep issue bodies as the durable source of truth; Project fields only schedule and expose the work.

The recommended minimum is:

- **Status:** Inbox, Backlog, Ready, In progress, In review, Done
- **Priority:** P0 urgent, P1 active outcome, P2 next, P3 later
- **Size:** XS, S, M, L; split L before Ready
- **Hierarchy:** one parent outcome and independently deliverable child issues
- **Dependencies:** native blocked-by/blocking relationships
- **Agent admission:** unblocked Ready child issues explicitly marked `agent-ready`

A Ready issue names its outcome, scope, non-goals, acceptance criteria, relationships, architecture constraints, and validation. `agent-ready` additionally means a cold agent can execute from a fresh worktree without reconstructing chat history or making unresolved product, architecture, visual, security, or migration decisions.

Treat human review as the bottleneck: one human implementation, initially two or three parallel agents, and no more than two PRs awaiting human review. Fleet candidates must be unblocked siblings with low expected file overlap. Do not start parent outcomes, Inbox items, or Backlog items.

See [`skills/github-issues/references/project-workflow.md`](../skills/github-issues/references/project-workflow.md) for fields, views, automation, inspection commands, rollout, and web-UI limitations.

## Prerequisites

- `git`
- An authenticated GitHub CLI: `gh auth status`
- Herdr with `HERDR_ENV=1` when launching an agent or PR reviewer
- One registered primary checkout per repository

The primary checkout is the control plane and should remain on its default branch. Agents perform
implementation and independent review only in managed worktrees.

## Directory and identity conventions

The default root is deliberately outside normal project directories:

```text
~/.local/share/agent-worktrees/
└── github.com/<owner>/<repo>/
    ├── issues/<number>-<slug>/
    └── prs/<number>/review-<reviewer>/
```

Override it with `GITHUB_WORKTREE_ROOT`. Repository owner and name are part of the path to prevent
collisions between repositories with the same basename.

Durable correlation uses semantic work IDs:

```text
github:<owner>/<repo>:issue:<number>
github:<owner>/<repo>:pr:<number>:review:<reviewer>
```

Herdr workspace and pane IDs are live routing handles and must not be persisted as identity because
they may compact after workspaces or panes close.

## Start issue implementation

From any checkout of the target repository, while running inside Herdr:

```bash
node /path/to/pi-clean/scripts/github-work.mjs start-issue 123 --agent pi
```

Supported agents are `pi`, `claude`, `codex`, and `none`. The default is `pi`. Inside Herdr,
issue-author checkouts use Herdr's linked-worktree API even with `--agent none`. Outside Herdr,
`--agent none` provides the compatibility path that creates only a direct Git worktree.

The command:

1. validates tools and native Herdr worktree support before mutating Git state;
2. resolves the GitHub repository, default branch, and issue;
3. fetches the remote and asks `herdr worktree create` to create `issue/<number>-<slug>` from the fetched default-branch base;
4. refuses to reuse a matching branch checked out outside the managed path;
5. asks `herdr worktree open` to open or reuse an existing managed issue checkout;
6. uses the returned root pane to launch the requested agent only when a workspace was newly created;
7. returns machine-readable JSON.

This native path retains repository and checkout provenance so Herdr groups the issue workspace
with its parent repository. A rerun reuses the managed worktree and linked workspace. It does not
relaunch the agent or falsely emit a new agent-start event. Herdr 0.7.3 or newer is required;
unsupported native commands produce a compatibility error rather than a generic workspace.

## Review a pull request independently

```bash
node /path/to/pi-clean/scripts/github-work.mjs review-pr 456 --reviewer claude
```

The reviewer must be `pi`, `claude`, or `codex`; the default is `claude`. The helper fetches
GitHub's pull-request head ref and creates a detached review worktree. Every reviewer receives a
separate directory and Herdr workspace, preventing test artifacts and dependency installs from
colliding.

A reused review worktree is refreshed only when clean. Reviewers should not modify the author's
issue worktree or publish a review without authorization.

## Inspect and clean up

```bash
node /path/to/pi-clean/scripts/github-work.mjs status
node /path/to/pi-clean/scripts/github-work.mjs cleanup-pr 456
node /path/to/pi-clean/scripts/github-work.mjs finish-issue 123
node /path/to/pi-clean/scripts/github-work.mjs finish-issue 123 --delete-branch
```

Cleanup is restricted to paths under the managed root. For an issue checkout represented by a
Herdr linked-worktree workspace, `finish-issue` uses `herdr worktree remove --workspace <id>`.
Legacy generic issue workspaces and non-Herdr `--agent none` checkouts retain the safe direct-Git
cleanup path. Pull-request review worktrees are unchanged.

Cleanup refuses to:

- remove a dirty worktree;
- remove or close a Herdr workspace whose agent is `working` or `blocked`;
- pass Herdr's force-removal option;
- force-delete a branch.

The `--delete-branch` option remains separate and uses `git branch -d`, so Git still refuses
deletion when the branch is not safely merged. Remote branch deletion is intentionally not
implemented.

## Flightdeck

Flightdeck already discovers linked worktrees by running `git worktree list --porcelain` from its
registered primary repository. If Flightdeck runs in a container, mount the managed worktree root
read-only at the same absolute path so status scans can access it.

Optionally configure a compatible telemetry sink:

```bash
export FLIGHTDECK_TELEMETRY_FILE="$HOME/ai/hub/apps/flightdeck/logs/flightdeck-telemetry.jsonl"
```

The helper emits truthful, best-effort events:

- `worktree.created` only after creating a worktree;
- `agent.run.started` only after Herdr starts an agent;
- `worktree.removed` after safe removal.

Telemetry failure is reported as a warning but does not turn a successful Git or Herdr mutation
into a failed command. Events contain identifiers and paths, never prompts, credentials, raw file
contents, command output, or environment dumps. Flightdeck remains read-only and never controls
GitHub, Git, Herdr, or agents.

## Repository rollout

Each repository should add a concise `AGENTS.md` containing only local policy:

- point to the two GitHub skills;
- require managed worktrees for implementation and review;
- define valid labels and definition of ready/done;
- specify validation commands and merge strategy;
- require independent review where appropriate.

Issue forms and a pull request template belong in that repository's `.github/` directory. Do not
copy repository-specific labels or commands into the reusable skills.
