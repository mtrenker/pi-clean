# pi-clean

Custom [pi](https://github.com/badlogic/pi) package collection.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

## Extensions

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
├── skills/                # (empty, add your own)
├── prompts/               # (empty, add your own)
└── themes/                # (empty, add your own)
```

## License

MIT
