# Task: TP-005 - Visual Feedback Overlay (overlay.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement an injectable visual overlay system for headed mode that lets the user watch the agent interact with web pages — highlighting elements before clicks, showing action descriptions, and animating a cursor trail.

## Requirements

### Core API

1. **`injectOverlay(page)`** — Inject the overlay JS + CSS into a page
   - Uses `page.addInitScript()` for JS and `page.addStyleTag()` for CSS
   - Only inject when headed mode is active — no-op in headless
   - All visuals live inside a Shadow DOM container to avoid interfering with page styles
   - Idempotent — safe to call multiple times on the same page

2. **`highlightElement(page, selector, action, label)`** — Highlight an element before interaction
   - `action`: `"click"` | `"type"` | `"select"`
   - `label`: human-readable description (e.g., `'clicking "Sign In"'`)
   - Draws a pulsing colored border around the target element
   - Shows a floating label near the element
   - Different colors per action type (e.g., blue for click, green for type, orange for select)
   - Highlight persists for ~800ms then fades out
   - Calls `window.__piOverlay.highlightElement()` in page context

3. **`showAction(page, text)`** — Show current action in the action bar
   - `text`: plain text description (e.g., `'Navigating to github.com'`, `'Typing "hello" into search'`)
   - Updates the fixed overlay bar at the top of the page
   - Calls `window.__piOverlay.showAction()` in page context

4. **`moveCursorTo(page, x, y)`** — Animate cursor dot to a position
   - Animated dot that moves to click targets, simulating mouse movement
   - Makes it visually obvious where the agent is acting
   - Calls `window.__piOverlay.moveCursorTo()` in page context

5. **`addToHistory(page, action)`** — Add an action to the history panel
   - Calls `window.__piOverlay.addToHistory()` in page context

### Injected Browser-Side Code

The JS bundle injected into the page should create:

**Action Bar (top of page):**
- Fixed position overlay bar at the top
- Shows current action in plain text
- Semi-transparent dark background, light text
- Z-index high enough to float above page content

**Element Highlighting:**
- Pulsing colored border + floating label
- Animation: scale up slightly → hold → fade out over ~800ms
- Colors: blue (#4a9eff) for click, green (#4aff7e) for type, orange (#ffaa4a) for select

**Cursor Trail:**
- Small colored dot (~12px) that smoothly transitions to target coordinates
- CSS transition for smooth movement
- Brief pulse animation on arrival at target

**Action History Panel:**
- Small collapsible panel (bottom-right corner)
- Shows last 5 actions taken on the page
- Each entry: timestamp + action text
- Fades out after 5 seconds of inactivity, reappears on new action

**Shadow DOM Container:**
- ALL overlay elements live inside a Shadow DOM attached to a div at the end of `<body>`
- This prevents page CSS from interfering with overlay styles
- The container div has a known ID: `__pi-overlay-root`

### Implementation Notes

- The entire overlay JS+CSS should be defined as string constants in `overlay.ts`
- Use `page.addInitScript(script)` to inject the JS early (before page scripts run)
- The overlay attaches itself when DOM is ready (`DOMContentLoaded` or mutation observer)
- Expose the control functions on `window.__piOverlay` for the Node.js side to call via `page.evaluate()`
- All animations use CSS transitions/animations (no JS animation loops)

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- This module is called by `page.ts` / `index.ts` before each browser action in headed mode.
- Zero overhead in headless mode — the inject function should be a no-op.

## Acceptance Criteria

- [ ] Overlay injects cleanly via Shadow DOM without affecting page styles
- [ ] Element highlighting works with pulsing border + floating label
- [ ] Action bar displays at top of page with current action text
- [ ] Cursor trail animates smoothly to target positions
- [ ] Action history panel shows last 5 actions, auto-hides after inactivity
- [ ] All overlay functions are callable via `page.evaluate()` through `window.__piOverlay`
- [ ] No-op in headless mode
- [ ] Idempotent injection (safe to call multiple times)
- [ ] All functions properly typed and exported
