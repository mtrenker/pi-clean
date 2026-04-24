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

The first fleet command that needs config will create this file from defaults if
it does not exist yet. Fleet then shows an info notification so you know where
to adjust engines, profiles, agents, concurrency, and paths. If the file exists
but contains invalid JSON, fleet fails loudly instead of silently falling back.

Runtime task state, progress, and output remain under:

```text
.pi/tasks/
```

### 🌐 [Browser](extensions/browser/README.md)

Gives the agent a real web browser via Playwright — navigate pages, click links, fill forms, take screenshots, and run JavaScript. Features a persistent profile, visual overlay in headed mode, and a mission briefing gate for domain trust.

Requires Playwright browser binaries:

```bash
npx playwright install chromium
```

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
├── skills/                # Custom skills, including fleet-planner doctrine
├── prompts/               # Prompt templates
└── themes/                # Theme customizations
```

## License

MIT
