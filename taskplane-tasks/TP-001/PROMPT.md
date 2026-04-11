# Task: TP-001 - Project Setup & Playwright Dependency

## Dependencies

**None**

## Objective

Set up the project scaffolding for the browser extension: add Playwright as a dependency, create the directory structure, and ensure browser binaries can be installed.

## Requirements

1. **Add `playwright` to `package.json` dependencies** (not devDependencies — this is a runtime dependency for the extension)
2. **Run `npm install`** to install the dependency
3. **Create the directory structure:**
   ```
   extensions/browser/
   ├── index.ts
   ├── browser.ts
   ├── page.ts
   ├── extract.ts
   ├── overlay.ts
   ├── briefing.ts
   └── README.md
   ```
   Each `.ts` file should have a minimal placeholder export (e.g., `export {}` or a comment noting its purpose) so the project compiles.
4. **Create `briefing.html`** as an empty template file in `extensions/browser/` with a comment noting it will be populated in TP-004.
5. **Document the browser install step**: Add a note in `extensions/browser/README.md` that users need to run `npx playwright install chromium` (and optionally `firefox` or `webkit`) after install.
6. **Verify `npm run build` passes** (or `tsc --noEmit` if that's the build check) with the new files in place.

## Context

- This is a pi extension package. Extensions live under `extensions/` and are registered in `package.json` under `pi.extensions`.
- The project uses TypeScript with `ES2022` target, `bundler` module resolution, `strict` mode.
- `tsconfig.json` includes `extensions/**/*.ts`.
- The `extensions/` directory doesn't exist yet — create it.

## Acceptance Criteria

- [ ] `playwright` appears in `package.json` dependencies
- [ ] `extensions/browser/` directory exists with all 7 `.ts` stub files + `briefing.html` + `README.md`
- [ ] `npm run build` (or TypeScript compilation) passes
- [ ] README.md documents the `npx playwright install` step
