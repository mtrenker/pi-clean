# Task: TP-004 - Mission Briefing Gate (briefing.ts + briefing.html)

## Dependencies

- **Requires:** TP-001

## Objective

Implement the mission briefing gate — in interactive/paired mode, the first navigation to a new domain shows an approval page before proceeding.

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- Used by `index.ts` (TP-007) to gate navigation in interactive mode.
- Briefing is ONLY shown in headed + interactive mode. Headless and subagent modes skip entirely.

## Context to Read First

`extensions/browser/briefing.ts`
`extensions/browser/index.ts`

### Step 0: Preflight

- [ ] Read existing `extensions/browser/briefing.ts` stub
- [ ] Plan the briefing page HTML template design

### Step 1: Implement Domain Trust Management

- [ ] Implement `isDomainTrusted(domain)` — checks in-memory session trust list, then `~/.pi/browser/trusted-domains.txt`
- [ ] Support wildcards: `*.github.com` matches `api.github.com`
- [ ] Parse `trusted-domains.txt` correctly (comments with `#`, empty lines, wildcards)
- [ ] Implement `trustDomain(domain, persistent?)` — in-memory only (default) or appends to `trusted-domains.txt`
- [ ] Implement `shouldShowBriefing(mode, domain)` — returns false for autonomous mode or trusted domains

### Step 2: Build Briefing HTML Template

- [ ] Create self-contained HTML template with embedded CSS and JS in `briefing.html`
- [ ] Dark theme, clean minimal design matching pi aesthetic
- [ ] Show: 🎯 Mission, 🌐 Target URL, 🤖 Agent, 🕐 Timestamp
- [ ] Two prominent buttons: ✅ Approve and ❌ Reject
- [ ] Checkbox: "Always trust this domain" (controls persistent trust)
- [ ] Keyboard shortcuts: Enter to approve, Escape to reject
- [ ] Show list of already-trusted domains in current session

### Step 3: Implement showBriefing Function

- [ ] Implement `showBriefing(page, mission)` → `Promise<"approved" | "rejected">`
- [ ] Load template via `page.setContent()` with `{{placeholder}}` token replacement
- [ ] Wait for user decision via `page.waitForFunction()` on `window.__piBriefingResult`
- [ ] Handle "Always trust" checkbox — call `trustDomain()` with `persistent: true` if checked

### Step 4: Verify

- [ ] Ensure all functions are properly typed and exported
- [ ] Run `npm run build` to verify TypeScript compilation passes
