# Task: TP-003 - Content Extraction (extract.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement DOM-to-LLM-friendly content extraction in `extensions/browser/extract.ts`. This transforms a web page into readable text plus an indexed list of interactive elements — like a screen reader view.

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- This module is used by `page.ts` (TP-006) for every page snapshot.
- The locator mapping is critical — `page.ts` needs it to resolve indexed clicks/types.
- All DOM extraction should happen inside `page.evaluate()` calls (run in browser context).

## Context to Read First

`extensions/browser/extract.ts`
`extensions/browser/page.ts`

### Step 0: Preflight

- [ ] Read existing `extensions/browser/extract.ts` stub
- [ ] Review Playwright's `page.evaluate()` API for DOM extraction patterns

### Step 1: Implement Text Content Extraction

- [ ] Implement main `extractPageContent(page, options?)` function signature
  - `options.maxLength`: max chars for text content (default: ~8000)
  - Returns: `{ title, url, textContent, interactiveElements, truncated, elementMap }`
- [ ] Extract `innerText` from the page body via `page.evaluate()`
- [ ] Collapse excessive whitespace (multiple newlines → max 2, multiple spaces → 1)
- [ ] Strip content from hidden elements (`display:none`, `visibility:hidden`, `aria-hidden="true"`)
- [ ] Smart truncation: if content exceeds `maxLength`, keep beginning + `\n...[truncated]...\n` + end (~500 chars)

### Step 2: Implement Interactive Elements Indexing

- [ ] Scan page for interactive elements and build indexed list via `page.evaluate()`
- [ ] Index element types: links (`a[href]`), buttons, text inputs, textareas, selects, checkboxes/radios
- [ ] Format each element as: `[0] link "Documentation" → https://docs.example.com` etc.
- [ ] Only index visible elements (not hidden, not zero-size)
- [ ] Cap at ~100 interactive elements (with note if more exist)

### Step 3: Implement Element Locator Mapping

- [ ] Return a `Map<number, string>` mapping index → CSS selector or stable locator
- [ ] Generate stable selectors: prefer `[data-testid]`, `#id`, `[name]`, fall back to nth-of-type paths
- [ ] Handle iframes: extract from main frame only, note iframe presence

### Step 4: Verify

- [ ] Ensure all functions are properly typed and exported
- [ ] Run `npm run build` to verify TypeScript compilation passes
