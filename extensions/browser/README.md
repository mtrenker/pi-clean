# Browser Extension

A pi extension that gives the agent a real web browser via Playwright. The agent can navigate pages, read content, click links, fill forms, take screenshots, and run JavaScript — essentially doing anything a person would do in a browser.

## Overview

The browser extension follows an **"agent as a person"** model: instead of calling APIs or scraping HTML, the agent interacts with web pages the same way a human would — navigating URLs, reading visible text, clicking buttons by their on-screen labels, and typing into form fields. Each page view returns a structured snapshot of the visible text content plus an indexed list of interactive elements (links, buttons, inputs, etc.), so the agent always knows what it can interact with.

Key features:

- **Persistent browser profile** — cookies, localStorage, and login sessions survive across agent sessions
- **Visual overlay** (headed mode) — highlights clicked elements and shows an action bar so a human observer can follow along
- **Mission briefing gate** (interactive mode) — asks for user approval before navigating to untrusted domains
- **Multi-tab support** — open, switch between, and close browser tabs
- **Content extraction** — automatic conversion of web pages to readable text with indexed interactive elements

## Setup

After installing project dependencies, install the Chromium browser binary used by Playwright:

```bash
npx playwright install chromium
```

This downloads a compatible Chromium build to Playwright's cache directory. The binary is **not** committed to the repo — each developer must run this once after a fresh clone or after upgrading the `playwright` dependency.

To install Firefox or WebKit instead (or in addition):

```bash
npx playwright install firefox
npx playwright install webkit
```

The persistent browser profile is stored at `~/.pi/browser/<browserType>/` (e.g. `~/.pi/browser/chromium/`).

## Tools

### `browser_navigate`

Navigate to a URL. Returns the page's visible text content and a numbered list of interactive elements.

| Parameter   | Type   | Required | Description                                                        |
|-------------|--------|----------|--------------------------------------------------------------------|
| `url`       | string | yes      | URL to navigate to                                                 |
| `waitUntil` | string | no       | When navigation is "done": `load`, `domcontentloaded` (default), or `networkidle` |

**Example:**
```
browser_navigate({ url: "https://example.com" })
```

Returns:
```
Title: Example Domain
URL: https://example.com/

Example Domain
This domain is for use in illustrative examples...

Interactive Elements:
[0] link "More information..." → https://www.iana.org/domains/example
```

### `browser_click`

Click an element on the page by its index (from the interactive elements list) or by CSS selector. After clicking, returns an updated page snapshot.

| Parameter  | Type   | Required | Description                                    |
|------------|--------|----------|------------------------------------------------|
| `index`    | number | no*      | Element index from the interactive elements list |
| `selector` | string | no*      | CSS selector of the element to click            |

*Provide either `index` or `selector`, not both.

**Example:**
```
browser_click({ index: 0 })
```

### `browser_type`

Type text into an input or textarea element. Supports clearing existing content and pressing Enter after typing.

| Parameter    | Type    | Required | Description                                       |
|--------------|---------|----------|---------------------------------------------------|
| `index`      | number  | no*      | Element index from the interactive elements list   |
| `selector`   | string  | no*      | CSS selector of the element                        |
| `text`       | string  | yes      | Text to type                                       |
| `pressEnter` | boolean | no       | Press Enter after typing (default: `false`)        |
| `clear`      | boolean | no       | Clear existing content before typing (default: `false`) |

*Provide either `index` or `selector`, not both.

**Example:**
```
browser_type({ index: 3, text: "search query", pressEnter: true })
```

### `browser_screenshot`

Take a screenshot of the current page. Returns a PNG image.

| Parameter  | Type    | Required | Description                                         |
|------------|---------|----------|-----------------------------------------------------|
| `fullPage` | boolean | no       | Capture the entire scrollable page (default: `false`) |
| `selector` | string  | no       | CSS selector to screenshot a specific element        |

**Example:**
```
browser_screenshot({ fullPage: true })
```

### `browser_evaluate`

Evaluate a JavaScript expression in the browser page context. Returns the serialized result.

| Parameter    | Type   | Required | Description                          |
|--------------|--------|----------|--------------------------------------|
| `expression` | string | yes      | JavaScript expression to evaluate    |

**Example:**
```
browser_evaluate({ expression: "document.title" })
```

### `browser_back`

Go back in browser history. Returns an updated page snapshot.

*No parameters.*

**Example:**
```
browser_back({})
```

### `browser_forward`

Go forward in browser history. Returns an updated page snapshot.

*No parameters.*

**Example:**
```
browser_forward({})
```

### `browser_tabs`

Manage browser tabs: list open tabs, switch between them, open a new tab, or close one.

| Parameter  | Type   | Required | Description                                           |
|------------|--------|----------|-------------------------------------------------------|
| `action`   | string | yes      | Tab action: `list`, `switch`, `new`, or `close`       |
| `tabIndex` | number | no       | Tab index for `switch` and `close` actions             |

**Example — list tabs:**
```
browser_tabs({ action: "list" })
```

Returns:
```
2 tab(s) open

→ [0] Example Domain — https://example.com/
  [1] Google — https://www.google.com/
```

**Example — switch to tab:**
```
browser_tabs({ action: "switch", tabIndex: 1 })
```

**Example — open new tab:**
```
browser_tabs({ action: "new" })
```

**Example — close tab:**
```
browser_tabs({ action: "close", tabIndex: 0 })
```

### `browser_close`

Close the browser. The persistent profile (cookies, localStorage) is preserved for the next launch.

*No parameters.*

**Example:**
```
browser_close({})
```

### `browser_set_viewport`

Set the browser viewport size.

| Parameter | Type   | Required | Description               |
|-----------|--------|----------|---------------------------|
| `width`   | number | yes      | Viewport width in pixels  |
| `height`  | number | yes      | Viewport height in pixels |

**Example:**
```
browser_set_viewport({ width: 1280, height: 720 })
```

## Browser Choice

The extension supports three browser engines via Playwright:

| Engine     | Pros                                                    | Cons                                           |
|------------|--------------------------------------------------------|------------------------------------------------|
| **Chromium** (default) | Best compatibility, most sites work out of the box | Largest binary size                           |
| **Firefox**  | Good privacy defaults, strong standards compliance    | Some sites may behave slightly differently     |
| **WebKit**   | Lightweight, mimics Safari behavior                   | Least compatible with complex web apps         |

Switch engines via the `/browser switch` command:

```
/browser switch firefox
```

The engine change takes effect on the next browser launch. Each engine uses its own profile directory (`~/.pi/browser/chromium/`, `~/.pi/browser/firefox/`, `~/.pi/browser/webkit/`).

## Headed vs Headless Mode

- **Headless** (default): The browser runs without a visible window. Best for automated tasks where visual feedback is unnecessary. Overlay features are disabled.

- **Headed**: The browser window is visible on screen. A **visual overlay** is injected into each page showing:
  - An **action bar** at the top that displays what the agent is doing (e.g., "Navigating to https://example.com")
  - **Element highlights** with colored pulsing borders when clicking (blue), typing (green), or selecting (orange)
  - A **cursor dot** that tracks the agent's virtual mouse position
  - A **history panel** in the bottom-right showing recent actions

The overlay uses a Shadow DOM so it doesn't interfere with the page's own styles or functionality. All overlay elements are `pointer-events: none` so they don't block user interaction in interactive/paired mode.

## Mission Briefing Gate

In **interactive mode** (headed browser with UI available), the extension shows a **mission briefing page** before navigating to a new, untrusted domain. This gives the human observer a chance to review and approve (or reject) the agent's intended action.

The briefing page shows:
- The agent's stated mission / reason for navigating
- The target URL and domain
- Currently trusted domains

The user can:
- **Approve** — allow navigation and optionally check "Always trust this domain"
- **Reject** — block navigation (the tool returns a rejection message)

### Domain Trust

Once approved, a domain is trusted for the current session. If the user checks "Always trust this domain," it is also written to the persistent file:

```
~/.pi/browser/trusted-domains.txt
```

**Format:** One domain per line. Comments start with `#`. Wildcard subdomains are supported:

```
# Trusted domains for pi browser extension
example.com
*.github.com
*.google.com
```

`*.github.com` matches `github.com`, `api.github.com`, `docs.github.com`, etc.

In **autonomous mode** (headless or no UI), the briefing gate is skipped entirely — the agent navigates freely.

## Persistent Profile

The browser uses Playwright's `launchPersistentContext` with a user-data directory at `~/.pi/browser/<browserType>/`. This means:

- **Cookies** and **localStorage** persist across sessions
- **Login sessions** survive browser restarts — log in once, stay logged in
- **Browser history** is maintained
- Each browser engine has its own isolated profile

### How to Reset

To clear the profile and start fresh, simply delete the profile directory:

```bash
# Reset Chromium profile
rm -rf ~/.pi/browser/chromium/

# Reset all browser profiles
rm -rf ~/.pi/browser/
```

The directory will be recreated automatically on next launch.

## `/browser` Command

The `/browser` slash command provides quick browser management:

| Subcommand | Description | Example |
|------------|-------------|---------|
| `status` (default) | Show browser status: engine, mode, tabs, URL, tracked elements, trusted domains | `/browser` or `/browser status` |
| `close` | Close the browser (preserves profile) | `/browser close` |
| `switch <type>` | Switch browser engine for next launch (`chromium`, `firefox`, `webkit`) | `/browser switch firefox` |

## Troubleshooting

### Browser not installed

```
Error: Browser not installed. Run: npx playwright install chromium
```

**Fix:** Run the suggested command. Playwright needs to download browser binaries before first use. If using Firefox or WebKit, substitute the engine name accordingly.

### Zombie browser processes

If the agent crashes without gracefully closing the browser, Playwright processes may linger. To clean up:

```bash
# Kill lingering Chromium processes
pkill -f "chromium.*--user-data-dir=.*\.pi/browser"

# Or kill all Playwright browser processes
pkill -f playwright
```

The extension registers `SIGINT` and `SIGTERM` handlers to close the browser on exit, and also hooks into the `session_shutdown` event. However, hard crashes (`SIGKILL`, OOM) can still leave processes behind.

### Profile corruption

If the browser fails to launch or behaves erratically, the persistent profile may be corrupted:

```bash
# Reset the profile
rm -rf ~/.pi/browser/chromium/

# Re-launch — a fresh profile will be created
```

### Navigation timeouts

If navigation takes longer than 30 seconds, the extension returns a partial page snapshot with a `[Navigation timed out]` prefix. Try:

- Using `waitUntil: "domcontentloaded"` (faster) instead of `networkidle`
- Checking if the site is accessible from your network
- Taking a screenshot to see the current page state

### Element not found

```
Error: Element [42] not found. Available elements: 0-15
```

The page content may have changed since the last extraction. Navigate again or use `browser_screenshot` to see the current page state, then retry with a valid element index.

## Directory Structure

| File             | Purpose                                         |
|------------------|-------------------------------------------------|
| `index.ts`       | Extension entry point — registers tools and commands |
| `browser.ts`     | Browser lifecycle (launch, singleton reuse, close) |
| `page.ts`        | Page navigation, interaction, tab management    |
| `extract.ts`     | Content extraction — text + interactive elements |
| `overlay.ts`     | Visual overlay for headed mode                  |
| `briefing.ts`    | Mission briefing gate for domain trust          |
| `briefing.html`  | HTML template for the briefing panel            |
