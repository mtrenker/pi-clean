/**
 * Cloudflare Browser Run - stateful browser session
 *
 * Sections 5.2, 10, and 14.2 of DESIGN.md. This module owns the CDP connection,
 * the action queue, the tab registry, the action budget, and expiry handling.
 *
 * It is written against structural interfaces rather than playwright-core types
 * so the whole state machine is testable without a browser. `cdp.ts` is the only
 * place the real library is imported.
 *
 * Two rules here are technical boundaries rather than guidance:
 *   - `fill` refuses password fields, so the model can never type a credential;
 *   - the action queue is exclusive, so while a human handoff holds it every
 *     model-facing action is rejected instead of interleaving with a person
 *     typing.
 */

import { BrowserRunError, errorMessage } from "./errors.ts";
import {
  assertRef,
  extractRefs,
  orientationExcerpt,
  refSelector,
  type PageOrientation,
} from "./snapshot.ts";
import { type BrowserState } from "./state.ts";
import { assertOriginAllowed, normalizeTarget } from "./url-guard.ts";

// ---------------------------------------------------------------------------
// Structural interfaces over the parts of Playwright this extension uses
// ---------------------------------------------------------------------------

export interface LocatorLike {
  click(options?: { timeout?: number; button?: "left" | "right" | "middle" }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(values: string[], options?: { timeout?: number }): Promise<unknown>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  boundingBox(options?: { timeout?: number }): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  count(): Promise<number>;
}

export interface PageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  goBack(options?: { timeout?: number }): Promise<unknown>;
  goForward(options?: { timeout?: number }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  ariaSnapshot(options?: { mode?: "ai" | "default"; timeout?: number }): Promise<string>;
  locator(selector: string): LocatorLike;
  keyboard: { press(key: string, options?: { timeout?: number }): Promise<void> };
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  pages(): PageLike[];
  storageState(): Promise<unknown>;
  addCookies?(cookies: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
  detach?(): Promise<void>;
}

export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<ContextLike>;
  contexts(): ContextLike[];
  close(): Promise<void>;
  isConnected(): boolean;
  newBrowserCDPSession?(): Promise<CdpSessionLike>;
}

// ---------------------------------------------------------------------------
// Action queue
// ---------------------------------------------------------------------------

export interface ActionQueueOptions {
  depth: number;
  timeoutMs: number;
  /** Called when an action exceeds its timeout, so the session can fail closed. */
  onTimeout?: (label: string) => void;
}

/**
 * Serializes actions against one browser context.
 *
 * Pi executes sibling tool calls from one assistant message concurrently, and two
 * browser actions on one page in parallel is a race with no correct outcome.
 * Arrival order is preserved; a waiter beyond `depth` is rejected immediately
 * rather than queued, so behaviour stays deterministic under a runaway batch.
 *
 * Timeout handling is deliberate. When an action exceeds `timeoutMs` the caller
 * is rejected and `onTimeout` fires, but the chain still waits for the underlying
 * operation to settle so a hung click cannot overlap the next one. The session
 * marks itself failed on that signal, so later calls are rejected with an
 * actionable class instead of queueing behind the hang.
 */
export class ActionQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  readonly #options: ActionQueueOptions;

  constructor(options: ActionQueueOptions) {
    this.#options = options;
  }

  get pending(): number {
    return this.#pending;
  }

  /** Wait for everything already queued to settle, bounded so a hang cannot block teardown. */
  async drain(timeoutMs: number): Promise<boolean> {
    const tail = this.#tail;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([tail.then(() => true), bound]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#pending >= this.#options.depth) {
      throw new BrowserRunError(
        "busy_queue",
        `too many concurrent browser actions (${this.#pending} queued). Retry after the current batch.`,
      );
    }
    this.#pending += 1;

    const previous = this.#tail;
    const started = (async () => {
      await previous;
      if (signal?.aborted) throw new BrowserRunError("busy_queue", "the turn was aborted");
      return fn();
    })();

    // The chain waits for the real operation to settle even when the caller has
    // already given up, so a hung action can never overlap the next one.
    this.#tail = started.then(
      () => {
        this.#pending -= 1;
      },
      () => {
        this.#pending -= 1;
      },
    );

    return this.#race(label, started, signal);
  }

  async #race<T>(label: string, operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.#options.onTimeout?.(label);
        reject(
          new BrowserRunError(
            "session_expired",
            `${label} exceeded ${this.#options.timeoutMs}ms. The page state is unknown; ` +
              "call browser_close, then browser_open.",
          ),
        );
      }, this.#options.timeoutMs);
      if (signal) {
        onAbort = (): void => reject(new BrowserRunError("busy_queue", "the turn was aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    try {
      return await Promise.race([operation, guard]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const EXPIRY_PATTERNS = [
  /target closed/i,
  /target page, context or browser has been closed/i,
  /browser has been closed/i,
  /browser has disconnected/i,
  /connection closed/i,
  /websocket/i,
  /session closed/i,
];

export function isExpiryError(error: unknown): boolean {
  const message = errorMessage(error);
  return EXPIRY_PATTERNS.some((pattern) => pattern.test(message));
}

export interface SessionOpenOptions {
  profile?: string | null;
  allowedOrigins?: string[];
  storageState?: unknown;
  url?: string;
  newTab?: boolean;
}

export interface SessionConfig {
  queueDepth: number;
  actionTimeoutMs: number;
  maxActionsPerSession: number;
  viewport: { width: number; height: number };
}

export interface SessionDeps {
  connect: () => Promise<BrowserLike>;
  config: SessionConfig;
  now?: () => number;
  /**
   * Removes known secret values and secret-carrying patterns from driver error
   * text. Playwright and CDP errors routinely embed the endpoint they were
   * talking to, which carries the account id.
   */
  scrub?: (text: string) => string;
}

export interface ScreenshotBounds {
  fullPage?: boolean;
  format?: "jpeg" | "png";
  maxBytes?: number;
  maxFullPageHeight?: number;
  maxDimension?: number;
}

export interface ScreenshotOutput {
  data: string;
  mimeType: string;
  bytes: number;
  scale: number;
  clipped: boolean;
}

export const SCREENSHOT_MAX_BYTES = 1_500_000;
export const SCREENSHOT_MAX_DIMENSION = 1_600;
export const SCREENSHOT_MAX_FULL_PAGE_HEIGHT = 4_000;

export class BrowserSession {
  #state: BrowserState = "idle";
  #browser: BrowserLike | undefined;
  #context: ContextLike | undefined;
  #pages: PageLike[] = [];
  #activeIndex = 0;
  #profile: string | null = null;
  #allowedOrigins: string[] = [];
  #actions = 0;
  #queue: ActionQueue;
  readonly #deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#queue = new ActionQueue({
      depth: deps.config.queueDepth,
      timeoutMs: deps.config.actionTimeoutMs,
      onTimeout: () => {
        this.#state = "failed";
      },
    });
  }

  get state(): BrowserState {
    return this.#state;
  }

  get profile(): string | null {
    return this.#profile;
  }

  get actionsUsed(): number {
    return this.#actions;
  }

  get actionBudget(): number {
    return this.#deps.config.maxActionsPerSession;
  }

  get allowedOrigins(): string[] {
    return [...this.#allowedOrigins];
  }

  get tabCount(): number {
    return this.#pages.length;
  }

  get activeTabIndex(): number {
    return this.#activeIndex;
  }

  get context(): ContextLike | undefined {
    return this.#context;
  }

  /** Cloudflare-domain commands (Live View, handoff) travel over a browser CDP session. */
  async cdpSession(): Promise<CdpSessionLike> {
    const browser = this.#browser;
    if (!browser?.newBrowserCDPSession) {
      throw new BrowserRunError(
        "no_session",
        "this browser connection does not expose a CDP session, so Live View is unavailable",
      );
    }
    return browser.newBrowserCDPSession();
  }

  /** Held by the human handoff for its whole duration (DESIGN.md section 12.3). */
  enterHandoff(): void {
    this.#state = "handoff";
  }

  leaveHandoff(): void {
    if (this.#state === "handoff") this.#state = "active";
  }

  async open(options: SessionOpenOptions = {}): Promise<PageOrientation> {
    if (this.#state === "connecting") {
      throw new BrowserRunError("busy_queue", "a browser session is already being opened");
    }
    if (this.#state === "closing") {
      throw new BrowserRunError("busy_closing", "the browser session is closing; retry shortly");
    }
    if (this.#state === "handoff") {
      throw new BrowserRunError("busy_handoff", "a human handoff is in progress. Wait for the operator.");
    }

    const wantedProfile = options.profile ?? null;
    if (this.#state === "active" || this.#state === "failed") {
      if (this.#profile !== wantedProfile) {
        throw new BrowserRunError(
          "invalid_request",
          `a browser session is already open with profile ${this.#profile ?? "(none)"}. ` +
            "Call browser_close before opening a different profile.",
        );
      }
      if (this.#state === "active") return this.#reuse(options);
    }

    // Reopening after expiry or failure must release the old handles first;
    // overwriting them would leak a Playwright connection and its context.
    await this.#teardown().catch(() => undefined);

    this.#state = "connecting";
    try {
      const browser = await this.#deps.connect();
      const context = await browser.newContext({
        viewport: this.#deps.config.viewport,
        ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
      });
      const page = await context.newPage();

      this.#browser = browser;
      this.#context = context;
      this.#pages = [page];
      this.#activeIndex = 0;
      this.#profile = wantedProfile;
      this.#allowedOrigins = options.allowedOrigins ? [...options.allowedOrigins] : [];
      this.#actions = 0;
      this.#state = "active";
    } catch (error) {
      this.#state = "failed";
      await this.#teardown().catch(() => undefined);
      throw this.#translate(error, "the browser session could not be opened");
    }

    if (options.url) return this.navigate({ url: options.url });
    return this.orient(this.#activePage(), false);
  }

  async #reuse(options: SessionOpenOptions): Promise<PageOrientation> {
    if (options.newTab) await this.openTab(options.url);
    else if (options.url) return this.navigate({ url: options.url });
    return this.orient(this.#activePage(), Boolean(options.newTab));
  }

  /**
   * Every model-facing operation goes through here: state guard, budget, queue.
   *
   * The budget is spent inside the queued callback rather than before it, so two
   * concurrent calls cannot both pass an admission check that only one of them
   * should have.
   */
  async #queued<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#assertActionable();
    return this.#queue.run(
      label,
      async () => {
        this.#assertActionable();
        if (this.#actions >= this.#deps.config.maxActionsPerSession) {
          throw new BrowserRunError(
            "quota_exhausted",
            `this browser session has used its budget of ${this.#deps.config.maxActionsPerSession} actions. ` +
              "Close and reopen the browser to continue.",
          );
        }
        this.#actions += 1;
        try {
          return await fn();
        } catch (error) {
          throw this.#translate(error, `${label} failed`);
        }
      },
      signal,
    );
  }

  /** Queued operation against the active page. */
  async act<T>(label: string, fn: (page: PageLike) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#queued(label, () => fn(this.#activePage()), signal);
  }

  /** Used by the handoff flow, which holds the queue without spending action budget. */
  async exclusive<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#queue.run(label, fn, signal);
  }

  async navigate(
    options: { url?: string; action?: "back" | "forward" | "reload" },
    signal?: AbortSignal,
  ): Promise<PageOrientation> {
    return this.act(
      "browser_navigate",
      async (page) => {
        const before = page.url();
        if (options.url) {
          const target = normalizeTarget(options.url);
          assertOriginAllowed(target, this.#allowedOrigins);
          await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
        } else if (options.action === "back") await page.goBack();
        else if (options.action === "forward") await page.goForward();
        else if (options.action === "reload") await page.reload();
        else throw new BrowserRunError("invalid_request", "navigate needs either url or action");

        await this.#assertSettledTarget(page);
        return this.orient(page, page.url() !== before);
      },
      signal,
    );
  }

  /**
   * Returns the snapshot together with the page it came from, in one queued
   * window. Reading the URL afterwards would let a sibling action switch tabs
   * between the two, attributing page text to the wrong source.
   */
  async snapshot(signal?: AbortSignal): Promise<{ text: string; url: string; title: string }> {
    return this.act(
      "browser_snapshot",
      async (page) => ({
        text: await page.ariaSnapshot({ mode: "ai" }),
        url: page.url(),
        title: await page.title().catch(() => ""),
      }),
      signal,
    );
  }

  /**
   * `confirm` runs inside the queued window, so the page the operator approved is
   * the page that gets clicked. Approving outside the queue would let a sibling
   * action navigate in between.
   */
  async click(
    ref: string,
    options: {
      button?: "left" | "right" | "middle";
      confirm?: (context: { url: string; ref: string }) => Promise<boolean>;
    } = {},
    signal?: AbortSignal,
  ): Promise<PageOrientation> {
    return this.act(
      "browser_click",
      async (page) => {
        const before = page.url();
        if (options.confirm && !(await options.confirm({ url: before, ref }))) {
          throw new BrowserRunError("invalid_request", "the operator declined this click");
        }
        await page.locator(refSelector(ref)).click({
          ...(options.button ? { button: options.button } : {}),
        });
        await this.#assertSettledTarget(page);
        return this.orient(page, page.url() !== before, ref);
      },
      signal,
    );
  }

  /**
   * Fill refuses password fields. This is a capability boundary, not guidance:
   * there is no path by which the model types a credential.
   */
  async fill(
    ref: string,
    text: string,
    options: { submit?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<PageOrientation> {
    return this.act(
      "browser_fill",
      async (page) => {
        const locator = page.locator(refSelector(ref));
        await assertNotPasswordField(locator, ref);
        const before = page.url();
        await locator.fill(text);
        if (options.submit) await locator.press("Enter");
        await this.#assertSettledTarget(page);
        return this.orient(page, page.url() !== before, ref);
      },
      signal,
    );
  }

  async select(ref: string, values: string[], signal?: AbortSignal): Promise<PageOrientation> {
    return this.act(
      "browser_select",
      async (page) => {
        const before = page.url();
        await page.locator(refSelector(ref)).selectOption(values);
        await this.#assertSettledTarget(page);
        return this.orient(page, page.url() !== before, ref);
      },
      signal,
    );
  }

  async press(key: string, ref: string | undefined, signal?: AbortSignal): Promise<PageOrientation> {
    return this.act(
      "browser_press",
      async (page) => {
        const before = page.url();
        if (ref) await page.locator(refSelector(ref)).press(key);
        else await page.keyboard.press(key);
        await this.#assertSettledTarget(page);
        return this.orient(page, page.url() !== before, ref);
      },
      signal,
    );
  }

  /**
   * Explicit screenshots only, always one image, always bounded in both bytes and
   * pixels.
   *
   * Playwright's `scale` option selects css or device pixels rather than a
   * numeric factor, so shrinking an oversized capture means lowering JPEG quality
   * and narrowing the clip. The applied factor is reported so the model knows the
   * image is not full fidelity.
   *
   * An element capture is measured first. A very large but highly compressible
   * element would otherwise stay under the byte cap while exceeding the pixel
   * cap, so an oversized element is captured through a clipped page screenshot
   * and the clip is reported.
   */
  async screenshot(
    options: ScreenshotBounds & { ref?: string } = {},
    signal?: AbortSignal,
  ): Promise<ScreenshotOutput> {
    return this.act(
      "browser_screenshot",
      async (page) => {
        const format = options.format ?? "jpeg";
        const maxBytes = options.maxBytes ?? SCREENSHOT_MAX_BYTES;
        const maxHeight = options.maxFullPageHeight ?? SCREENSHOT_MAX_FULL_PAGE_HEIGHT;
        const maxDimension = options.maxDimension ?? SCREENSHOT_MAX_DIMENSION;

        const viewportWidth = Math.min(this.#deps.config.viewport.width, maxDimension);
        const viewportHeight = options.fullPage
          ? maxHeight
          : Math.min(this.#deps.config.viewport.height, maxDimension);

        // Measure an element before capturing it, so the pixel cap is real.
        let elementClip: { x: number; y: number; width: number; height: number } | undefined;
        let elementOversize = false;
        if (options.ref) {
          const box = await page
            .locator(refSelector(options.ref))
            .boundingBox()
            .catch(() => null);
          if (box && (box.width > maxDimension || box.height > maxDimension)) {
            elementOversize = true;
            elementClip = {
              x: box.x,
              y: box.y,
              width: Math.min(box.width, maxDimension),
              height: Math.min(box.height, maxDimension),
            };
          }
        }

        const capture = async (factor: number): Promise<Buffer> => {
          const shot: Record<string, unknown> = { type: format };
          if (format === "jpeg") shot["quality"] = Math.max(35, Math.round(70 * factor));

          if (elementClip) {
            shot["clip"] = {
              x: elementClip.x,
              y: elementClip.y,
              width: Math.max(64, Math.round(elementClip.width * factor)),
              height: Math.max(64, Math.round(elementClip.height * factor)),
            };
            return page.screenshot(shot);
          }
          if (options.ref) return page.locator(refSelector(options.ref)).screenshot(shot);

          if (options.fullPage) {
            shot["fullPage"] = true;
            shot["clip"] = {
              x: 0,
              y: 0,
              width: Math.max(320, Math.round(viewportWidth * factor)),
              height: Math.max(240, Math.round(viewportHeight * factor)),
            };
          }
          return page.screenshot(shot);
        };

        let scale = 1;
        let buffer = await capture(scale);
        while (buffer.byteLength > maxBytes && scale > 0.25) {
          scale = Number((scale * 0.7).toFixed(3));
          buffer = await capture(scale);
        }
        if (buffer.byteLength > maxBytes) {
          throw new BrowserRunError(
            "invalid_request",
            `the screenshot is still ${buffer.byteLength} bytes after rescaling to ${scale}. ` +
              "Take an element screenshot with a ref instead of a full page.",
          );
        }

        return {
          data: buffer.toString("base64"),
          mimeType: format === "png" ? "image/png" : "image/jpeg",
          bytes: buffer.byteLength,
          scale,
          clipped: Boolean(options.fullPage) || elementOversize,
        };
      },
      signal,
    );
  }

  async listTabs(
    signal?: AbortSignal,
  ): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    return this.#queued(
      "browser_tabs",
      async () => {
        const tabs = [];
        for (const [index, page] of this.#pages.entries()) {
          tabs.push({
            index,
            url: page.url(),
            title: await page.title().catch(() => ""),
            active: index === this.#activeIndex,
          });
        }
        return tabs;
      },
      signal,
    );
  }

  async openTab(url?: string, signal?: AbortSignal): Promise<PageOrientation> {
    return this.#queued(
      "browser_tabs",
      async () => {
        const context = this.#context;
        if (!context) throw new BrowserRunError("no_session", "there is no browser context");
        const page = await context.newPage();
        this.#pages.push(page);
        this.#activeIndex = this.#pages.length - 1;
        if (url) {
          const target = normalizeTarget(url);
          assertOriginAllowed(target, this.#allowedOrigins);
          await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
        }
        await this.#assertSettledTarget(page);
        return this.orient(page, true);
      },
      signal,
    );
  }

  async selectTab(index: number, signal?: AbortSignal): Promise<PageOrientation> {
    return this.#queued(
      "browser_tabs",
      async () => {
        if (index < 0 || index >= this.#pages.length) {
          throw new BrowserRunError(
            "invalid_request",
            `tab ${index} does not exist; there are ${this.#pages.length} tabs`,
          );
        }
        this.#activeIndex = index;
        const page = this.#activePage();
        await this.#assertSettledTarget(page);
        return this.orient(page, false);
      },
      signal,
    );
  }

  async closeTab(index: number, signal?: AbortSignal): Promise<void> {
    const lastTabClosed = await this.#queued(
      "browser_tabs",
      async () => {
        const page = this.#pages[index];
        if (!page) {
          throw new BrowserRunError("invalid_request", `tab ${index} does not exist`);
        }
        await page.close().catch(() => undefined);
        this.#pages.splice(index, 1);
        if (this.#pages.length === 0) return true;
        this.#activeIndex = Math.min(this.#activeIndex, this.#pages.length - 1);
        return false;
      },
      signal,
    );
    // close() drains the queue, so it runs after the queued work above.
    if (lastTabClosed) await this.close();
  }

  /**
   * Idempotent teardown. Safe to call from close, shutdown, and replacement.
   *
   * The state moves to closing first, which makes the guard reject new actions,
   * and then the queue is drained so teardown does not cut across an action that
   * is already running. The drain is bounded: a hung action must not be able to
   * block shutdown, so after `actionTimeoutMs` teardown proceeds anyway.
   */
  async close(): Promise<void> {
    if (this.#state === "idle") {
      await this.#teardown().catch(() => undefined);
      return;
    }
    this.#state = "closing";
    await this.#queue.drain(this.#deps.config.actionTimeoutMs).catch(() => false);
    await this.#teardown().catch(() => undefined);
    this.#state = "idle";
  }

  async #teardown(): Promise<void> {
    const context = this.#context;
    const browser = this.#browser;
    this.#context = undefined;
    this.#browser = undefined;
    this.#pages = [];
    this.#activeIndex = 0;
    this.#profile = null;
    this.#allowedOrigins = [];
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }

  async orient(page: PageLike, navigated: boolean, aroundRef?: string): Promise<PageOrientation> {
    const snapshot = await page.ariaSnapshot({ mode: "ai" }).catch(() => "");
    const excerpt = orientationExcerpt(snapshot, aroundRef ? { aroundRef } : {});
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      navigated,
      excerpt,
      refCount: extractRefs(snapshot).length,
    };
  }

  #activePage(): PageLike {
    const page = this.#pages[this.#activeIndex];
    if (!page) throw new BrowserRunError("no_session", "there is no active tab");
    return page;
  }

  #assertActionable(): void {
    switch (this.#state) {
      case "active":
        return;
      case "idle":
        throw new BrowserRunError(
          "no_session",
          "no browser session is open. Call browser_open first.",
        );
      case "connecting":
        throw new BrowserRunError("busy_queue", "the browser session is still opening");
      case "handoff":
        throw new BrowserRunError(
          "busy_handoff",
          "a human handoff is in progress. Wait for the operator to finish.",
        );
      case "closing":
        throw new BrowserRunError("busy_closing", "the browser session is closing");
      case "expired":
        throw new BrowserRunError(
          "session_expired",
          `the browser session ended (Cloudflare closes idle sessions). Call browser_open to start a new one${
            this.#profile ? `; profile ${this.#profile} will be restored` : ""
          }.`,
        );
      case "failed":
        throw new BrowserRunError(
          "session_expired",
          "the browser session is in an unknown state after a failed action. Call browser_close, then browser_open.",
        );
    }
  }

  /**
   * Check where the page actually ended up, after every action that can navigate.
   *
   * This is detection, not prevention: the request has already left Cloudflare's
   * network by the time we see the settled URL, and a mid-flight redirect cannot
   * be blocked. What it does enforce is that the page's content is not relayed to
   * the model, and that the operator is told. It runs for anonymous contexts too,
   * because a hostile link can aim the remote browser at a prohibited target
   * whether or not a profile is loaded.
   *
   * DNS is not re-resolved here. The browser has already resolved the host, so a
   * second local lookup would answer a different question.
   */
  async #assertSettledTarget(page: PageLike): Promise<void> {
    const settled = page.url();
    if (settled === "" || settled === "about:blank") return;

    let url: URL;
    try {
      url = normalizeTarget(settled);
    } catch (error) {
      throw new BrowserRunError(
        "target_rejected",
        `the page navigated to a prohibited target and its content was not returned: ${
          error instanceof BrowserRunError ? error.detail : "unsupported URL"
        }. The request had already been made by the remote browser; navigate somewhere known before continuing.`,
        { cause: error },
      );
    }

    if (this.#allowedOrigins.length === 0) return;
    try {
      assertOriginAllowed(url, this.#allowedOrigins);
    } catch (error) {
      throw new BrowserRunError(
        "target_rejected",
        `navigation settled on ${url.origin}, which is outside this session's allowed origins. ` +
          "The page was loaded before this was detected; a mid-flight redirect cannot be blocked.",
        { cause: error },
      );
    }
  }

  /** Map a driver error into the taxonomy, transitioning to expired where warranted. */
  #translate(error: unknown, context: string): BrowserRunError {
    if (error instanceof BrowserRunError) return error;
    if (isExpiryError(error)) {
      this.#state = "expired";
      return new BrowserRunError(
        "session_expired",
        `the browser session ended (Cloudflare closes idle sessions). Call browser_open to start a new one${
          this.#profile ? `; profile ${this.#profile} will be restored` : ""
        }.`,
        { cause: error },
      );
    }
    const message = this.#deps.scrub
      ? this.#deps.scrub(errorMessage(error))
      : errorMessage(error);
    return new BrowserRunError("navigation_failed", `${context}: ${message}`, { cause: error });
  }
}

const PASSWORD_AUTOCOMPLETE = /(current|new)-password/i;

/**
 * Refuse anything that is a password input. Checked at action time against the
 * resolved element rather than against the snapshot text, so a page cannot hide
 * the field type from the check.
 */
export async function assertNotPasswordField(locator: LocatorLike, ref: string): Promise<void> {
  const [type, autocomplete] = await Promise.all([
    locator.getAttribute("type").catch(() => null),
    locator.getAttribute("autocomplete").catch(() => null),
  ]);
  if (type?.toLowerCase() === "password" || (autocomplete && PASSWORD_AUTOCOMPLETE.test(autocomplete))) {
    throw new BrowserRunError(
      "invalid_request",
      `${ref} is a password field. This extension never types credentials; ` +
        "ask the operator to run /browser-login for authenticated access.",
    );
  }
}

export { assertRef };
