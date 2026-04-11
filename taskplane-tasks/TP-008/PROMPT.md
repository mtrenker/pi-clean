# Task: TP-008 - Documentation & Testing

## Dependencies

- **Requires:** TP-007

## Objective

Write comprehensive documentation and create a test script for the browser extension.

## Requirements

### Documentation (`extensions/browser/README.md`)

Replace the placeholder README with full documentation covering:

1. **Overview** — What the browser extension does, the "agent as a person" concept
2. **Setup**
   - Installing Playwright: `npx playwright install chromium` (and optionally firefox/webkit)
   - Persistent profile location: `~/.pi/browser/`
3. **Available Tools** — document each tool with:
   - Description
   - Parameters (with types and defaults)
   - Example usage
   - Example output
4. **Browser Choice** — how to switch between chromium/firefox/webkit, trade-offs
5. **Headed vs Headless Mode**
   - How headed mode works (visual overlay, action highlighting)
   - How to enable/disable headed mode
6. **Mission Briefing Gate**
   - How it works in interactive mode
   - Domain trust: session vs persistent
   - `trusted-domains.txt` format and location
   - How to disable the gate
7. **Persistent Profile**
   - What's stored and where
   - How sessions carry across (cookies, localStorage)
   - How to reset the profile (just delete the directory)
8. **`/browser` Command** — document all subcommands
9. **Troubleshooting**
   - Browser not installed
   - Zombie processes
   - Profile corruption (delete and recreate)

### Test Script

Create `extensions/browser/test-browser.ts` — a manual test script that exercises all tools:

1. **Navigate** to a known stable page (e.g., `https://example.com`)
2. **Verify extraction** — check that text content and interactive elements are returned
3. **Click** a link by index
4. **Navigate** to a page with a form
5. **Type** into an input field
6. **Screenshot** the page
7. **Evaluate** a simple JS expression
8. **Back/Forward** navigation
9. **Tab management** — open new tab, switch, list, close
10. **Viewport** — set a mobile viewport size

The test script should:
- Use the modules directly (not through the extension tool API)
- Print results to console with clear pass/fail indicators
- Clean up after itself (close browser)
- Be runnable with `npx tsx extensions/browser/test-browser.ts`

### Edge Cases to Document/Test

- Page with no interactive elements
- Very long pages (>100K chars)
- SPAs with client-side navigation
- Pages behind authentication
- File downloads (behavior and where files go)
- Pages with iframes

## Context

- Part of pi extension at `extensions/browser/`.
- All other modules (TP-001 through TP-007) are complete at this point.
- The test script can import directly from the sibling `.ts` files.
- Documentation should be practical — focus on "how do I use this" over architecture.

## Acceptance Criteria

- [ ] README.md is comprehensive and covers all sections listed above
- [ ] Every tool is documented with params, description, and example
- [ ] Test script exercises all major code paths
- [ ] Test script is runnable and provides clear output
- [ ] Edge cases are documented with expected behavior
- [ ] Setup instructions are clear and complete
