# pi-clean

Custom [pi](https://github.com/badlogic/pi) package collection.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

## Extensions

### 🛡 [Agent Guard](extensions/agent-guard/README.md)

Adds focused guardrails for catastrophic shell commands, sensitive file paths, and secret-like tool output while preserving normal agent autonomy.

### 🔌 [Harness Delegate](extensions/harness-delegate/README.md)

Delegates one bounded prompt from Pi into Claude Code or Codex via their official CLIs, streams progress inline, and returns the final result. Delegation remains intentionally single-task so changes stay understandable and reviewable.

### 🛫 [Flightdeck telemetry](extensions/flightdeck/README.md)

Reports live `delegate_harness` Claude/Codex lifecycle, heartbeat, and cumulative usage events to a configured Flightdeck JSONL sink. It includes a compact footer status and `/flightdeck:status` command; telemetry is best-effort and excludes prompts and raw output.

### 🌐 [Browser](extensions/browser/README.md)

Gives the agent a real web browser via Playwright—navigate pages, click links, fill forms, take screenshots, and run JavaScript. Features a persistent profile, visual overlay in headed mode, and a mission briefing gate for domain trust.

Requires Playwright browser binaries:

```bash
npx playwright install chromium
```

## GitHub issue and pull request workflow

GitHub issues are the durable mental model for work. Each implementation uses one bounded issue, one managed worktree, one semantic Herdr workspace, one pull request, and independent or human review.

The package includes two reusable skills:

- `github-issues` for Projects, issue hierarchy, dependencies, milestones, grooming, and human/agent readiness.
- `github-pull-requests` for opening PRs, independent reviews, checks, merge preparation, and cleanup.

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
├── extensions/agent-guard/      # Shell, path, and output safety guardrails
├── extensions/browser/          # Playwright browser automation
├── extensions/flightdeck/       # Delegated Claude/Codex telemetry adapter
├── extensions/harness-delegate/ # Bounded Claude Code or Codex delegation
├── skills/                      # GitHub workflow and code-quality skills
├── scripts/                     # GitHub issue/worktree helpers
└── prompts/                     # GitHub issue-grooming shortcuts
```

## License

MIT
