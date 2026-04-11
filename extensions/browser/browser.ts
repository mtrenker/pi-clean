// Browser lifecycle management — launch, reuse, and close Playwright browsers

import { type BrowserContext, type Page, chromium, firefox, webkit } from "playwright";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export type BrowserType = "chromium" | "firefox" | "webkit";

export interface LaunchOptions {
  browserType?: BrowserType;
  headless?: boolean;
}

// ── Module-level state ─────────────────────────────────────────────

let currentContext: BrowserContext | null = null;
let currentPage: Page | null = null;
let launchLock: Promise<BrowserContext> | null = null;
let cleanupRegistered = false;

// ── Browser engine lookup ──────────────────────────────────────────

const engines = {
  chromium,
  firefox,
  webkit,
} as const;

// ── Launch / Singleton ─────────────────────────────────────────────

/**
 * Launch a persistent Playwright browser context.
 *
 * Uses `~/.pi/browser/<browserType>/` as the user-data directory so
 * cookies, history, and localStorage survive across sessions.
 *
 * Singleton per session — if already launched, returns the existing context.
 * Concurrent callers share a single launch promise to prevent racing.
 */
export async function launchBrowser(
  options?: LaunchOptions,
): Promise<BrowserContext> {
  // Already running — return existing context
  if (currentContext) return currentContext;

  // Concurrent launch safety — reuse in-flight promise
  if (launchLock) return launchLock;

  launchLock = (async () => {
    const browserType = options?.browserType ?? "chromium";
    const headless = options?.headless ?? true;

    const engine = engines[browserType];
    const userDataDir = join(homedir(), ".pi", "browser", browserType);
    mkdirSync(userDataDir, { recursive: true });

    try {
      const context = await engine.launchPersistentContext(userDataDir, {
        headless,
      });

      currentContext = context;
      registerCleanup();
      return context;
    } catch (err: unknown) {
      // Detect missing browser binaries and provide a helpful message
      const msg =
        err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Executable doesn't exist") ||
        msg.includes("browserType.launch") ||
        msg.includes("ENOENT")
      ) {
        throw new Error(
          `Browser not installed. Run: npx playwright install ${browserType}`,
        );
      }
      throw err;
    } finally {
      launchLock = null;
    }
  })();

  return launchLock;
}

// ── Context / Page accessors ───────────────────────────────────────

/** Returns the current browser context, or `null` if not launched. */
export function getBrowser(): BrowserContext | null {
  return currentContext;
}

/**
 * Returns the active page (tab).
 *
 * If a context exists but has no pages, a new page is created.
 * If no context exists, returns `null`.
 */
export async function getCurrentPage(): Promise<Page | null> {
  if (!currentContext) return null;

  if (currentPage) {
    // Verify the page is still open
    try {
      // Accessing a property on a closed page throws
      if (!currentPage.isClosed()) return currentPage;
    } catch {
      currentPage = null;
    }
  }

  // Try to reuse an existing page from the context
  const pages = currentContext.pages();
  if (pages.length > 0) {
    currentPage = pages[0];
    return currentPage;
  }

  // Create a fresh page
  currentPage = await currentContext.newPage();
  return currentPage;
}

/** Switches the "active" page for tab management. */
export function setCurrentPage(page: Page): void {
  currentPage = page;
}

// ── Shutdown ───────────────────────────────────────────────────────

/**
 * Graceful shutdown — close pages, context, and browser.
 *
 * Does NOT delete the persistent profile directory.
 * Safe to call when already closed.
 */
export async function closeBrowser(): Promise<void> {
  const ctx = currentContext;
  currentContext = null;
  currentPage = null;

  if (!ctx) return;

  try {
    await ctx.close();
  } catch {
    // Already closed or crashed — ignore
  }
}

// ── Process cleanup ────────────────────────────────────────────────

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const handler = () => {
    // Fire-and-forget — process is exiting
    closeBrowser().catch(() => {});
  };

  process.on("exit", handler);
  process.on("SIGINT", () => {
    handler();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    handler();
    process.exit(143);
  });
}
