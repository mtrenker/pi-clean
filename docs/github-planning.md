# Deterministic GitHub planning

`github-planning.mjs` supplies repeatable evidence for issue capture, grooming, and a short GitHub daily ritual. It is deliberately read-only: it validates configuration, queries GitHub, normalizes data, checks mechanical rules, and previews issue mutations. It never creates or edits an issue, label, relationship, milestone, Project item, or Project field.

Product priority, semantic completeness, promotion to Ready, application of `agent-ready`, today's capacity, and the final work choice remain human decisions. Stable finding codes replace a misleading numerical readiness score.

## Ownership boundaries

| Data | Owner |
| --- | --- |
| Built-in generic field/status defaults and deterministic checks | pi-clean |
| Portfolio membership, repository/Project mappings, aliases, thresholds, and limits | Versioned user configuration |
| Desired outcomes, acceptance criteria, labels, milestones, hierarchy, dependencies, and pull requests | GitHub |
| Repository policy, issue forms, valid labels, and validation commands | Each repository |
| Today's selected outcome and capacity | Operator decision; persist resulting decisions in GitHub |

No real account, repository, Project number, node ID, field ID, label taxonomy, or personal note path is built into pi-clean. GitHub node, Project field, and single-select option IDs are queried at runtime and appear only as snapshot provenance.

## Configuration

The default path is:

```text
~/.pi/agent/github-workflow.json
```

Set `PI_GITHUB_WORKFLOW_CONFIG` to an alternate file for tests or nonstandard installations. Normal inspection never creates or rewrites this file. Copy [`github-workflow.example.json`](github-workflow.example.json) explicitly when starting a configuration:

```bash
mkdir -p ~/.pi/agent
cp /path/to/pi-clean/docs/github-workflow.example.json ~/.pi/agent/github-workflow.json
$EDITOR ~/.pi/agent/github-workflow.json
node /path/to/pi-clean/scripts/github-planning.mjs config
```

The example contains placeholders only. The contract is versioned with top-level `"version": 1`.

### Contract

- `defaults` optionally overrides package defaults for every portfolio.
- `portfolios` is a non-empty object of named portfolios.
- `repositories` is a non-empty list of explicit `owner/name` targets. Entries may also be objects with `name` and `projects`.
- `projects` optionally maps an owner and positive Project number to one or more configured repositories. A repository can use a different Project from another repository. Omit `repositories` on a mapping to accept items from every configured repository.
- `settings` on a portfolio overrides user defaults for that portfolio.
- `fields.status`, `fields.priority`, and `fields.size` are ordered aliases for Project field names.
- `options.status` maps repository-specific option names to normalized states. `options.priority` and `options.size` define deterministic ordering.
- `labels.agentReady` and `labels.needsHuman` contain repository-specific readiness aliases.
- `limits.inProgress` and `limits.inReview` are non-negative WIP limits.
- `staleDays` is a positive inspection threshold reserved for stale evidence.
- `requiredDraftSections` maps `outcome`, `scope`, `nonGoals`, `acceptance`, `dependencies`, and `validation` to accepted Markdown headings.

Malformed JSON, an unsupported version, invalid targets, missing Project scope, rate limits, and partial pagination fail with an actionable non-zero error. Missing configured Project fields are explicit coded findings. Optional hierarchy or dependency data that GitHub does not expose is represented as `unavailable`; absence is not inferred. A missing config fails with `CONFIG_NOT_FOUND` and points to the sample.

Projects require the `read:project` OAuth scope for inspection. Mutation performed later by the existing confirmed workflow requires `project`.

## Commands

Run commands with the package's absolute path when the current directory belongs to another repository:

```bash
node /path/to/pi-clean/scripts/github-planning.mjs config
node /path/to/pi-clean/scripts/github-planning.mjs snapshot example-portfolio --format json
node /path/to/pi-clean/scripts/github-planning.mjs snapshot example-portfolio --format markdown
node /path/to/pi-clean/scripts/github-planning.mjs groom example-portfolio --format json
node /path/to/pi-clean/scripts/github-planning.mjs daily example-portfolio --format markdown
node /path/to/pi-clean/scripts/github-planning.mjs validate-draft example-portfolio --draft /tmp/issue-draft.json
```

`--fixture PATH` replaces live collection for snapshot, groom, and daily. `--context-fixture PATH` replaces live label/form/duplicate inspection for draft validation. These are intended for deterministic tests.

Package prompts provide focused agent entry points:

- `/github-add <repository> [portfolio]` — inspect issue forms and labels, search duplicate candidates, validate a structured draft, and preview its full mutation;
- `/github-groom [portfolio]` — normalize a portfolio and inspect structural findings;
- `/github-daily [portfolio]` — show review/failure attention, current WIP, blockers and human decisions, then admissible Ready candidates.

The prompts load the `github-issues` skill, which owns preview/confirmation policy. The CLI itself has no mutation command.

## Snapshot schema and ordering

Snapshot JSON uses `schemaVersion: 1`:

```text
{
  schemaVersion, portfolio, capturedAt, settings,
  sources: {
    repositories: [{ name }],
    projects: [{ owner, number, id, title, url, fields, unresolvedFields }]
  },
  items: [{
    id, repository, number, itemType, title, url, state,
    projectStatus, priority, size, projectValues,
    labels, assignees, parent, hasChildren,
    blockers: { availability, items },
    updatedAt, linkedPullRequest, review, checks,
    sourceProjects, missingConfiguredFields, availability
  }]
}
```

`sourceProjects` includes owner, Project number, Project node ID, URL, and item ID, so every Project-backed item is traceable. `projectValues` retains per-Project values before choosing the first source Project in deterministic owner/number order. Items sort by repository, issue/PR number, then item type. Labels, assignees, blockers, fields, Project sources, missing fields, and findings also have explicit stable ordering. The live `capturedAt` naturally changes; a fixed fixture timestamp produces byte-equivalent data across runs.

Daily candidates sort by configured priority order, then repository, number, and item type. The candidate list excludes Inbox, Backlog, blocked items, parent issues, Size L work, contradictory readiness labels, items with missing configured Project values, and pull requests. The operator—not the ordering—chooses the final plan.

## Finding codes

| Code | Deterministic evidence |
| --- | --- |
| `BLOCKER_OPEN` | A normalized blocker is open |
| `PARENT_IN_READY` | An issue with children is in Ready |
| `SIZE_L_READY` | A Ready issue has normalized Size L |
| `READINESS_LABEL_CONFLICT` | Both configured `agent-ready` and `needs-human` aliases are present |
| `PROJECT_FIELD_UNRESOLVED` | A configured Project does not expose an aliased Status, Priority, or Size field |
| `ITEM_FIELD_MISSING` | A Project item lacks a configured field value, or its source Project lacks that field |
| `WIP_LIMIT_EXCEEDED` | Open In-progress count exceeds the configured limit |
| `REVIEW_LIMIT_EXCEEDED` | Open In-review count exceeds the configured limit |
| `STALE_ITEM` | An open item is older than the configured update threshold |

Draft validation emits `DRAFT_TITLE_MISSING`, `DRAFT_SECTION_MISSING`, `ISSUE_FORM_REQUIRED`, `ISSUE_FORM_FIELD_MISSING`, and `DRAFT_LABEL_INVALID`. When a repository has multiple issue forms, the draft must name one before validation can pass. Duplicate candidates are deterministic title-token matches, not proof of duplication.

`requiresHumanDecision` marks evidence that cannot decide its own resolution. Even findings without that flag are not automatic mutations or semantic readiness decisions.

## Draft format and safe mutation handoff

`validate-draft` accepts JSON:

```json
{
  "repository": "example-owner/example-api",
  "issueForm": "feature.yml",
  "title": "Add a deterministic example",
  "body": "## Desired outcome\n...\n\n## Scope\n...\n\n## Non-goals\n...\n\n## Acceptance criteria\n...\n\n## Dependencies\n...\n\n## Validation\n...",
  "labels": ["example-label"],
  "assignees": [],
  "milestone": null,
  "parent": null,
  "dependencies": { "blockedBy": [], "blocking": [] },
  "projectChanges": [
    { "project": "example-owner/101", "field": "Status", "value": "Inbox" }
  ]
}
```

The command inspects valid labels, selected issue-form requirements, and plausible duplicate titles, then returns `proposedMutation` and `mutationApplied: false`. `/github-add` must display that entire proposal. Only after explicit operator confirmation may the existing `github-issues` workflow publish it with `gh` and then verify the resulting GitHub state. `/github-groom` and `/github-daily` follow the same preview-and-confirm rule for any proposed labels, hierarchy, dependency, milestone, or Project changes.

## End-to-end example

1. **Capture:** invoke `/github-add example-owner/example-api example-portfolio`. Inspect repository forms and labels, review duplicate candidates, and prepare all issue and Project fields.
2. **Confirm:** inspect the complete proposed mutation. Explicitly approve publication or revise the draft. No preview command publishes it.
3. **Groom:** invoke `/github-groom example-portfolio`. Resolve mechanical findings, then use human judgment for validity, scope, priority, Ready, and `agent-ready`. Preview and confirm every remote change.
4. **Daily:** invoke `/github-daily example-portfolio`. Address failed checks/reviews and continuation work first, inspect blockers and `needs-human`, then choose an outcome and capacity from admissible Ready candidates.
5. **Start work:** only after the operator's choice and repository admission policy, use `scripts/github-work.mjs start-issue <number> --agent <agent>` from the repository control plane. Worktree/Herdr lifecycle remains separate from planning.

Read-only commands do not write the current repository or GitHub. Fixture tests verify that invariant through a data layer with no mutation APIs.
