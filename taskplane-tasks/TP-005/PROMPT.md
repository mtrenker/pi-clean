# Task: TP-005 - Visual Feedback Overlay (overlay.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement an injectable visual overlay system for headed mode that lets the user watch the agent interact with web pages — highlighting elements before clicks, showing action descriptions, and animating a cursor trail.

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- Called by `page.ts` / `index.ts` before each browser action in headed mode.
- Zero overhead in headless mode — the inject function should be a no-op.
- All visuals live inside a Shadow DOM container to avoid interfering with page styles.

## Context to Read First

`extensions/browser/overlay.ts`
`extensions/browser/page.ts`

### Step 0: Preflight

- [ ] Read existing `extensions/browser/overlay.ts` stub
- [ ] Plan the overlay JS+CSS bundle structure

### Step 1: Build Injected Browser-Side Code

- [ ] Create JS bundle as string constant — Shadow DOM container (`__pi-overlay-root`), action bar, highlight system, cursor trail, action history panel
- [ ] Create CSS bundle as string constant — styles for action bar (fixed top), element highlights (pulsing borders), cursor dot, history panel (bottom-right)
- [ ] Action bar: fixed position at top, semi-transparent dark background, shows current action text
- [ ] Element highlighting: pulsing colored border + floating label, colors per action type (blue=#4a9eff click, green=#4aff7e type, orange=#ffaa4a select), ~800ms duration then fade
- [ ] Cursor trail: ~12px colored dot, CSS transition for smooth movement, pulse on arrival
- [ ] Action history: collapsible panel bottom-right, last 5 actions with timestamps, auto-hide after 5s inactivity

### Step 2: Implement Node.js API

- [ ] Implement `injectOverlay(page)` — injects JS via `page.addInitScript()` + CSS via `page.addStyleTag()`, idempotent, no-op in headless
- [ ] Implement `highlightElement(page, selector, action, label)` — calls `window.__piOverlay.highlightElement()` via `page.evaluate()`
- [ ] Implement `showAction(page, text)` — calls `window.__piOverlay.showAction()` via `page.evaluate()`
- [ ] Implement `moveCursorTo(page, x, y)` — calls `window.__piOverlay.moveCursorTo()` via `page.evaluate()`
- [ ] Implement `addToHistory(page, action)` — calls `window.__piOverlay.addToHistory()` via `page.evaluate()`

### Step 3: Verify

- [ ] Ensure all functions are properly typed and exported
- [ ] Verify overlay uses Shadow DOM to prevent page style interference
- [ ] Run `npm run build` to verify TypeScript compilation passes
