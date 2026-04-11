# Task: TP-002 - Browser Manager (browser.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement the Playwright browser and persistent context management layer in `extensions/browser/browser.ts`.

## Requirements

### Core API

Implement and export the following:

1. **`launchBrowser(options?)`** — Launch a browser with a persistent context
   - `options.browserType`: `"chromium"` | `"firefox"` | `"webkit"` (default: `"chromium"`)
   - `options.headless`: boolean (default: `true`)
   - Uses `browserType.launchPersistentContext()` with user data dir at `~/.pi/browser/<browserType>/`
   - Returns the `BrowserContext` instance
   - If already launched, returns the existing context (singleton per session)

2. **`getBrowser()`** — Get the current browser context, or `null` if not launched

3. **`getCurrentPage()`** — Get the active page (tab). Creates one if context has no pages.

4. **`setCurrentPage(page)`** — Switch the "active" page (for tab management)

5. **`closeBrowser()`** — Graceful shutdown
   - Close all pages, close context, close browser
   - Do NOT delete the persistent profile (cookies/localStorage survive)
   - Handle already-closed state gracefully

### Persistent Profile Design

The key architectural decision: `~/.pi/browser/` is the agent's home on the web.

```
~/.pi/browser/
├── chromium/          # Chromium persistent context
│   ├── Default/       # Profile data (cookies, localStorage, IndexedDB)
│   └── ...
├── firefox/           # Firefox persistent context (if used)
└── config.json        # Preferred browser, default settings (future use)
```

- Use `os.homedir()` to resolve `~`
- Create directories if they don't exist (`fs.mkdirSync` with `recursive: true`)
- The persistent context means cookies, sessions, history carry across pi sessions

### Robustness

- **Zombie process prevention**: Register cleanup on `process.exit`, `SIGINT`, `SIGTERM`
- **Error on missing browser**: If Playwright browsers aren't installed, catch the error and provide a helpful message: `"Browser not installed. Run: npx playwright install chromium"`
- **Concurrent safety**: Prevent multiple `launchBrowser()` calls from racing (use a launch lock/promise)

## Context

- This is part of a pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode, bundler module resolution.
- Import Playwright types from `playwright`.
- This module is used by `page.ts` (TP-004) and `index.ts` (TP-007).

## Acceptance Criteria

- [ ] `launchBrowser()` creates a persistent context at `~/.pi/browser/chromium/`
- [ ] Supports chromium, firefox, webkit browser types
- [ ] `closeBrowser()` shuts down cleanly without deleting the profile
- [ ] Process cleanup handlers prevent zombie browser processes
- [ ] Missing browser binaries produce a helpful error message
- [ ] Concurrent `launchBrowser()` calls don't race
- [ ] All functions are properly typed and exported
