# Task: TP-003 - Content Extraction (extract.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement DOM-to-LLM-friendly content extraction in `extensions/browser/extract.ts`. This transforms a web page into readable text plus an indexed list of interactive elements — like a screen reader view.

## Requirements

### Core API

1. **`extractPageContent(page, options?)`** — Main extraction function
   - `options.maxLength`: max chars for text content (default: ~8000)
   - Returns: `{ title, url, textContent, interactiveElements, truncated }`

2. **Text Content Extraction**
   - Extract `innerText` from the page body
   - Collapse excessive whitespace (multiple newlines → max 2, multiple spaces → 1)
   - Strip content from hidden elements (`display:none`, `visibility:hidden`, `aria-hidden="true"`)
   - Smart truncation: if content exceeds `maxLength`, keep beginning + `\n...[truncated]...\n` + end (last ~500 chars)

3. **Interactive Elements Index**
   - Scan the page for interactive elements and build an indexed list
   - Element types to index:
     - Links (`a[href]`) — show text + href
     - Buttons (`button`, `[role="button"]`, `input[type="submit"]`) — show text
     - Text inputs (`input[type="text"]`, `input[type="email"]`, `input[type="password"]`, `input[type="search"]`, `input:not([type])`) — show name/placeholder + current value
     - Textareas — show name/placeholder + current value (truncated)
     - Selects — show name + current value + available options
     - Checkboxes/radios — show label + checked state
   - Format each as:
     ```
     [0] link "Documentation" → https://docs.example.com
     [1] button "Sign In"
     [2] input[name="email"] placeholder="Enter email" value=""
     [3] select[name="country"] value="US" options=["US","UK","DE"]
     [4] checkbox "Remember me" checked=false
     ```
   - Only index **visible** elements (not hidden, not zero-size)
   - Cap at ~100 interactive elements (with a note if more exist)

4. **Element Locator Mapping**
   - Return a mapping: `Map<number, string>` — index → CSS selector or other stable locator
   - This is used by `page.ts` to resolve `click(index: 3)` into an actual Playwright locator
   - Generate selectors that are as stable as possible: prefer `[data-testid]`, `#id`, `[name]`, then fall back to nth-of-type paths

5. **iframe Handling**
   - Extract content from the main frame only
   - If iframes are present, add a note: `[Page contains N iframe(s) — content not extracted]`

### Output Format

The final output sent to the LLM looks like:

```
# Page: Example Site — Login
URL: https://example.com/login

Welcome to Example Site. Please sign in to continue.

Lorem ipsum dolor sit amet...

---
Interactive elements:
[0] input[name="email"] placeholder="Email address" value=""
[1] input[type="password"] placeholder="Password" value=""
[2] checkbox "Remember me" checked=false
[3] button "Sign In"
[4] link "Forgot password?" → /forgot
[5] link "Sign up" → /register
```

### Implementation Notes

- All DOM extraction should happen inside `page.evaluate()` calls (run in browser context)
- Keep the evaluate scripts self-contained (no closures over Node.js variables)
- Handle pages that are still loading (wait for body to exist)

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- This module is used by `page.ts` (TP-006) for every page snapshot.
- The locator mapping is critical — `page.ts` needs it to resolve indexed clicks/types.

## Acceptance Criteria

- [ ] Extracts readable text content from a page with smart truncation
- [ ] Builds indexed interactive elements list with proper formatting
- [ ] Returns element locator mapping for click/type resolution
- [ ] Handles hidden elements, empty pages, very long pages
- [ ] iframe presence is noted but content not extracted
- [ ] All functions properly typed and exported
