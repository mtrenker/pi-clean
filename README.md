# pi-clean

Custom [pi](https://github.com/badlogic/pi) package — browser automation extension.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

After installing, set up the Playwright browser binary:

```bash
npx playwright install chromium
```

## Features

### 🌐 Browser Extension

Gives the agent a real web browser via Playwright. The agent can navigate pages, read content, click links, fill forms, take screenshots, and run JavaScript — essentially doing anything a person would do in a browser.

**Key capabilities:**

- **Persistent profile** — cookies, localStorage, and login sessions survive across sessions
- **Visual overlay** (headed mode) — highlights clicked elements and shows an action bar
- **Mission briefing gate** (interactive mode) — asks for user approval before navigating to untrusted domains
- **Multi-tab support** — open, switch between, and close tabs
- **Content extraction** — pages converted to readable text with indexed interactive elements

**Tools:**

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL, returns page content and interactive elements |
| `browser_click` | Click an element by index or CSS selector |
| `browser_type` | Type text into an input element |
| `browser_screenshot` | Take a screenshot of the current page |
| `browser_evaluate` | Evaluate JavaScript in the page context |
| `browser_back` | Go back in browser history |
| `browser_forward` | Go forward in browser history |
| `browser_tabs` | List, switch, create, or close tabs |
| `browser_set_viewport` | Set the browser viewport size |
| `browser_close` | Close the browser (profile is preserved) |

**Commands:**

| Command | Description |
|---------|-------------|
| `/browser status` | Show browser status (engine, mode, tabs, URL, trusted domains) |
| `/browser close` | Close the browser |
| `/browser show` | Switch to headed mode (visible window) |
| `/browser hide` | Switch to headless mode (background) |
| `/browser switch <type>` | Switch browser engine (`chromium`, `firefox`, `webkit`) |

See [`extensions/browser/README.md`](extensions/browser/README.md) for full documentation.

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
