# pi-clean

Custom [pi](https://github.com/badlogic/pi) package collection.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

## Extensions

### 🔌 [Harness Delegate](extensions/harness-delegate/README.md)

Delegates a single prompt from pi into Claude Code or Codex via their official CLIs, streams progress inline, and returns the final result to pi. Useful when you want pi orchestration but need execution to happen through vendor-first subscription tooling.

### 🚢 [Fleet](extensions/fleet/README.md)

Runs multi-agent task execution across pi, Claude, and Codex, with PLAN.md splitting, a live fleet widget, task inspection, simulation/demo flows, and archive/status tooling.

Project config now lives in:

```text
.pi/fleet.json
```

Fleet no longer auto-creates this file. Config is layered (built-in defaults →
`~/.pi/agent/fleet.json` → `.pi/fleet.json`); run `/fleet:config init-project`
or `/fleet:config export-project` to write `.pi/fleet.json` when you want a
project override. If either optional config file exists but contains invalid
JSON, fleet fails loudly instead of silently falling back to defaults.

Runtime task state, progress, and output remain under:

```text
.pi/tasks/
```

### 🛫 [Flightdeck telemetry](extensions/flightdeck/README.md)

Reports live `delegate_harness` and Fleet Claude/Codex child-task lifecycle, heartbeat, and cumulative usage events to a configured Flightdeck JSONL sink. It includes a compact footer status and `/flightdeck:status` command; telemetry is best-effort and excludes prompts and raw output.

### 🌐 [Browser](extensions/browser/README.md)

Gives the agent a real web browser via Playwright — navigate pages, click links, fill forms, take screenshots, and run JavaScript. Features a persistent profile, visual overlay in headed mode, and a mission briefing gate for domain trust.

Requires Playwright browser binaries:

```bash
npx playwright install chromium
```

## GitHub issue and pull request workflow

The package includes two reusable skills:

- `github-issues` for Projects, issue hierarchy, dependencies, milestones, grooming, and human/agent/fleet readiness.
- `github-pull-requests` for opening PRs, independent reviews, checks, merge preparation, and cleanup.

Issue implementation and independent reviews run in isolated worktrees managed by Herdr:

```bash
node scripts/github-work.mjs start-issue 123 --agent pi
node scripts/github-work.mjs review-pr 456 --reviewer claude
node scripts/github-work.mjs status
node scripts/github-work.mjs cleanup-pr 456
node scripts/github-work.mjs finish-issue 123 --delete-branch
```

Worktrees are stored outside project folders under
`~/.local/share/agent-worktrees/github.com/<owner>/<repo>/`. Set
`FLIGHTDECK_TELEMETRY_FILE` to emit compatible worktree and agent-start events to Flightdeck's
JSONL telemetry input. Repository-specific policy remains in each project's `AGENTS.md`.
See [the GitHub workflow guide](docs/github-workflow.md) for Project-based work admission,
issue hierarchy, cognitive-budget limits, lifecycle, safety, Herdr, and Flightdeck details.

## Structure

```
pi-clean/
├── extensions/browser/    # Browser automation extension
│   ├── index.ts           # Extension entry — registers tools and commands
│   ├── browser.ts         # Browser lifecycle (launch, singleton, close)
│   ├── page.ts            # Navigation, interaction, tab management
│   ├── extract.ts         # Content extraction — text + interactive elements
│   ├── overlay.ts         # Visual overlay for headed mode
│   ├── briefing.ts        # Mission briefing gate for domain trust
│   └── briefing.html      # Briefing panel HTML template
├── extensions/harness-delegate/
│   ├── index.ts           # Single prompt delegation to Claude Code / Codex
│   └── README.md          # Usage and behavior notes
├── extensions/fleet/      # Multi-agent task orchestration + live widget
│   ├── index.ts           # Fleet commands, wiring, and tool registration
│   ├── config.ts          # Fleet config loading from .pi/fleet.json
│   ├── orchestrator.ts    # Task scheduling and engine process lifecycle
│   ├── widget.ts          # Live fleet dashboard widget
│   ├── inspect.ts         # Interactive task inspector overlay
│   └── README.md          # Operator guide for fleet workflows
├── extensions/flightdeck/ # Live Claude/Codex task telemetry adapter + status
├── skills/                # Custom skills, including GitHub workflows and fleet doctrine
├── scripts/               # Shared workflow helpers such as github-work.mjs
├── prompts/               # Prompt templates
└── themes/                # Theme customizations
```

## License

MIT
