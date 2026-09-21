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
authorizes that exact action, including an explicit advance authorization for a bounded task.
Merging always requires explicit confirmation. Reviewable delivery below separates the kinds of
authorization and states what design acceptance does not grant.

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

## Reviewable delivery

Deliver work in units the user can read and redirect rather than one diff at the end. [The design
record](../../docs/reviewable-delivery.md) explains the reasoning; the rules are here.

### Four concepts

| Concept | What it is | What it is not |
| --- | --- | --- |
| Checkpoint | A pause where you show a consequential UI/UX decision and wait for the user's judgment | Not a commit, not a pull request, not permission for either |
| Preview | A running instance you loaded yourself, with the route to open and what to look at | Not a deliverable, deployment, or durable environment |
| Commit | One coherent local step in a branch's history | Not implied by an accepted checkpoint |
| Layer | A pull request whose diff is one reviewable unit, based on the layer below it | Not implied by a checkpoint, and not opened or published on its own |

Accepting a design at a checkpoint authorizes continuing to implement in that direction, and nothing
else. A checkpoint may be followed by a commit, a layer boundary, both, or neither. A layer boundary
is a good moment to offer a checkpoint but does not require one. Preparing a pull request means
drafting its title, body, base, and head and showing them, not running `gh pr create`.

### Authorization

Five kinds, none implied by another:

1. **Experience acceptance:** continue implementing the accepted direction.
2. **Commit:** commit a described step in this worktree. A task you were asked to implement
   includes committing its coherent steps on its branch, so this needs a grant of its own only where
   the target repository requires approval before committing.
3. **Publication:** push a branch, open a pull request, mark a draft ready, request a review, or
   publish a review or comment.
4. **Merge:** merge a pull request or a stack.
5. **Destructive operation:** rewrite or discard work, force-push, delete a branch or worktree.

The user grants one either at the moment of the action or in advance for a bounded task. Confirm a
consequential action unless the current request explicitly authorizes that exact action, and never
turn an authorized task into a question per commit. An advance grant covers the actions it names for
that task and nothing above them in the list.

Design acceptance is never one of these grants. It does not make a commit acceptable where the
repository requires approval first, and it authorizes no publication and no merge. A stricter rule in
the target repository still binds. Merging always needs authorization refreshed against live state
immediately beforehand.

### Checkpoints

Pause and ask when:

- a product, UX, interaction, visual, architecture, API, or data-model decision is needed and the
  issue and durable design records do not settle it;
- you are about to decide an unspecified composition: layout, field grouping, hierarchy, empty,
  loading or error states, a new token or style recipe, motion, or the shape of a form or surface;
- consequential UI/UX work is about to be built out, in which case show a renderable composition or
  a vertical slice early, while redirecting is still cheap;
- the issue itself names a milestone as needing review;
- implementation reveals a material deviation from the accepted direction.

Do not pause for routine work inside an accepted direction: a rename, a prop, an obvious control, a
test, a refactor with no visible consequence, a lint fix. Once a direction or pattern is accepted,
small changes within it do not pause again, and opening a layer is not by itself a reason to pause.
When you are unsure whether a decision is consequential, state the assumption, continue, and list it
in the next checkpoint or the pull request body rather than blocking.

A checkpoint states the decision in one sentence and what you would do without an answer, the
options you actually considered where more than one is reasonable, a preview for any UI/UX decision,
and what you are explicitly not asking about. A bounded prototype is a legitimate way to make an
unresolved visual choice inspectable; say that it is a prototype, because showing one does not make
it accepted production design.

Silence never resumes a checkpoint. Wait for an explicit answer; a quiet pane, a timeout, or your own
conclusion that the direction has become obvious is not one.

Ask in your own session so Herdr can raise `blocked`, and raise an operator-visible signal as well.
[`interactive-agent-sessions`](../interactive-agent-sessions/SKILL.md) has the commands and the
placement rules.

While a checkpoint is open, change nothing that could alter what the user is looking at. That is
more than not committing: no edits to code, data, configuration, or fixtures; no branch switch,
rebase, merge, reset, or checkout; no dependency install; no rebuild or restart of the preview. Reads
are fine, including read-only tests and tools. A test or tool that writes files, regenerates
fixtures, migrates a database, or rebuilds artifacts is not, so run it before opening the checkpoint
or after it closes. This is a rule about your conduct, not a guarantee about the filesystem: the user
may change the tree, so re-check state when work resumes instead of assuming you left it that way.

### Previews

A UI/UX checkpoint without a running instance you loaded yourself is incomplete. Give the URL, the
exact route or story to open, the viewports and themes worth checking, and confirmation that you saw
it render. Run it in a visible Herdr pane or named tab in this worktree's existing workspace, never
as a background job and never in a second workspace for this checkout.

Every process the surface needs runs the same way. An API, database, worker, or watcher it depends on
gets its own visible pane or tab, started from the repository's documented commands, in the
foreground. The checkpoint is not ready until all of them are up and you have opened the route
yourself.

Start commands belong to the target repository, not to these skills. Each repository documents, for
every previewable surface, how to start it, how to pick a port that does not collide with another
worktree, what data or fixture isolation it needs, and how to tear it down. Managed worktrees isolate
files, not ports or shared databases. Verify the port is free before binding, and record the URL in
the checkpoint and in the pull request body. When the repository documents none of this, say
so and ask rather than improvising a start command. Stop what you started before the worktree is
cleaned up, and never stop a service you did not start or that something else shares. Removing
per-worktree data is a separate step, and a destructive one.

### Review capacity

A pull request layer awaiting human review counts as a pull request awaiting review. Splitting one
issue into more layers creates no extra capacity and does not bypass the repository's admission
gates or WIP limits. Keep later layers unpublished, or as drafts with no review requested, until
capacity frees.

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

One author worktree belongs to one issue, and so does its Herdr workspace. That worktree holds the
issue branch, plus any layer branches when the change is delivered as a stack. Reviewers use separate
detached worktrees. Do not modify an author's worktree during independent review.

A review's separate filesystem does not mean a separate workspace. `review-pr` places the reviewer in
a named tab of a workspace this repository already has: the one you are in, or the primary checkout's
workspace. It never creates a workspace, and it fails and names the candidates rather than guessing.
A review that someone has since moved is recognised by the working directory of its pane and reused
where it now sits.

Labels say what a child is, not which repository it belongs to, because the parent workspace already
carries that: `#<number> · <short title>` for an issue workspace, `Implementation` for its author
tab, `PR #<number> · Review` for a review tab. Never identify a workspace or a review by its label;
`#43` means a different issue in another repository. Branches, worktree paths and work IDs are
unaffected.

If `FLIGHTDECK_TELEMETRY_FILE` is configured, the helper emits best-effort Flightdeck-compatible
`worktree.created`, `agent.run.started`, and `worktree.removed` events only when those transitions
actually occur. Flightdeck remains observational and must not control GitHub, Git, Herdr, or agents.
