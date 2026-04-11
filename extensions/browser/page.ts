// Page navigation and interaction utilities
// High-level bridge between tool handlers and browser/extraction layers

import type { BrowserContext, Page } from "playwright";
import { extractPageContent, type ExtractResult } from "./extract.js";
import { getCurrentPage, setCurrentPage } from "./browser.js";

// ── Types ──────────────────────────────────────────────────────────

export type WaitUntilOption = "load" | "domcontentloaded" | "networkidle";

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
}

export interface TypeOptions {
  clear?: boolean;
  pressEnter?: boolean;
}

// ── Navigation timeout (seconds) ──────────────────────────────────

const NAV_TIMEOUT_MS = 30_000;

// ── Navigation & Content ───────────────────────────────────────────

/**
 * Navigate to `url`, wait for the page to be ready, then return an
 * extracted snapshot of the page content.
 */
export async function navigate(
  page: Page,
  url: string,
  waitUntil: WaitUntilOption = "domcontentloaded",
): Promise<ExtractResult> {
  try {
    await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT_MS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      const result = await extractPageContent(page);
      result.textContent =
        `[Navigation timed out after ${NAV_TIMEOUT_MS / 1000}s]\n\n` +
        result.textContent;
      return result;
    }
    throw err;
  }
  return extractPageContent(page);
}

/**
 * Go back in browser history and return a fresh page snapshot.
 */
export async function goBack(page: Page): Promise<ExtractResult> {
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      const result = await extractPageContent(page);
      result.textContent =
        `[Navigation timed out after ${NAV_TIMEOUT_MS / 1000}s]\n\n` +
        result.textContent;
      return result;
    }
    throw err;
  }
  return extractPageContent(page);
}

/**
 * Go forward in browser history and return a fresh page snapshot.
 */
export async function goForward(page: Page): Promise<ExtractResult> {
  try {
    await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      const result = await extractPageContent(page);
      result.textContent =
        `[Navigation timed out after ${NAV_TIMEOUT_MS / 1000}s]\n\n` +
        result.textContent;
      return result;
    }
    throw err;
  }
  return extractPageContent(page);
}

/**
 * Capture a screenshot as a PNG Buffer.
 */
export async function screenshot(
  page: Page,
  options?: ScreenshotOptions,
): Promise<Buffer> {
  if (options?.selector) {
    const element = page.locator(options.selector);
    return Buffer.from(await element.screenshot({ type: "png" }));
  }
  return Buffer.from(
    await page.screenshot({
      type: "png",
      fullPage: options?.fullPage ?? false,
    }),
  );
}

/**
 * Evaluate a JavaScript expression in the page context.
 * Returns the serialised result as a string.
 */
export async function evaluate(
  page: Page,
  expression: string,
): Promise<string> {
  try {
    const result = await page.evaluate((expr: string) => {
      // eslint-disable-next-line no-eval
      const val = eval(expr);
      // Attempt JSON serialization; fall back to String()
      try {
        return JSON.stringify(val, null, 2) ?? "undefined";
      } catch {
        return String(val);
      }
    }, expression);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Evaluation error] ${msg}`;
  }
}

// ── Click & Type ───────────────────────────────────────────────────

/**
 * Resolve a target to a CSS selector via the element map (numeric index)
 * or use the target directly as a selector string.
 */
function resolveSelector(
  target: string | number,
  elementMap: Map<number, string>,
): string {
  const index = typeof target === "number" ? target : Number(target);
  if (!Number.isNaN(index) && elementMap.has(index)) {
    return elementMap.get(index)!;
  }
  if (typeof target === "string" && Number.isNaN(Number(target))) {
    // Treat as a raw CSS selector
    return target;
  }
  const maxIndex = elementMap.size > 0 ? elementMap.size - 1 : 0;
  throw new Error(
    `Element [${target}] not found. Available elements: 0-${maxIndex}`,
  );
}

/**
 * Click an element identified by index or selector.
 * Waits for navigation / network stability, then returns a fresh snapshot.
 */
export async function click(
  page: Page,
  target: string | number,
  elementMap: Map<number, string>,
): Promise<ExtractResult> {
  const selector = resolveSelector(target, elementMap);

  const doClick = async () => {
    // Click and wait for possible navigation
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 })
        .catch(() => {}),
      page.click(selector, { timeout: 10_000 }),
    ]);
  };

  try {
    await doClick();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stale / detached element → re-extract and retry once
    if (
      msg.includes("detached") ||
      msg.includes("Element is not attached") ||
      msg.includes("Target closed") ||
      msg.includes("was detached")
    ) {
      const freshResult = await extractPageContent(page);
      const freshSelector = resolveSelector(target, freshResult.elementMap);
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 })
          .catch(() => {}),
        page.click(freshSelector, { timeout: 10_000 }),
      ]);
      return extractPageContent(page);
    }
    throw err;
  }

  return extractPageContent(page);
}

/**
 * Type text into an element identified by index or selector.
 * Optionally clears existing content and/or presses Enter afterward.
 */
export async function type(
  page: Page,
  target: string | number,
  text: string,
  options: TypeOptions = {},
  elementMap: Map<number, string>,
): Promise<ExtractResult> {
  const selector = resolveSelector(target, elementMap);

  const doType = async (sel: string) => {
    const locator = page.locator(sel);

    if (options.clear) {
      // Use fill("") to clear, then type with delay for realistic input
      await locator.fill("");
    }

    await locator.pressSequentially(text, { delay: 50 });

    if (options.pressEnter) {
      await locator.press("Enter");
      // Wait briefly for possible navigation after Enter
      await page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 })
        .catch(() => {});
    }
  };

  try {
    await doType(selector);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stale element → re-extract and retry once
    if (
      msg.includes("detached") ||
      msg.includes("Element is not attached") ||
      msg.includes("was detached")
    ) {
      const freshResult = await extractPageContent(page);
      const freshSelector = resolveSelector(target, freshResult.elementMap);
      await doType(freshSelector);
      return extractPageContent(page);
    }
    throw err;
  }

  return extractPageContent(page);
}

// ── Tab & Viewport Management ──────────────────────────────────────

export type TabAction = "list" | "switch" | "new" | "close";

export interface TabResult {
  tabs: Array<{ index: number; url: string; title: string }>;
  activeTabIndex: number;
  message: string;
}

/**
 * Manage browser tabs: list, switch, create new, or close.
 */
export async function manageTabs(
  context: BrowserContext,
  action: TabAction,
  tabIndex?: number,
): Promise<TabResult> {
  const pages = context.pages();

  const currentPage = await getCurrentPage();
  const activeIdx = currentPage ? pages.indexOf(currentPage) : 0;

  const buildTabList = () =>
    pages.map((p, i) => ({
      index: i,
      url: p.url(),
      title: "", // title requires async — filled below
    }));

  // Helper to fill in titles
  const fillTitles = async (tabs: TabResult["tabs"]) => {
    for (const tab of tabs) {
      try {
        tab.title = await pages[tab.index].title();
      } catch {
        tab.title = "(unavailable)";
      }
    }
  };

  switch (action) {
    case "list": {
      const tabs = buildTabList();
      await fillTitles(tabs);
      return {
        tabs,
        activeTabIndex: Math.max(activeIdx, 0),
        message: `${tabs.length} tab(s) open`,
      };
    }

    case "switch": {
      if (tabIndex === undefined || tabIndex < 0 || tabIndex >= pages.length) {
        const tabs = buildTabList();
        await fillTitles(tabs);
        return {
          tabs,
          activeTabIndex: Math.max(activeIdx, 0),
          message: `Invalid tab index. Valid range: 0-${pages.length - 1}`,
        };
      }
      const target = pages[tabIndex];
      setCurrentPage(target);
      await target.bringToFront();
      const tabs = buildTabList();
      await fillTitles(tabs);
      return {
        tabs,
        activeTabIndex: tabIndex,
        message: `Switched to tab ${tabIndex}`,
      };
    }

    case "new": {
      const newPage = await context.newPage();
      setCurrentPage(newPage);
      const freshPages = context.pages();
      const newIdx = freshPages.indexOf(newPage);
      const tabs = freshPages.map((p, i) => ({
        index: i,
        url: p.url(),
        title: "",
      }));
      for (const tab of tabs) {
        try {
          tab.title = await freshPages[tab.index].title();
        } catch {
          tab.title = "(unavailable)";
        }
      }
      return {
        tabs,
        activeTabIndex: newIdx,
        message: `Opened new tab (index ${newIdx})`,
      };
    }

    case "close": {
      const closeIdx = tabIndex ?? activeIdx;
      if (closeIdx < 0 || closeIdx >= pages.length) {
        const tabs = buildTabList();
        await fillTitles(tabs);
        return {
          tabs,
          activeTabIndex: Math.max(activeIdx, 0),
          message: `Invalid tab index ${closeIdx}. Valid range: 0-${pages.length - 1}`,
        };
      }
      await pages[closeIdx].close();
      const remaining = context.pages();
      if (remaining.length > 0) {
        const newActive = Math.min(closeIdx, remaining.length - 1);
        setCurrentPage(remaining[newActive]);
        const tabs = remaining.map((p, i) => ({
          index: i,
          url: p.url(),
          title: "",
        }));
        for (const tab of tabs) {
          try {
            tab.title = await remaining[tab.index].title();
          } catch {
            tab.title = "(unavailable)";
          }
        }
        return {
          tabs,
          activeTabIndex: newActive,
          message: `Closed tab ${closeIdx}`,
        };
      }
      return {
        tabs: [],
        activeTabIndex: -1,
        message: `Closed tab ${closeIdx} — no tabs remaining`,
      };
    }

    default:
      throw new Error(`Unknown tab action: ${action}`);
  }
}

/**
 * Set the viewport size of the page.
 */
export async function setViewport(
  page: Page,
  width: number,
  height: number,
): Promise<string> {
  await page.setViewportSize({ width, height });
  return `Viewport set to ${width}×${height}`;
}
