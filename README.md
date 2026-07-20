# pi-clean

Custom [pi](https://github.com/badlogic/pi) package collection.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

## Extensions

### 🛡 [Agent Guard](extensions/agent-guard/README.md)

Adds focused guardrails for catastrophic shell commands, sensitive file paths, and secret-like tool output while preserving normal agent autonomy.

### ◩ [Visual Design Relay](extensions/visual-design/README.md)

Prototypes repo-native, Plate-compatible visual artifacts: select a stable design node in the browser, discuss it with Pi, and watch validated agent mutations or external file edits appear live. Start the included artifact with `/design designs/example.design.json`.

### ⛨ [OpenShell Agent](extensions/openshell-agent/README.md)

Runs bounded autonomous research, sandbox-side Git development, and opt-in persistent authenticated-browser jobs inside isolated OpenShell workspaces. Use this extension for web research and browsing so untrusted content, Chromium, browser profiles, and authenticated sessions remain within the OpenShell boundary. Requires a matching OpenShell v0.0.86+ CLI/gateway and a current official Codex login; Pi uses `gpt-5.6-terra` through an image-owned placeholder relay while real OAuth tokens remain gateway-owned. Untrusted final answers render in TUI-only tool details and terminate without a host-model follow-up.

## Interactive delegation with Herdr

Pi-clean intentionally does not ship a subprocess delegation tool or a package-owned Herdr skill. Use the externally managed `herdr` skill discovered from `~/.agents/skills/` as the canonical guide to current pane, workspace, output, focus, and intervention commands.

Choose the delegation boundary by risk:

- For bounded read-only investigation, split a pane in the current Herdr workspace only when sharing the checkout is safe. Do not let another pane mutate the shared checkout.
- For issue implementation or any other code/configuration mutation, use `scripts/github-work.mjs start-issue` so the agent receives an isolated linked worktree and workspace.
- For independent pull-request review, use `scripts/github-work.mjs review-pr` so the reviewer receives a detached review worktree and separate workspace.

Keep delegated agents visible. First observe the pane reach `working`; a pane that never does may not have launched correctly. After that, treat either `done` or `idle` as settled, read the pane output, and surface `blocked` for operator attention. Viewing a completed pane acknowledges Herdr's ephemeral unread `done` state and may change it to `idle`, so never wait only for `done`. The operator can focus the pane at any time to guide, interrupt, or resume the agent.

Managed Claude author and reviewer panes launch with `--permission-mode bypassPermissions`. Managed Codex panes launch with `--full-auto`, which retains Codex's workspace-write sandbox rather than granting `danger-full-access`. These non-prompting local profiles do not authorize publishing reviews, approving, merging, deleting remote branches, or any other protected remote mutation without explicit operator approval. Claude's bypass mode is not a host sandbox; the isolated worktree protects Git state, not the host, pending separate sandbox hardening.

## GitHub issue and pull request workflow

GitHub issues are the durable mental model for work. Each implementation uses one bounded issue, one managed worktree, one semantic Herdr workspace, one pull request, and independent or human review.

The package includes reusable skills:

- `experience-design-quality` for emotionally fitting, distinctive, accessible experience design across product contexts.
- `github-issues` for Projects, issue hierarchy, dependencies, milestones, grooming, and human/agent readiness.
- `github-pull-requests` for opening PRs, independent reviews, checks, merge preparation, and cleanup.
- `react-composition-quality` for maintainable React composition, render-ready data, and simple UI contracts.

The package also provides deterministic, read-only cross-repository issue grooming. User portfolio configuration lives in `~/.pi/agent/github-workflow.json` (override with `PI_GITHUB_WORKFLOW_CONFIG`); the package never creates it during inspection. Use `/github-add`, `/github-groom`, or `/github-daily`, or run:

```bash
node scripts/github-planning.mjs snapshot <portfolio> --format json
node scripts/github-planning.mjs groom <portfolio>
node scripts/github-planning.mjs daily <portfolio>
```

See [the deterministic issue-grooming guide](docs/github-planning.md) and its placeholder-only [configuration example](docs/github-workflow.example.json).

Issue implementation and independent reviews run in isolated worktrees. Inside Herdr, issue author worktrees use Herdr's native linked-worktree lifecycle:

```bash
node scripts/github-work.mjs start-issue 123 --agent pi
node scripts/github-work.mjs review-pr 456 --reviewer claude
node scripts/github-work.mjs status
node scripts/github-work.mjs cleanup-pr 456
node scripts/github-work.mjs finish-issue 123 --delete-branch
```

Worktrees are stored outside project folders under `~/.local/share/agent-worktrees/github.com/<owner>/<repo>/`. Outside Herdr, `start-issue --agent none` retains a direct-Git fallback; Herdr-managed issue work requires native worktree support in Herdr 0.7.3 or newer.

Set `FLIGHTDECK_TELEMETRY_FILE` to emit compatible worktree and agent-start events to Flightdeck's JSONL telemetry input. Repository-specific policy remains in each project's `AGENTS.md`. See [the GitHub workflow guide](docs/github-workflow.md) for Project-based work admission, issue hierarchy, cognitive-budget limits, lifecycle, safety, Herdr, and Flightdeck details.

## Structure

```text
pi-clean/
├── extensions/agent-guard/ # Shell, path, and output safety guardrails
├── extensions/openshell-agent/ # Sandboxed autonomous-agent jobs
├── extensions/visual-design/ # PlateJS visual artifact relay
├── designs/                # Example repo-native visual artifacts
├── skills/                 # GitHub workflow and code-quality skills
├── scripts/                # GitHub issue/worktree helpers
└── prompts/                # GitHub issue-grooming shortcuts
```

## License

MIT
