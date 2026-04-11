# Task: TP-004 - Mission Briefing Gate (briefing.ts)

## Dependencies

- **Requires:** TP-001

## Objective

Implement the mission briefing gate — in interactive/paired mode, the first navigation to a new domain shows an approval page before proceeding.

## Requirements

### Core API

1. **`showBriefing(page, mission)`** — Display the briefing page and wait for user decision
   - `mission.url`: target URL
   - `mission.purpose`: why the agent wants to navigate (from LLM context)
   - `mission.agent`: agent identifier (e.g., "pi browser session")
   - Returns: `Promise<"approved" | "rejected">`

2. **`isDomainTrusted(domain)`** — Check if a domain is in the trust list
   - Checks in-memory session trust list first
   - Then checks `~/.pi/browser/trusted-domains.txt`
   - Supports wildcards: `*.github.com` matches `api.github.com`
   - Supports comments: lines starting with `#` are ignored

3. **`trustDomain(domain, persistent?)`** — Add a domain to the trust list
   - `persistent: false` (default) → in-memory only (session trust)
   - `persistent: true` → appends to `~/.pi/browser/trusted-domains.txt`

4. **`shouldShowBriefing(mode, domain)`** — Decision logic
   - Returns `false` if mode is `"autonomous"` (headless/subagent)
   - Returns `false` if domain is already trusted
   - Returns `true` otherwise

### Briefing Page (`briefing.html`)

A self-contained HTML template with embedded CSS and JS. Loaded via `page.setContent()`.

**Design:**
- Clean, minimal dark theme matching pi's aesthetic
- Content:
  - 🎯 **Mission:** `{purpose}`
  - 🌐 **Target:** `{url}`
  - 🤖 **Agent:** `{agent}`
  - 🕐 **Requested at:** `{timestamp}`
- Two prominent buttons: **✅ Approve** and **❌ Reject**
- Checkbox: "Always trust this domain" (controls persistent trust)
- Shows list of already-trusted domains in the current session
- Keyboard shortcuts: `Enter` to approve, `Escape` to reject

**Implementation:**
- Template is stored as a string constant in `briefing.ts` (or read from `briefing.html` at build time)
- Template uses `{{placeholder}}` tokens replaced at runtime
- Button clicks set a value on `window.__piBriefingResult` that the extension polls via `page.evaluate()`
- Or use `page.waitForFunction()` to wait for the result

### Trust List File Format

`~/.pi/browser/trusted-domains.txt`:
```
# Trusted domains for pi browser agent
# Added automatically when user clicks "Always trust"
github.com
*.github.com
stackoverflow.com
```

- One domain per line
- Lines starting with `#` are comments
- `*.example.com` matches any subdomain of `example.com`
- Empty lines are ignored
- File is created on first persistent trust, not eagerly

## Context

- Part of pi extension at `extensions/browser/`.
- TypeScript, ES2022, strict mode.
- This is used by `index.ts` (TP-007) to gate navigation in interactive mode.
- The briefing is ONLY shown in headed + interactive mode. Headless and subagent modes skip it entirely.

## Acceptance Criteria

- [ ] Briefing page renders with mission details and approve/reject buttons
- [ ] `showBriefing()` resolves with `"approved"` or `"rejected"` based on user action
- [ ] Domain trust list works with in-memory and persistent modes
- [ ] Wildcard matching works for `*.domain.com` patterns
- [ ] `trusted-domains.txt` is parsed correctly (comments, empty lines, wildcards)
- [ ] Keyboard shortcuts work (Enter = approve, Escape = reject)
- [ ] Dark theme, clean design
- [ ] All functions properly typed and exported
