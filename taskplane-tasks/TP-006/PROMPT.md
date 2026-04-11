# Task: TP-006 - Page Operations (page.ts)

## Dependencies

- **Requires:** TP-002
- **Requires:** TP-003

## Objective

Implement the high-level page interaction layer in `extensions/browser/page.ts`. This is the main interface between the tool handlers and the browser — every tool call flows through here.

## Requirements

### Core API

All functions take a Playwright `Page` as their first argument (obtained from `browser.ts`). All mutating operations return a fresh page snapshot (from `extract.ts`).

1. **`navigate(page, url, waitUntil?)`**
   - Navigate to the URL
   - `waitUntil`: `"load"` | `"domcontentloaded"` | `"networkidle"` (default: `"domcontentloaded"`)
   - Wait for the page to be ready
   - Return extracted content via `extractPageContent(page)`

2. **`click(page, target, elementMap)`**
   - `target`: `{ index: number }` or `{ selector: string }`
   - `elementMap`: the locator map from `extractPageContent()` — used to resolve index → selector
   - If `index` is provided, resolve it via `elementMap`
   - Click the element using Playwright's `page.click(selector)`
   - Wait for navigation or network idle (with short timeout — not all clicks navigate)
   - Return fresh page snapshot

3. **`type(page, target, text, options, elementMap)`**
   - `target`: `{ index: number }` or `{ selector: string }`
   - `options.pressEnter`: boolean (default: false)
   - `options.clear`: boolean (default: false) — clear the field before typing
   - If `clear`, triple-click to select all then type (or use `fill()`)
   - Type the text character-by-character for realism (configurable delay, default ~50ms)
   - If `pressEnter`, press Enter after typing
   - Return fresh page snapshot

4. **`screenshot(page, options?)`**
   - `options.fullPage`: boolean (default: false)
   - `options.selector`: string — screenshot a specific element
   - Return screenshot as `Buffer` (PNG)

5. **`evaluate(page, expression)`**
   - Run JavaScript expression in page context via `page.evaluate()`
   - Serialize the return value (handle non-serializable values gracefully)
   - Return the serialized result as a string

6. **`goBack(page)` / `goForward(page)`**
   - Navigate history
   - Return fresh page snapshot

7. **`manageTabs(context, action, tabIndex?)`**
   - `action`: `"list"` — return array of `{ index, title, url, active }`
   - `action`: `"switch"` — switch to tab at `tabIndex`, return page snapshot
   - `action`: `"new"` — open a new blank tab, make it active
   - `action`: `"close"` — close tab at `tabIndex` (or current tab)
   - Uses `context.pages()` from Playwright
   - Update the "current page" in browser.ts via `setCurrentPage()`

8. **`setViewport(page, width, height)`**
   - Set viewport size via `page.setViewportSize()`
   - Return confirmation

### Error Handling

- **Element not found**: If an index doesn't exist in the element map or a selector matches nothing, return a clear error: `"Element [index] not found. Available elements: 0-N"`
- **Navigation timeout**: Catch timeout errors and return the page content as-is with a note: `"Navigation timed out after Ns — showing current page state"`
- **Stale elements**: If an element becomes detached between extraction and click, re-extract and retry once

### Integration Points

- Import `extractPageContent` and its locator map type from `extract.ts`
- Import `getCurrentPage`, `setCurrentPage` from `browser.ts`
- The element map returned by `extractPageContent()` is passed through to `click()` and `type()` — the caller (index.ts) holds this state between calls

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- This module is the bridge between tool handlers (TP-007) and the low-level browser/extraction layers.
- Depends on `browser.ts` (TP-002) for browser management and `extract.ts` (TP-003) for content extraction.

## Acceptance Criteria

- [ ] All 8 operations implemented with proper types
- [ ] Every mutating operation returns a fresh page snapshot
- [ ] Index-based element resolution works via the locator map
- [ ] Tab management works (list, switch, new, close)
- [ ] Error handling: element not found, navigation timeout, stale elements
- [ ] Screenshot returns PNG buffer
- [ ] `evaluate()` handles non-serializable return values
- [ ] All functions properly typed and exported
