# Task: TP-008 - Documentation & Testing

## Dependencies

- **Requires:** TP-007

## Objective

Write comprehensive documentation and create a test script for the browser extension.

## Context

- Part of pi extension at `extensions/browser/`.
- All other modules (TP-001 through TP-007) are complete at this point.
- The test script can import directly from sibling `.ts` files.
- Documentation should be practical — focus on "how do I use this".

## Context to Read First

`extensions/browser/index.ts`
`extensions/browser/browser.ts`
`extensions/browser/page.ts`
`extensions/browser/extract.ts`
`extensions/browser/overlay.ts`
`extensions/browser/briefing.ts`
`extensions/browser/README.md`

### Step 0: Preflight

- [ ] Read all module files to understand the full API surface
- [ ] Review existing README.md placeholder content

### Step 1: Write Comprehensive README.md

- [ ] Write Overview section — what the extension does, "agent as a person" concept
- [ ] Write Setup section — `npx playwright install chromium`, persistent profile location `~/.pi/browser/`
- [ ] Document all tools: `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_evaluate`, `browser_back`, `browser_forward`, `browser_tabs`, `browser_close`, `browser_set_viewport` — each with description, params, example
- [ ] Write Browser Choice section — chromium/firefox/webkit trade-offs
- [ ] Write Headed vs Headless Mode section — visual overlay, how to enable/disable
- [ ] Write Mission Briefing Gate section — how it works, domain trust, `trusted-domains.txt` format
- [ ] Write Persistent Profile section — what's stored, how sessions carry, how to reset
- [ ] Write `/browser` Command section — all subcommands
- [ ] Write Troubleshooting section — browser not installed, zombie processes, profile corruption

### Step 2: Create Test Script

- [ ] Create `extensions/browser/test-browser.ts` exercising all tools
- [ ] Test navigation to `https://example.com` and verify extraction returns text + interactive elements
- [ ] Test clicking a link by index
- [ ] Test typing into an input field
- [ ] Test screenshot capture
- [ ] Test evaluate with a simple JS expression
- [ ] Test back/forward navigation
- [ ] Test tab management (open, switch, list, close)
- [ ] Test viewport resize
- [ ] Add clear pass/fail output, cleanup (close browser), runnable with `npx tsx extensions/browser/test-browser.ts`

### Step 3: Verify

- [ ] Run `npm run build` to verify TypeScript compilation passes
- [ ] Verify README.md is complete and all sections are present
