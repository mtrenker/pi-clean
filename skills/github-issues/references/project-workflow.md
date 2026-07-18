# Project-aware issue workflow

Use this reference when a repository uses GitHub Projects, when introducing a repeatable human/agent workflow, or when preparing work for agents.

## Responsibility boundaries

| Layer | Responsibility |
| --- | --- |
| Brain, product notes, or architecture docs | Research, vision, and durable decisions |
| Parent issue | Product or architecture outcome; progress rolls up from children |
| Child issue | One independently deliverable work unit |
| Issue dependency | Blocking order between work units |
| Milestone | A concrete release or externally meaningful outcome |
| GitHub Project | Operational status, priority, size, and focused views |
| Pull request | Delivered change, validation evidence, and review |
| Worktree and agent telemetry | Temporary execution state |

Do not duplicate full issue bodies into Project fields. Do not use Project draft items as a second idea backlog when the repository already has a durable capture system.

## Default small-project structure

Prefer one Project for a product or repository ecosystem, with views rather than separate Projects for frontend, backend, milestones, or teams. Start with only these custom fields:

- **Status:** Inbox, Backlog, Ready, In progress, In review, Done
- **Priority:** P0 urgent, P1 active outcome, P2 next, P3 later
- **Size:** XS, S, M, L

Size L work must be split before moving to Ready. Use milestones for real releases, not architecture categories or speculative dates.

Use labels for stable cross-repository classification:

- work type, such as `type:epic`, `type:feature`, `type:bug`, `type:spike`, `type:chore`;
- area, such as `area:web`, `area:api`, or repository-specific equivalents;
- execution readiness, such as `agent-ready` and `needs-human`.

Do not duplicate Status, Priority, Size, or native dependency state as labels.

## Two-level hierarchy

Use at most two levels even though GitHub supports deeper nesting:

```text
Parent outcome
└── independently deliverable child issues
```

Parent issues describe success and collect sub-issue progress. Do not create implementation branches or PRs for parent issues. Child issues should normally map to one worktree and one PR.

Use native issue dependencies for ordering. Do not model blocked work with a status or label when a dependency relationship expresses it accurately.

## Ready and agent-ready

A Ready issue has:

- a concrete desired outcome;
- context and evidence;
- explicit scope and non-goals;
- verifiable acceptance criteria;
- known parent, dependencies, and blockers;
- architecture constraints and references;
- required tests or validation;
- no hidden decision that an implementer must guess.

`agent-ready` is stricter: a cold agent in a fresh worktree can complete the issue without reconstructing chat history or making unresolved product, architecture, visual, security, or migration decisions. Apply `needs-human` instead when human judgment is the actual next step.

## Cognitive budget and agent admission

Treat human review capacity as the bottleneck:

- one human implementation in progress;
- one active agent issue by default;
- no more than two PRs waiting for human review;
- start another agent issue only when it is unblocked, has low expected file overlap, and the operator can still review both changes coherently.

Agent work should come from approximately:

```text
status:Ready label:agent-ready -is:blocked
```

Do not start agent work from Backlog or Inbox. Do not implement parent issues. Runtime agent names and Herdr pane IDs do not belong in permanent Project fields.

## Recommended saved views

Keep the default view focused:

| View | Filter | Layout |
| --- | --- | --- |
| Now | `is:issue is:open status:Ready,"In progress","In review"` | Board by Status |
| Inbox | `is:issue is:open status:Inbox` | Table |
| Agent Queue | `is:issue is:open status:Ready label:agent-ready -is:blocked` | Table |
| Roadmap | `is:issue is:open label:"type:epic"` | Table with sub-issue progress |
| Recently Done | `is:issue status:Done updated:>@today-30d` | Table |

Suggested column limits are three items In progress and two In review. Avoid timeline views until target dates are trustworthy.

## Minimal automation

Prefer built-in workflows before custom Actions:

- automatically add repository issues;
- item added → Inbox;
- issue closed or PR merged → Done;
- issue reopened → Inbox;
- optionally archive Done items after a retention period.

Never automate movement into Ready or application of `agent-ready`; those transitions require deliberate grooming.

## Inspecting a Project

Projects require the `read:project` scope for reading and `project` for mutation. Inspect before changing:

```bash
gh auth status
gh project list --owner <owner> --limit 100 --format json
gh project view <number> --owner <owner> --format json
gh project field-list <number> --owner <owner> --format json
gh project item-list <number> --owner <owner> --limit 200 --format json
```

Inspect saved views and workflows when needed through GraphQL:

```graphql
query {
  user(login: "OWNER") {
    projectV2(number: NUMBER) {
      views(first: 50) { nodes { number name layout filter } }
      workflows(first: 50) { nodes { number name enabled } }
    }
  }
}
```

For an organization-owned Project, query `organization` instead of `user`.

Do not print tokens or environment contents. If an invalid environment `GITHUB_TOKEN` overrides a valid stored account, report the conflict and obtain authorization before changing authentication; a command may use `env -u GITHUB_TOKEN gh ...` when the user has authorized use of the stored account.

## Mutating Projects safely

Project, field, label, milestone, hierarchy, and issue mutations are consequential remote actions. Show the proposed structure and obtain authorization unless the user's current request already authorizes that exact setup.

Prefer renovating an existing relevant Project over creating a duplicate. Archive stale Project items rather than deleting historical issues. Create only parent outcomes and the first ready wave; defer downstream child issues until upstream decisions provide enough context.

The `gh project` CLI and GraphQL API do not necessarily expose saved-view or built-in-workflow creation. Inspect current CLI/API capability first. If no mutation exists, provide a precise web-UI handoff rather than claiming the configuration is complete.

## Repository rollout checklist

1. Inspect existing Projects, labels, milestones, issue forms, and open issues.
2. Reuse one relevant Project when available.
3. Document status definitions, Ready criteria, WIP limits, and sources of truth in the Project README.
4. Configure minimal Status, Priority, and Size fields.
5. Establish a small label taxonomy without duplicating Project metadata.
6. Close or archive stale milestones; keep one active milestone when practical.
7. Add issue forms for implementation, investigation, and bugs.
8. Create parent outcomes and only the first independently executable children.
9. Link native sub-issues and dependencies.
10. Put only groomed issues in Ready; apply `agent-ready` deliberately.
11. Verify the resulting Project, issue relationships, and repository working tree.
