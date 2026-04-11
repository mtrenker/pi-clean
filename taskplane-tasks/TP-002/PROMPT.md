# Task: TP-002 - Browser Manager (browser.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement Playwright browser and persistent context management in `extensions/browser/browser.ts`.

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode, bundler module resolution.
- Import Playwright types from `playwright`.
- This module is used by `page.ts` (TP-006) and `index.ts` (TP-007).
- The key architectural decision: `~/.pi/browser/` is the agent's home on the web. Uses `browserType.launchPersistentContext()` so cookies/history/localStorage survive across sessions.

## Context to Read First

`extensions/browser/browser.ts`
`extensions/browser/index.ts`
`package.json`

### Step 0: Preflight

- [ ] Read existing `extensions/browser/browser.ts` stub and `package.json`
- [ ] Verify `playwright` is installed as a dependency

### Step 1: Implement Browser Launch and Singleton Management

- [ ] Implement `launchBrowser(options?)` — launches with persistent context at `~/.pi/browser/<browserType>/`
  - `options.browserType`: `"chromium"` | `"firefox"` | `"webkit"` (default: `"chromium"`)
  - `options.headless`: boolean (default: `true`)
  - Uses `browserType.launchPersistentContext()` with user data dir
  - Returns the `BrowserContext` instance
  - Singleton per session — if already launched, returns existing context
- [ ] Implement concurrent launch safety (use a launch lock/promise to prevent racing)
- [ ] Create profile directories using `fs.mkdirSync` with `recursive: true`, resolve `~` via `os.homedir()`

### Step 2: Implement Page and Context Management

- [ ] Implement `getBrowser()` — returns current browser context, or `null` if not launched
- [ ] Implement `getCurrentPage()` — returns the active page (tab), creates one if context has no pages
- [ ] Implement `setCurrentPage(page)` — switches the "active" page for tab management

### Step 3: Implement Shutdown and Cleanup

- [ ] Implement `closeBrowser()` — graceful shutdown (close pages, context, browser) WITHOUT deleting the persistent profile
- [ ] Handle already-closed state gracefully
- [ ] Register cleanup on `process.exit`, `SIGINT`, `SIGTERM` to prevent zombie processes
- [ ] Catch missing browser binaries error and return helpful message: `"Browser not installed. Run: npx playwright install chromium"`

### Step 4: Verify

- [ ] Ensure all functions are properly typed and exported
- [ ] Run `npm run build` to verify TypeScript compilation passes
