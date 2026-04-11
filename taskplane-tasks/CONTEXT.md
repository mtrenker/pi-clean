# General — Context

**Last Updated:** 2026-04-11
**Status:** Active
**Next Task ID:** TP-009

---

## Current State

Building a **Playwright-based web browser extension** for pi-clean. The extension gives agents their own persistent browser identity at `~/.pi/browser/`, with LLM-friendly page extraction, visual feedback overlays for headed mode, and a mission briefing approval gate for interactive sessions.

**Source plan:** `PLAN.md`

### Task Overview

| Task | Title | Dependencies | Wave |
|------|-------|-------------|------|
| TP-001 | Project Setup & Playwright Dependency | — | 1 |
| TP-002 | Browser Manager (`browser.ts`) | TP-001 | 2 |
| TP-003 | Content Extraction (`extract.ts`) | TP-001 | 2 |
| TP-004 | Mission Briefing Gate (`briefing.ts`) | TP-001 | 2 |
| TP-005 | Visual Feedback Overlay (`overlay.ts`) | TP-001 | 2 |
| TP-006 | Page Operations (`page.ts`) | TP-002, TP-003 | 3 |
| TP-007 | Extension Integration (`index.ts`) | TP-006, TP-004, TP-005 | 4 |
| TP-008 | Documentation & Testing | TP-007 | 5 |

### Architecture

```
extensions/browser/
├── index.ts          # Extension entry: registers tools, manages lifecycle
├── browser.ts        # Playwright browser/context management, persistent profiles
├── page.ts           # Page operations: navigate, click, type, screenshot
├── extract.ts        # DOM → LLM-friendly content extraction
├── overlay.ts        # Visual feedback overlay — highlights, annotations, action trail
├── briefing.ts       # Mission briefing gate — approval page before browsing starts
├── briefing.html     # Mission briefing page template
└── README.md         # Usage docs
```

---

## Key Files

| Category | Path |
|----------|------|
| Plan | `PLAN.md` |
| Extension code | `extensions/browser/` |
| Tasks | `taskplane-tasks/` |
| Package config | `package.json` |
| TS config | `tsconfig.json` |

---

## Key Conventions

- TypeScript, ES2022 target, `bundler` module resolution, strict mode
- pi extension API — uses `@sinclair/typebox` for tool schemas
- Extensions registered in `package.json` under `pi.extensions`
- Playwright persistent contexts at `~/.pi/browser/<browserType>/`

---

## Technical Debt / Future Work

- **Playwright auto-install**: Should the extension auto-run `npx playwright install chromium` on first use? (Open question from PLAN.md)
- **Download handling**: Where do agent downloads go? (Proposed: `~/.pi/browser/downloads/`)
- **Headed ↔ Headless switching**: Can't switch mid-session in Playwright — needs close + relaunch with profile persistence
