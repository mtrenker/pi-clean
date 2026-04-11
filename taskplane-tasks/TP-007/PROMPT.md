# Task: TP-007 - Extension Integration (index.ts)

## Dependencies

- **Requires:** TP-006
- **Requires:** TP-004
- **Requires:** TP-005

## Objective

Wire everything together as a pi extension in `extensions/browser/index.ts`. Register all browser tools, manage the lazy lifecycle, integrate the overlay and briefing gate, and handle the `/browser` command.

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- Uses `@sinclair/typebox` for schema definitions (already in project dependencies).
- Study existing pi extensions in `@mariozechner/pi-coding-agent` for the extension API pattern if needed.

## Context to Read First

`extensions/browser/index.ts`
`extensions/browser/browser.ts`
`extensions/browser/page.ts`
`extensions/browser/extract.ts`
`extensions/browser/overlay.ts`
`extensions/browser/briefing.ts`
`package.json`

### Step 0: Preflight

- [ ] Read all module files (`browser.ts`, `page.ts`, `extract.ts`, `overlay.ts`, `briefing.ts`) to understand available APIs
- [ ] Study the pi extension API pattern (check `@mariozechner/pi-coding-agent` or similar for how tools are registered)

### Step 1: Register Browser Tools with Typebox Schemas

- [ ] Register `browser_navigate` — `{ url: string, waitUntil?: string }`, integrates briefing gate for interactive mode
- [ ] Register `browser_click` — `{ index?: number, selector?: string }`, integrates overlay highlight before click
- [ ] Register `browser_type` — `{ index?: number, selector?: string, text: string, pressEnter?: boolean, clear?: boolean }`
- [ ] Register `browser_screenshot` — `{ fullPage?: boolean, selector?: string }`, returns image attachment
- [ ] Register `browser_evaluate` — `{ expression: string }`
- [ ] Register `browser_back` and `browser_forward` — no params
- [ ] Register `browser_tabs` — `{ action: "list" | "switch" | "new" | "close", tabIndex?: number }`
- [ ] Register `browser_close` — no params
- [ ] Register `browser_set_viewport` — `{ width: number, height: number }`

### Step 2: Implement Lifecycle and State Management

- [ ] Implement lazy browser launch on first tool call
- [ ] Maintain module-level element map state: `let currentElementMap: Map<number, string> = new Map()`
- [ ] Update element map after every tool call that returns a page snapshot
- [ ] Register `session_end` handler to call `closeBrowser()` (profile persists, only process killed)

### Step 3: Integrate Overlay and Briefing Gate

- [ ] Detect headed mode (check if browser launched with `headless: false`)
- [ ] In headed mode: inject overlay on every new page load, call highlight/showAction before each action
- [ ] Integrate mission briefing: on `browser_navigate`, check `shouldShowBriefing()`, show briefing if needed, handle approve/reject
- [ ] Track current domain, auto-approve same-domain navigations after initial approval
- [ ] Detect autonomous mode (subagent or headless) to skip briefing

### Step 4: Register /browser Command and Verify

- [ ] Register `/browser` command with subcommands: `status`, `close`, `switch <type>`
- [ ] Handle "browser not installed" error with helpful message
- [ ] Implement configurable timeout (default 30s) with partial state return on timeout
- [ ] Run `npm run build` to verify TypeScript compilation passes
