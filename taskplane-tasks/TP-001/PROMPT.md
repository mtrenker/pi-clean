# Task: TP-001 - Project Setup & Playwright Dependency

## Dependencies

**None**

## Objective

Set up the project scaffolding for the browser extension: add Playwright as a dependency, create the directory structure, and ensure browser binaries can be installed.

## Context

- This is a pi extension package. Extensions live under `extensions/` and are registered in `package.json` under `pi.extensions`.
- The project uses TypeScript with `ES2022` target, `bundler` module resolution, `strict` mode.
- `tsconfig.json` includes `extensions/**/*.ts`.
- The `extensions/` directory doesn't exist yet — create it.

### Step 0: Preflight

- [ ] Read `package.json` and `tsconfig.json` to understand the project structure
- [ ] Verify no `extensions/browser/` directory exists yet

### Step 1: Add Playwright Dependency

- [ ] Add `playwright` to `package.json` dependencies (not devDependencies — this is a runtime dep)
- [ ] Run `npm install` to install the dependency
- [ ] Verify `playwright` appears in `node_modules/`

### Step 2: Create Directory Structure and Stub Files

- [ ] Create `extensions/browser/` directory
- [ ] Create stub `.ts` files with minimal placeholder exports: `index.ts`, `browser.ts`, `page.ts`, `extract.ts`, `overlay.ts`, `briefing.ts`
- [ ] Create `briefing.html` as an empty template file with a comment noting it will be populated in TP-004
- [ ] Create `extensions/browser/README.md` documenting the `npx playwright install chromium` setup step

### Step 3: Verify Build

- [ ] Run `npm run build` (or `tsc --noEmit`) and verify it passes with the new files
- [ ] Fix any TypeScript compilation errors
