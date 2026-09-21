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

The `github-issues` and `github-pull-requests` skills define the agent workflow, and
[Reviewable delivery](reviewable-delivery.md) records the design behind their checkpoint, preview,
and stacked pull request rules. The read-only `scripts/github-planning.mjs` helper provides configured cross-repository snapshots, structural findings, draft validation, and the `/github-daily` evidence sequence; see [Deterministic GitHub planning](github-planning.md). The `scripts/github-work.mjs` helper separately owns worktree and Herdr lifecycle mechanics, and reads every executable launch setting from `scripts/agent-profiles.mjs`; see [Agent launch profiles](agent-launch-profiles.md).

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

Treat human review as the bottleneck: one human implementation, one active agent issue by default, and no more than two PRs awaiting human review, counting each stack layer separately. Start another agent issue only when it is unblocked, has low expected file overlap, and remains reviewable as a separate mental unit. Do not start parent outcomes, Inbox items, or Backlog items.

See [`skills/github-issues/references/project-workflow.md`](../skills/github-issues/references/project-workflow.md) for fields, views, automation, inspection commands, rollout, and web-UI limitations.

## Prerequisites

- `git`
- An authenticated GitHub CLI: `gh auth status`
- Herdr with `HERDR_ENV=1` when launching an agent or PR reviewer
- One registered primary checkout per repository

The primary checkout is the control plane and should remain on its default branch. Agents perform
implementation and independent review only in managed worktrees.

An issue worktree may hold more than one branch when its change is delivered as a stack of layer
pull requests. Two helper behaviors follow from that, and neither changes:

- On a rerun, `start-issue` derives the branch from whatever the worktree currently has checked out,
  so it reports the current layer, and passing a different `--branch` throws.
- `finish-issue --delete-branch` deletes exactly one branch, the one attached to the worktree at
  removal time, with `git branch -d`. Other layer branches remain and are removed deliberately.

Check out the canonical `issue/<number>-<slug>` branch and leave the worktree clean before
`finish-issue`.

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

## Interactive delegation policy

Pi-clean does not provide non-interactive Claude or Codex subprocess delegation. Delegated work must remain visible in Herdr. The externally managed `herdr` skill discovered from `~/.agents/skills/` describes response shapes, but verify its commands against `herdr --help`: the installed copy predates Herdr 0.8.2 and still documents the removed `herdr wait`. `herdr --skill` prints the current version; refreshing that personal file is an operator action, and this repository never edits it.

Use a split pane in the current workspace only for a bounded read-only investigation where sharing the checkout is safe. Starting another issue, or mutating any other checkout, uses `start-issue` and its isolated linked-worktree workspace. Independent review uses `review-pr`, which gives the reviewer a detached worktree in a named tab of a workspace this repository already has.

Placement follows the checkout, not the agent. One worktree has exactly one semantic Herdr workspace, so an agent delegated from inside an issue worktree stays in that worktree's workspace as a sibling pane or a named tab. Read the live `workspace_id` from `herdr pane current` and add to it; do not call `herdr workspace create` for a checkout that already has a workspace. A second workspace on one issue worktree fragments issue context and blocks `finish-issue`, which refuses cleanup with `multiple Herdr workspaces represent issue worktree`. A hosted review tab is not a second workspace; it is a separate checkout sharing the window. Panes and tabs are placement inside a shared checkout, never a substitute for worktree isolation.

Keep one writer at a time in a shared worktree. Read-only delegates may run alongside the writer, and a writing delegate takes that role exclusively while the coordinator stops editing. Concurrent writers require separate worktrees.

Any delegated work that establishes or materially changes product, UX, interaction, visual,
architecture, API, or data-model direction must assign that design to Claude Opus 5
(`claude-opus-5`). Fable may coordinate, but it must not edit implementation files or delegate
coding to another Fable instance unless Martin explicitly requests Fable implementation for that
specific task. Use Opus or Codex as coding workers. Pi and Codex may investigate constraints,
implement the durable Opus direction, and validate it. If implementation reveals a material design
gap, stop that part and return it to Opus rather than improvising. Capture the Opus direction in the
issue, a design artifact, or repository documentation before dependent implementation starts.

When coordinating with a delegated agent:

1. Observe `working` before considering the launch successful. If the agent becomes `blocked`, read its output and bring it to the operator's attention instead of continuing to wait.
2. After `working` has been observed, accept either `done` or `idle` as settled and read the final pane output. Herdr's `done` means completed but unread; focusing or reading the completed pane can acknowledge that ephemeral state and return it to `idle`, so a waiter must never require only `done`.
3. Keep the pane available so the operator can focus it to inspect, guide, interrupt, or resume the agent.

Launch settings come from `scripts/agent-profiles.mjs`. Managed Claude authors and reviewers run the `claude-opus` profile: `claude-opus-5`, effort `high`, `--permission-mode bypassPermissions`. Managed Codex authors and reviewers run `codex-sol-write`: `gpt-5.6-sol`, effort `high`, `--ask-for-approval never --sandbox workspace-write`. The removed `--full-auto` alias is gone, and no profile uses `danger-full-access`. Managed Pi and Codex prompts require an Opus handoff instead of inventing unresolved design.

Every rendered launch appends a delegation boundary to its prompt, and the vendor profiles add a flag at every effort level: Codex passes `--disable multi_agent`, Claude passes `--disallowed-tools Agent,Workflow` for its two documented spawning tools. `pi-ambient` has no such flag, because Pi loads extensions from personal settings that this repository does not control. These are boundaries, not guarantees. Each session still has a shell, the flags are not verified end to end, and neither profile sandboxes the host. A detached worktree isolates Git state rather than untrusted repository code; stronger sandboxing is separate follow-up work.

These profiles avoid repeated prompts for routine local reads, tests, and review commands. They do not authorize publishing a review, approving, merging, deleting remote branches, or another protected remote mutation without explicit operator approval.

Skill recipes and ad-hoc launches must not retype these flags. `node scripts/github-work.mjs launch-command --profile <id> [--effort <level>] --prompt <text>` prints the exact command, and `node scripts/github-work.mjs profiles` prints the pinned models, defaults, and verified CLI versions.

## Start issue implementation

From any checkout of the target repository, while running inside Herdr:

```bash
node /path/to/pi-clean/scripts/github-work.mjs start-issue 123
```

Supported agents are `claude`, `codex`, `pi`, and `none`. The default is `claude`, which pins Opus 5 at
effort `high`; `pi` remains available but takes its model, effort, and tool policy from personal
settings, so its runs are not reproducible from this repository. Inside Herdr,
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

The reviewer must be `pi`, `claude`, or `codex`; the default is `claude`. `--workspace <id>` picks
the host explicitly; otherwise the helper uses the caller's workspace when it belongs to this
repository, then the repository's primary workspace, and fails naming the candidates if neither
resolves. Tab and pane placement is verified on Herdr 0.9.1; an older Herdr without `tab create`,
`tab close`, `pane list` or `pane close` reports its own error rather than falling back to a
workspace. The helper fetches
GitHub's pull-request head ref and creates a detached review worktree. Every reviewer receives a
separate directory, preventing test artifacts and dependency installs from colliding, and runs as a
named tab in an existing workspace of the repository.

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
