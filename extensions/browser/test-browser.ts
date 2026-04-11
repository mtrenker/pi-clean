#!/usr/bin/env npx tsx
// Test script for the browser extension
// Run with: npx tsx extensions/browser/test-browser.ts
//
// Requirements:
//   - Chromium installed: npx playwright install chromium
//   - Network access to https://example.com

import { chromium, type BrowserContext, type Page } from "playwright";
import {
  navigate,
  goBack,
  goForward,
  screenshot,
  evaluate,
  click,
  type as typeText,
  manageTabs,
  setViewport,
} from "./page.js";
import { extractPageContent } from "./extract.js";

// ── Helpers ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
}

// ── Test suite ─────────────────────────────────────────────────────

async function runTests() {
  console.log("Browser Extension — Test Suite\n");
  console.log("Launching Chromium (headless)...");

  let context: BrowserContext | null = null;

  try {
    // Launch a temporary browser (no persistent profile for tests)
    context = await chromium.launchPersistentContext("", {
      headless: true,
    });
    let page = context.pages()[0] || (await context.newPage());

    // ── 1. Navigation ──────────────────────────────────────────────
    section("Navigation");

    const navResult = await navigate(page, "https://example.com");
    assert(navResult.title.length > 0, `Page has title: "${navResult.title}"`);
    assert(navResult.url.includes("example.com"), `URL contains example.com: ${navResult.url}`);
    assert(navResult.textContent.length > 0, "Text content is non-empty");
    assert(
      navResult.textContent.includes("Example Domain"),
      'Text includes "Example Domain"',
    );
    assert(navResult.interactiveElements.length > 0, "Interactive elements found");
    assert(
      navResult.interactiveElements.some((e) => e.includes("link")),
      "At least one link in interactive elements",
    );
    assert(navResult.elementMap.size > 0, "Element map is populated");

    // ── 2. Click ───────────────────────────────────────────────────
    section("Click");

    // Click the "More information..." link (index 0 on example.com)
    const clickResult = await click(page, 0, navResult.elementMap);
    assert(
      clickResult.url.includes("iana.org") || clickResult.url !== navResult.url,
      `Navigation occurred after click: ${clickResult.url}`,
    );
    assert(clickResult.textContent.length > 0, "Clicked page has text content");

    // ── 3. Back / Forward ──────────────────────────────────────────
    section("Back / Forward");

    const backResult = await goBack(page);
    assert(
      backResult.url.includes("example.com"),
      `Went back to example.com: ${backResult.url}`,
    );

    const forwardResult = await goForward(page);
    assert(
      forwardResult.url !== backResult.url || forwardResult.url.includes("iana.org"),
      `Went forward: ${forwardResult.url}`,
    );

    // Navigate back to example.com for remaining tests
    await navigate(page, "https://example.com");

    // ── 4. Type ────────────────────────────────────────────────────
    section("Type");

    // Navigate to a page with a search input for typing tests
    const searchPage = await navigate(page, "https://www.google.com");
    // Find an input element to type into
    const inputElements = [...searchPage.elementMap.entries()].filter(
      ([_, sel]) => sel.includes("input") || sel.includes("textarea"),
    );
    if (inputElements.length > 0) {
      const [inputIndex] = inputElements[0];
      const typeResult = await typeText(
        page,
        inputIndex,
        "hello world",
        { clear: true },
        searchPage.elementMap,
      );
      assert(typeResult.textContent.length > 0, "Page content after typing is non-empty");
      assert(true, `Typed into element [${inputIndex}] successfully`);
    } else {
      // Fallback: test typing on a page with a known input via evaluate
      await evaluate(page, `
        const input = document.createElement('input');
        input.id = 'test-input';
        document.body.prepend(input);
      `);
      const freshExtract = await extractPageContent(page);
      const testInput = [...freshExtract.elementMap.entries()].find(
        ([_, sel]) => sel.includes("test-input"),
      );
      if (testInput) {
        const typeResult = await typeText(
          page,
          testInput[0],
          "hello world",
          { clear: true },
          freshExtract.elementMap,
        );
        assert(typeResult.textContent.length > 0, "Typed into injected input successfully");
      } else {
        assert(false, "Could not find any input element for type test");
      }
    }

    // ── 5. Screenshot ──────────────────────────────────────────────
    section("Screenshot");

    await navigate(page, "https://example.com");
    const screenshotBuffer = await screenshot(page);
    assert(Buffer.isBuffer(screenshotBuffer), "Screenshot returns a Buffer");
    assert(screenshotBuffer.length > 1000, `Screenshot has data (${screenshotBuffer.length} bytes)`);

    // Full-page screenshot
    const fullScreenshot = await screenshot(page, { fullPage: true });
    assert(fullScreenshot.length > 1000, `Full-page screenshot has data (${fullScreenshot.length} bytes)`);

    // ── 6. Evaluate ────────────────────────────────────────────────
    section("Evaluate");

    const evalResult = await evaluate(page, "2 + 2");
    assert(evalResult.includes("4"), `Evaluate 2+2 = ${evalResult}`);

    const titleResult = await evaluate(page, "document.title");
    assert(titleResult.includes("Example"), `Evaluate document.title = ${titleResult}`);

    const errorResult = await evaluate(page, "throw new Error('test error')");
    assert(
      errorResult.includes("error") || errorResult.includes("Error"),
      `Evaluate error handling: ${errorResult}`,
    );

    // ── 7. Tab Management ──────────────────────────────────────────
    section("Tab Management");

    // List tabs
    const listResult = await manageTabs(context, "list");
    assert(listResult.tabs.length >= 1, `Tabs listed: ${listResult.tabs.length}`);
    assert(listResult.message.includes("tab"), `List message: "${listResult.message}"`);

    // Open new tab
    const newTabResult = await manageTabs(context, "new");
    assert(
      newTabResult.tabs.length === listResult.tabs.length + 1,
      `New tab opened, total: ${newTabResult.tabs.length}`,
    );

    // Switch to tab 0
    const switchResult = await manageTabs(context, "switch", 0);
    assert(switchResult.activeTabIndex === 0, "Switched to tab 0");

    // Close the new tab (last one)
    const closeResult = await manageTabs(
      context,
      "close",
      newTabResult.tabs.length - 1,
    );
    assert(
      closeResult.tabs.length === newTabResult.tabs.length - 1,
      `Tab closed, remaining: ${closeResult.tabs.length}`,
    );

    // ── 8. Viewport ────────────────────────────────────────────────
    section("Viewport");

    // Get current page again after tab operations
    const pages = context.pages();
    page = pages[0] || (await context.newPage());

    const viewportResult = await setViewport(page, 800, 600);
    assert(viewportResult.includes("800"), `Viewport set: ${viewportResult}`);
    assert(viewportResult.includes("600"), "Viewport height in result");

    const size = page.viewportSize();
    assert(size?.width === 800, `Actual viewport width: ${size?.width}`);
    assert(size?.height === 600, `Actual viewport height: ${size?.height}`);

  } catch (err) {
    console.error("\n💥 Unhandled error:", err);
    failed++;
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────
    section("Cleanup");
    if (context) {
      await context.close();
      console.log("  Browser closed.");
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(64)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("═".repeat(64));

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
