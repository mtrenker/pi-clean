# Task: TP-007 - Extension Integration (index.ts)

## Dependencies

- **Requires:** TP-006
- **Requires:** TP-004
- **Requires:** TP-005

## Objective

Wire everything together as a pi extension in `extensions/browser/index.ts`. Register all browser tools, manage the lazy lifecycle, integrate the overlay and briefing gate, and handle the `/browser` command.

## Requirements

### Extension Entry Point

The file should export a default pi extension that:
1. Registers all browser tools
2. Sets up the lazy browser lifecycle
3. Registers the `/browser` command
4. Handles session cleanup

### Tool Registration

Register each tool with Typebox schemas for parameters. Every tool should:
- Lazy-launch the browser on first call (via `browser.ts`)
- Hold a reference to the current element map (updated after every page snapshot)
- Return LLM-friendly text output (the extracted page content format)
- Return screenshots as image content attachments (base64 PNG)

**Tools to register:**

1. **`browser_navigate`** — `{ url: string, waitUntil?: string }`
   - Before navigating: check briefing gate (`briefing.ts`) if in interactive mode
   - If new domain + interactive mode → show briefing → on reject, return error
   - On approve (or autonomous mode) → navigate via `page.ts`
   - In headed mode: call `overlay.showAction()` before navigation

2. **`browser_click`** — `{ index?: number, selector?: string }`
   - In headed mode: call `overlay.highlightElement()` + `overlay.moveCursorTo()` before clicking
   - Call `page.click()` with the current element map

3. **`browser_type`** — `{ index?: number, selector?: string, text: string, pressEnter?: boolean, clear?: boolean }`
   - In headed mode: highlight the input field before typing
   - Call `page.type()`

4. **`browser_screenshot`** — `{ fullPage?: boolean, selector?: string }`
   - Return as image attachment (the pi extension API for this)

5. **`browser_evaluate`** — `{ expression: string }`

6. **`browser_back`** / **`browser_forward`** — no params

7. **`browser_tabs`** — `{ action: "list" | "switch" | "new" | "close", tabIndex?: number }`

8. **`browser_close`** — no params, shuts down browser

9. **`browser_set_viewport`** — `{ width: number, height: number }`

### Element Map State

- After every tool call that returns a page snapshot, update the stored element map
- The map is module-level state: `let currentElementMap: Map<number, string> = new Map()`
- `browser_click` and `browser_type` use this map to resolve index → selector

### Headed Mode Detection & Overlay Integration

- Detect headed mode: check if browser was launched with `headless: false`
- When headed, inject overlay on every new page (`page.on('load', ...)`)
- Before each action in headed mode, call the appropriate overlay function
- In headless mode, skip all overlay calls (zero overhead)

### Mission Briefing Integration

- Track current domain: after successful navigation, note the domain
- On `browser_navigate`: extract domain from URL → check `shouldShowBriefing(mode, domain)`
- If briefing needed: `showBriefing()` → on "approved", optionally `trustDomain()`
- Mode detection: if running as subagent or headless → `"autonomous"` mode

### `/browser` Command

Register a `/browser` command with subcommands:
- `/browser status` — show browser state (running/stopped, browser type, headed/headless, profile path, open tabs)
- `/browser close` — close the browser
- `/browser switch <type>` — close current browser, relaunch with different type (chromium/firefox/webkit)

### Session Cleanup

- Register a `session_end` handler to call `closeBrowser()`
- The persistent profile survives — only the browser process is killed

### Error Handling

- **Browser not installed**: Catch Playwright's error and return: `"Browser not installed. Run: npx playwright install chromium"`
- **Timeouts**: Configurable default timeout (30s), return partial page state on timeout
- **Unexpected errors**: Catch, log, return meaningful error to the LLM

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- Uses `@sinclair/typebox` for schema definitions (already in project dependencies).
- This is the final integration point — depends on all other modules.
- Study existing pi extensions in the `@mariozechner/pi-coding-agent` package for the extension API pattern if needed.

## Acceptance Criteria

- [ ] All 10 tools registered with proper Typebox schemas
- [ ] Lazy browser launch on first tool call
- [ ] Element map state maintained across tool calls
- [ ] Overlay integration in headed mode (highlight before click, action bar updates)
- [ ] Briefing gate integration (interactive mode, domain trust)
- [ ] `/browser` command with status/close/switch subcommands
- [ ] Session cleanup handler registered
- [ ] Browser-not-installed error handled gracefully
- [ ] Timeout handling with partial state return
- [ ] All tools return properly formatted LLM-friendly output
