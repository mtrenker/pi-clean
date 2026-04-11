# Browser Extension

A pi extension that provides browser automation tools using Playwright.

## Setup

After cloning the repo and running `npm install`, you need to install the Chromium browser binary used by Playwright:

```bash
npx playwright install chromium
```

This downloads a compatible Chromium build to Playwright's cache directory. The binary is **not** committed to the repo — each developer must run this command once after a fresh clone or after upgrading the `playwright` dependency.

## Directory Structure

| File            | Purpose                                      |
|-----------------|----------------------------------------------|
| `index.ts`      | Extension entry point                        |
| `browser.ts`    | Browser lifecycle (launch, reuse, close)     |
| `page.ts`       | Page navigation and interaction              |
| `extract.ts`    | Content extraction from web pages            |
| `overlay.ts`    | Visual overlay / element highlighting        |
| `briefing.ts`   | Briefing panel renderer                      |
| `briefing.html` | HTML template for the briefing panel         |
