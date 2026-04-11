# Plan: Web Browser Extension for pi-clean

## Approach

### Why Playwright

| Consideration | Decision |
|---|---|
| **Multi-browser** | Playwright supports Firefox, Chromium, WebKit — configurable per use |
| **Agent's own browser** | Playwright downloads its own browser binaries — completely separate from the user's Firefox/Chrome |
| **Persistent identity** | `~/.pi/browser/{chromium,firefox,webkit}/` — the agent has its own cookies, history, localStorage, like a real person |
| **Familiar to maintainer** | Already used in the project's dev workflow |
| **Future-proof** | When the agent gets its own system user, the browser profile moves with it naturally |

### Design Principles

1. **The agent is its own person** — persistent browser context at `~/.pi/browser/`, not ephemeral. Cookies, sessions, history carry across pi sessions. The agent can log into things and stay logged in.
2. **LLM-friendly output** — never return raw HTML. Return readable text + indexed interactive elements (like a screen reader). The agent "sees" the page as: text content, then `[0] link "Docs" → /docs`, `[1] button "Sign In"`, `[2] input[name=q] ""`.
3. **Browser choice** — default to Chromium (best headless support), but configurable to Firefox or WebKit. The agent can switch browsers.
4. **Lazy lifecycle** — browser launches on first tool call, stays alive for the session, shuts down on session end. No startup cost if never used.
5. **Visual feedback (headed mode)** — when the user is watching, the agent shows what it's doing: elements highlight before clicks, a cursor trail follows actions, text typing is visible in real-time, and a small annotation bar explains the current action. Like watching someone screen-share, not just seeing a browser flicker.
6. **Mission briefing gate (interactive mode)** — in headed/paired mode, the browser opens to a local "mission briefing" page before navigating anywhere. It shows: what the agent wants to do, which URLs it plans to visit, and why. The user clicks "Approve" to let the agent proceed, or "Reject" to block. This is skipped entirely for autonomous agents/subagents — only active when pairing with a human.

## Architecture

```
extensions/browser/
├── index.ts          # Extension entry: registers tools, manages lifecycle
├── browser.ts        # Playwright browser/context management, persistent profiles
├── page.ts           # Page operations: navigate, click, type, screenshot
├── extract.ts        # DOM → LLM-friendly content extraction
├── overlay.ts        # Visual feedback overlay — highlights, annotations, action trail
├── briefing.ts       # Mission briefing gate — approval page before browsing starts
├── briefing.html     # Mission briefing page template
└── README.md         # Usage docs
```

Dependency: `playwright` added to `package.json` (with `npx playwright install` for browser binaries).

## Tools

### `browser_navigate`
Open a URL in the agent's browser. Returns readable page content + interactive elements.
- **Params:** `url` (string), `waitUntil?` ("load" | "domcontentloaded" | "networkidle")
- **Returns:** title, url, text content (truncated ~8K), indexed interactive elements

### `browser_click`
Click an element by index (from interactive elements list) or CSS selector.
- **Params:** `index?` (number), `selector?` (string)
- **Returns:** Updated page snapshot after navigation/interaction settles

### `browser_type`
Type into an input field. Optionally press Enter to submit.
- **Params:** `index?` (number), `selector?` (string), `text` (string), `pressEnter?` (boolean), `clear?` (boolean)
- **Returns:** Updated page snapshot

### `browser_screenshot`
Capture what the agent "sees". Returns image attachment.
- **Params:** `fullPage?` (boolean), `selector?` (string)
- **Returns:** PNG image as base64 attachment

### `browser_evaluate`
Run JavaScript in the page. Escape hatch for complex interactions.
- **Params:** `expression` (string)
- **Returns:** Serialized return value

### `browser_back` / `browser_forward`
Navigate history, like a real user.
- **Params:** none
- **Returns:** Updated page snapshot

### `browser_tabs`
List open tabs, switch between them, open new tab, close tab.
- **Params:** `action` ("list" | "switch" | "new" | "close"), `tabIndex?` (number)
- **Returns:** Tab list or updated page snapshot

### `browser_close`
Shut down the browser (profile persists on disk for next session).
- **Params:** none

### `browser_set_viewport`
Resize the browser viewport (useful for testing responsive layouts).
- **Params:** `width` (number), `height` (number)
- **Returns:** confirmation

## Tasks

### TASK-1: Project Setup & Playwright Dependency
- Add `playwright` to `package.json` dependencies
- Document `npx playwright install chromium` (or `firefox`, `webkit`) as post-install step
- Create `extensions/browser/` directory structure

**Dependencies:** none

### TASK-2: Browser Manager (`browser.ts`)
Playwright browser + persistent context management:
- `launchBrowser(browserType?, headless?)` — launch with persistent context at `~/.pi/browser/<browserType>/`
- Uses `browserType.launchPersistentContext()` so cookies/history/localStorage survive across sessions
- Default: Chromium, headless
- Graceful shutdown, zombie process prevention
- Browser type configurable (chromium, firefox, webkit)
- Page pool management (reuse pages, track "current" page)

**Dependencies:** TASK-1

### TASK-3: Content Extraction (`extract.ts`)
Transform page DOM into LLM-readable format:
- Extract `innerText` with cleanup (collapse whitespace, strip hidden elements)
- Build interactive elements index:
  ```
  [0] link "Documentation" → https://docs.example.com
  [1] button "Sign In"
  [2] input[name="email"] placeholder="Enter email" value=""
  [3] select[name="country"] value="US" options=["US","UK","DE"]
  [4] textarea[name="message"] value=""
  ```
- Truncate output to ~8K chars with smart truncation (keep beginning + end)
- Handle iframes (extract from main frame only, note iframe presence)
- Provide element locator mapping: index → Playwright Locator for subsequent click/type

**Dependencies:** TASK-1

### TASK-4: Page Operations (`page.ts`)
High-level page interaction layer:
- `navigate(url, waitUntil)` — go to URL, wait for ready, return extracted content
- `click(index | selector)` — resolve element, click, wait for navigation/stability, return snapshot
- `type(index | selector, text, options)` — focus, optionally clear, type, optionally press Enter
- `screenshot(options)` — capture screenshot, return as base64
- `evaluate(expression)` — run JS, serialize result
- `back()` / `forward()` — history navigation
- `tabManagement(action)` — list/switch/new/close tabs
- All mutating operations return a fresh page snapshot automatically

**Dependencies:** TASK-2, TASK-3

### TASK-5: Mission Briefing Gate (`briefing.ts` + `briefing.html`)
In interactive/paired mode, the first `browser_navigate` call doesn't go directly to the target URL. Instead:

**Flow:**
1. Agent calls `browser_navigate({ url: "https://github.com/...", purpose: "Look up issue #42 details" })`
2. Browser opens a local mission briefing page (`briefing.html` served via `data:` URL or local file)
3. The page shows:
   - 🎯 **Mission:** "Look up issue #42 details"
   - 🌐 **Target:** `https://github.com/mtrenker/pi-clean/issues/42`
   - 🤖 **Agent:** pi browser session
   - 🕐 **Requested at:** timestamp
4. Two big buttons: **✅ Approve** and **❌ Reject**
5. Extension waits for button click via `page.waitForSelector()` / `page.evaluate()`
6. On Approve → navigate to actual URL, return page content as normal
7. On Reject → return error to agent: "User rejected browser navigation"

**Scope control:**
- `mode: "interactive"` (default in headed) — briefing gate is active
- `mode: "autonomous"` (default in headless, always for subagents) — gate is skipped
- Configurable: user can set `"browserGate": false` in config to disable even in headed mode
- After initial approval, subsequent navigations on the **same domain** are auto-approved (trust chain)
- Navigation to a **new domain** triggers a new briefing

**The briefing page itself:**
- Clean, minimal design — dark theme matching pi's aesthetic
- Shows a brief history of approved domains in the current session
- Keyboard shortcut: `Enter` to approve, `Escape` to reject

**Implementation:**
- `briefing.html` is a self-contained HTML template with embedded CSS/JS
- `briefing.ts` exports `showBriefing(page, mission)` → returns `Promise<"approved" | "rejected">`
- Template is inlined as a string (no file serving needed) — loaded via `page.setContent()`
- Domain trust list maintained in memory for the session, optionally persisted to `~/.pi/browser/trusted-domains.json`

**Dependencies:** TASK-1

### TASK-6: Visual Feedback Overlay (`overlay.ts`)
Injectable overlay system for headed mode — lets the user watch the agent work:

**Action Highlighting:**
- Before clicking: target element gets a pulsing colored border + label (e.g., `🖱 clicking "Sign In"`)
- Before typing: input field highlights + shows ghost text of what will be typed
- Highlight persists for ~800ms so the eye can track it, then fades

**Action Bar:**
- Small fixed overlay bar at the top of the page (think DevTools-style)
- Shows current action in plain text: `Navigating to github.com/...`, `Clicking button "Submit"`, `Typing "hello world" into search`
- Shows agent "intent" if available (the reason for the action from the LLM's perspective)

**Cursor Trail:**
- Animated dot that moves to click targets, simulating mouse movement
- Makes it visually obvious where the agent is acting

**Action History:**
- Small collapsible panel showing last 5 actions taken on this page
- Fades out if no activity for a few seconds

**Implementation:**
- Single JS/CSS bundle injected via `page.addInitScript()` + `page.addStyleTag()`
- All visuals are in a Shadow DOM container to avoid interfering with page styles
- Overlay is only injected when `headed: true` — zero overhead in headless mode
- Expose functions on `window.__piOverlay` that page.ts calls before each action:
  - `window.__piOverlay.highlightElement(selector, action, label)`
  - `window.__piOverlay.showAction(text)`
  - `window.__piOverlay.moveCursorTo(x, y)`
  - `window.__piOverlay.addToHistory(action)`

**Dependencies:** TASK-1

### TASK-7: Extension Integration (`index.ts`)
Wire into pi as extension:
- Register all tools with Typebox schemas
- Lazy browser launch on first tool call
- `session_end` handler to close browser gracefully (profile persists)
- Screenshot results as image content attachments
- Error handling: browser not installed → helpful message ("run `npx playwright install chromium`")
- Register `/browser` command: `/browser status`, `/browser close`, `/browser switch firefox`, `/browser show` (headed), `/browser hide` (headless)
- Timeout handling for navigation/interactions (configurable, default 30s)
- When headed mode is active, call overlay functions before each action in page.ts
- Wire mission briefing gate into navigate flow (headed + interactive mode only)
- Detect interactive vs autonomous mode (check if running as subagent / check pi mode)

**Dependencies:** TASK-4, TASK-5, TASK-6

### TASK-8: Documentation & Testing
- `extensions/browser/README.md` — setup, usage examples, browser choice, profile location
- Test script exercising all tools against a known page
- Edge cases: page with no interactive elements, very long pages, SPAs, file downloads

**Dependencies:** TASK-7

## Dependency Graph

```
              ┌─→ TASK-2 (Browser Manager) ─┐
TASK-1 (Setup)├─→ TASK-3 (Extraction) ──────┼─→ TASK-4 (Page Ops) ─┐
              ├─→ TASK-5 (Briefing Gate) ────┤                      ├─→ TASK-7 (Extension) → TASK-8 (Docs)
              └─→ TASK-6 (Overlay) ──────────┘                      │
                                                                    ┘
```

TASK-2, TASK-3, TASK-5, and TASK-6 can all run in parallel after TASK-1.

## Persistent Profile: The Agent as a Person

The key architectural decision: `~/.pi/browser/` is the agent's home on the web.

```
~/.pi/browser/
├── chromium/          # Chromium persistent context
│   ├── Default/       # Profile data (cookies, localStorage, IndexedDB)
│   ├── History        # Browsing history
│   └── ...
├── firefox/           # Firefox persistent context (if used)
└── config.json        # Preferred browser, default settings
```

This means:
- The agent can log into GitHub, Jira, docs sites — and **stay logged in**
- Browsing history accumulates (useful for "go back to that page I visited")
- When the agent eventually gets its own system user (`~pi/`), this moves naturally to `~pi/.pi/browser/`

## Open Questions

1. **Playwright install strategy** — should the extension auto-run `npx playwright install chromium` on first use, or require manual setup? (Leaning: auto-install with user confirmation)
2. **Download handling** — what happens when the agent clicks a download link? (Save to `~/.pi/browser/downloads/`?)
3. **Headed ↔ Headless switching** — can we switch an existing session from headless to headed mid-session? (Playwright doesn't support this natively — may need to close and relaunch with profile persistence making this seamless)
4. ~~**Briefing gate granularity**~~ **Resolved:** Trusted domains live in `~/.pi/browser/trusted-domains.txt` — one domain per line, easy to edit by hand. When the user approves a domain via the briefing page, they can choose "Trust this session" (in-memory only) or "Always trust" (appends to the file). The file supports comments (`#`) and wildcards (`*.github.com`). Pre-seeded with nothing — the agent earns trust.
