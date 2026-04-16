# pi-clean

Custom [pi](https://github.com/badlogic/pi) package collection.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

## Extensions

### 🚢 [Fleet](extensions/fleet/README.md)

Runs multi-agent task execution across pi, Claude, and Codex, with PLAN.md splitting, a live fleet widget, task inspection, simulation/demo flows, and archive/status tooling.

Project config now lives in:

```text
.pi/fleet.json
```

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
├── extensions/fleet/      # Multi-agent task orchestration + live widget
│   ├── index.ts           # Fleet commands, wiring, and tool registration
│   ├── config.ts          # Fleet config loading from .pi/fleet.json
│   ├── orchestrator.ts    # Task scheduling and engine process lifecycle
│   ├── widget.ts          # Live fleet dashboard widget
│   ├── inspect.ts         # Interactive task inspector overlay
│   └── README.md          # Operator guide for fleet workflows
├── skills/                # Custom planner and other skills
├── prompts/               # Prompt templates
└── themes/                # Theme customizations
```

## License

MIT
