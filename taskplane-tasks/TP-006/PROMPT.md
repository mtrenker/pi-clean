# Task: TP-006 - Page Operations (page.ts)

## Dependencies

- **Requires:** TP-002
- **Requires:** TP-003

## Objective

Implement the high-level page interaction layer in `extensions/browser/page.ts`. This is the bridge between tool handlers (TP-007) and the low-level browser/extraction layers.

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- Import `extractPageContent` and its locator map type from `extract.ts`.
- Import `getCurrentPage`, `setCurrentPage` from `browser.ts`.
- The element map returned by `extractPageContent()` is passed through to `click()` and `type()`.

## Context to Read First

`extensions/browser/page.ts`
`extensions/browser/browser.ts`
`extensions/browser/extract.ts`

### Step 0: Preflight

- [ ] Read `browser.ts` and `extract.ts` to understand available APIs and types
- [ ] Plan the page operations interface

### Step 1: Implement Navigation and Content Operations

- [ ] Implement `navigate(page, url, waitUntil?)` — navigate, wait for ready, return `extractPageContent()` result
  - `waitUntil`: `"load"` | `"domcontentloaded"` | `"networkidle"` (default: `"domcontentloaded"`)
- [ ] Implement `goBack(page)` / `goForward(page)` — history navigation, return fresh page snapshot
- [ ] Implement `screenshot(page, options?)` — capture as PNG Buffer, support `fullPage` and `selector` options
- [ ] Implement `evaluate(page, expression)` — run JS via `page.evaluate()`, serialize result, handle non-serializable values

### Step 2: Implement Click and Type Operations

- [ ] Implement `click(page, target, elementMap)` — resolve index via elementMap or use selector directly, click, wait for navigation/stability, return fresh snapshot
- [ ] Implement `type(page, target, text, options, elementMap)` — resolve element, optionally clear (triple-click or `fill()`), type with ~50ms delay, optionally press Enter, return snapshot
- [ ] Handle element not found: return clear error `"Element [index] not found. Available elements: 0-N"`
- [ ] Handle stale elements: if element detached between extraction and click, re-extract and retry once

### Step 3: Implement Tab and Viewport Management

- [ ] Implement `manageTabs(context, action, tabIndex?)` — list/switch/new/close tabs via `context.pages()`
- [ ] Update "current page" in browser.ts via `setCurrentPage()` on tab switch
- [ ] Implement `setViewport(page, width, height)` — set viewport size, return confirmation

### Step 4: Error Handling and Verification

- [ ] Handle navigation timeouts: catch and return page content as-is with note `"Navigation timed out after Ns"`
- [ ] Ensure all functions are properly typed and exported
- [ ] Run `npm run build` to verify TypeScript compilation passes
