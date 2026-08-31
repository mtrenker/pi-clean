/**
 * Session tests - DESIGN.md acceptance criteria AC-S1 to AC-S9, AC-X5, AC-E6.
 *
 * The whole state machine runs against structural doubles, so nothing here
 * contacts Cloudflare or launches a browser.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRunError } from "./errors.ts";
import {
  ActionQueue,
  BrowserSession,
  isExpiryError,
  type BrowserLike,
  type SessionConfig,
} from "./session.ts";
import { createFakeBrowser, createFakePage } from "./test-support.ts";

const CONFIG: SessionConfig = {
  queueDepth: 4,
  actionTimeoutMs: 5_000,
  maxActionsPerSession: 200,
  viewport: { width: 1280, height: 800 },
};

function makeSession(
  overrides: Partial<SessionConfig> = {},
  browserOverride?: { browser: BrowserLike; log: string[] },
): { session: BrowserSession; log: string[]; connects: number } {
  const fake = browserOverride ?? createFakeBrowser();
  const state = { connects: 0 };
  const session = new BrowserSession({
    config: { ...CONFIG, ...overrides },
    connect: async () => {
      state.connects += 1;
      return fake.browser;
    },
  });
  return {
    session,
    log: fake.log,
    get connects() {
      return state.connects;
    },
  } as { session: BrowserSession; log: string[]; connects: number };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("AC-S1 concurrent actions run in arrival order with no interleaving", async () => {
  const order: string[] = [];
  const queue = new ActionQueue({ depth: 8, timeoutMs: 5_000 });

  const work = (label: string, ms: number): Promise<void> =>
    queue.run(label, async () => {
      order.push(`enter:${label}`);
      await delay(ms);
      order.push(`exit:${label}`);
    });

  await Promise.all([work("a", 30), work("b", 5), work("c", 20), work("d", 1)]);

  assert.deepEqual(order, [
    "enter:a",
    "exit:a",
    "enter:b",
    "exit:b",
    "enter:c",
    "exit:c",
    "enter:d",
    "exit:d",
  ]);
});

test("AC-S2 the queue rejects deterministically past its depth", async () => {
  const queue = new ActionQueue({ depth: 4, timeoutMs: 5_000 });
  const running = [1, 2, 3, 4].map((index) => queue.run(`a${index}`, () => delay(20)));
  assert.equal(queue.pending, 4);

  await assert.rejects(
    () => queue.run("overflow", async () => undefined),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "busy_queue" &&
      /too many concurrent browser actions/.test(error.detail),
  );

  await Promise.all(running);
  assert.equal(queue.pending, 0);
  // The queue recovers once the batch drains.
  await queue.run("after", async () => undefined);
});

test("AC-S3 a timed-out action rejects, poisons the session, and releases the queue", async () => {
  const timedOut: string[] = [];
  const queue = new ActionQueue({
    depth: 4,
    timeoutMs: 20,
    onTimeout: (label) => timedOut.push(label),
  });

  await assert.rejects(
    () => queue.run("browser_click", () => delay(120)),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "session_expired" &&
      /exceeded 20ms/.test(error.detail),
  );
  assert.deepEqual(timedOut, ["browser_click"]);

  // The chain keeps waiting for the hung operation, so an action queued behind it
  // times out too rather than interleaving with it. That is the point: a caller
  // gives up, the page does not get two actions at once, and onTimeout has
  // already told the session to fail closed.
  await assert.rejects(
    () => queue.run("queued-behind", async () => "ran"),
    (error: unknown) =>
      error instanceof BrowserRunError && error.errorClass === "session_expired",
  );

  // Once the hang settles the queue is usable again.
  await delay(150);
  const order: string[] = [];
  await queue.run("next", async () => {
    order.push("next");
  });
  assert.deepEqual(order, ["next"]);
});

test("AC-S4 aborting the turn rejects the waiter and frees the queue", async () => {
  const queue = new ActionQueue({ depth: 4, timeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = queue.run("browser_click", () => delay(200), controller.signal);
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "busy_queue" &&
      /aborted/.test(error.detail),
  );
  await queue.run("after", async () => undefined);
});

test("an action queued behind an aborted signal is rejected before it runs", async () => {
  const queue = new ActionQueue({ depth: 4, timeoutMs: 5_000 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => queue.run("browser_click", async () => "ran", controller.signal),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "busy_queue",
  );
});

test("opening connects once and reuses the session for later opens", async () => {
  const harness = makeSession();
  await harness.session.open({ url: "https://example.com/a" });
  assert.equal(harness.session.state, "active");
  assert.equal(harness.connects, 1);

  await harness.session.open({ url: "https://example.com/b" });
  assert.equal(harness.connects, 1, "an open session is reused, not reconnected");
  assert.equal(harness.session.tabCount, 1);
});

test("opening with a different profile is refused rather than silently switching", async () => {
  const harness = makeSession();
  await harness.session.open({ profile: "site-a" });
  await assert.rejects(
    () => harness.session.open({ profile: "site-b" }),
    (error: unknown) =>
      error instanceof BrowserRunError && /Call browser_close before opening a different profile/.test(error.detail),
  );
});

test("AC-S5 close is idempotent and releases context and browser exactly once", async () => {
  const harness = makeSession();
  await harness.session.open({});
  await harness.session.close();
  await harness.session.close();

  assert.equal(harness.session.state, "idle");
  assert.equal(harness.log.filter((entry) => entry === "context.close").length, 1);
  assert.equal(harness.log.filter((entry) => entry === "browser.close").length, 1);
});

test("AC-S6 a closed transport expires the session and never reconnects silently", async () => {
  const page = createFakePage();
  page.goto = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  const fake = createFakeBrowser({ page });
  const harness = makeSession({}, fake);

  await harness.session.open({});
  await assert.rejects(
    () => harness.session.navigate({ url: "https://example.com/next" }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "session_expired" &&
      /Call browser_open to start a new one/.test(error.detail),
  );
  assert.equal(harness.session.state, "expired");

  // Every later action reports the same actionable class; nothing reconnects.
  await assert.rejects(
    () => harness.session.snapshot(),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "session_expired",
  );
  assert.equal(harness.connects, 1);
});

test("expiry patterns cover the driver messages that mean the session is gone", () => {
  for (const message of [
    "Target closed",
    "Target page, context or browser has been closed",
    "Browser has been closed",
    "browser has disconnected",
    "Connection closed while reading from the driver",
    "WebSocket error",
    "Session closed",
  ]) {
    assert.equal(isExpiryError(new Error(message)), true, message);
  }
  assert.equal(isExpiryError(new Error("net::ERR_NAME_NOT_RESOLVED")), false);
});

test("actions before open report no_session with the recovery step", async () => {
  const harness = makeSession();
  await assert.rejects(
    () => harness.session.snapshot(),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "no_session" &&
      /Call browser_open first/.test(error.detail),
  );
});

test("AC-S9 a stale ref fails loudly instead of acting on another element", async () => {
  const page = createFakePage({ locators: { e1: {} } });
  const harness = makeSession({}, createFakeBrowser({ page }));
  await harness.session.open({});

  await harness.session.click("e1");
  await assert.rejects(
    () => harness.session.click("e9"),
    (error: unknown) =>
      error instanceof BrowserRunError && /No element matching aria-ref=e9/.test(error.detail),
  );
});

test("a malformed ref never reaches the selector engine", async () => {
  const harness = makeSession();
  await harness.session.open({});
  for (const bad of ["e1 >> nth=0", "*", "button", "e", "e-1"]) {
    await assert.rejects(
      () => harness.session.click(bad),
      (error: unknown) =>
        error instanceof BrowserRunError &&
        error.errorClass === "invalid_request" &&
        /is not a snapshot ref/.test(error.detail),
      bad,
    );
  }
});

test("AC-X5 fill refuses password fields and types nothing", async () => {
  const log: string[] = [];
  const page = createFakePage({
    log,
    locators: {
      e1: { attributes: { type: "password" } },
      e2: { attributes: { autocomplete: "current-password" } },
      e3: { attributes: { type: "text" } },
    },
  });
  const harness = makeSession({}, createFakeBrowser({ page }));
  await harness.session.open({});

  for (const ref of ["e1", "e2"]) {
    await assert.rejects(
      () => harness.session.fill(ref, "hunter2"),
      (error: unknown) =>
        error instanceof BrowserRunError && /is a password field/.test(error.detail),
      ref,
    );
  }
  assert.equal(
    log.filter((entry) => entry.startsWith("fill:")).length,
    0,
    "nothing was typed into a password field",
  );

  await harness.session.fill("e3", "hello");
  assert.ok(log.includes("fill:e3:hello"));
});

test("navigation confinement rejects an origin outside the profile", async () => {
  const harness = makeSession();
  await harness.session.open({
    profile: "example-site",
    allowedOrigins: ["https://www.example.com"],
  });
  await assert.rejects(
    () => harness.session.navigate({ url: "https://other.example.org/" }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "target_rejected" &&
      /outside the allowed origins/.test(error.detail),
  );
  const orientation = await harness.session.navigate({ url: "https://www.example.com/jobs" });
  assert.equal(orientation.url, "https://www.example.com/jobs");
});

test("a redirect that settles outside the allowlist is reported, not hidden", async () => {
  const page = createFakePage({ url: "https://www.example.com/" });
  page.goto = async () => {
    (page as unknown as { setUrl(url: string): void }).setUrl("https://tracker.example.net/landing");
    return null;
  };
  const harness = makeSession({}, createFakeBrowser({ page }));
  await harness.session.open({ allowedOrigins: ["https://www.example.com"] });

  await assert.rejects(
    () => harness.session.navigate({ url: "https://www.example.com/go" }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "target_rejected" &&
      /a mid-flight redirect cannot be blocked/.test(error.detail),
  );
});

test("the action budget stops a runaway loop with a clear message", async () => {
  const page = createFakePage({ locators: { e1: {} } });
  const harness = makeSession({ maxActionsPerSession: 3 }, createFakeBrowser({ page }));
  await harness.session.open({});

  await harness.session.click("e1");
  await harness.session.click("e1");
  await harness.session.click("e1");
  await assert.rejects(
    () => harness.session.click("e1"),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "quota_exhausted" &&
      /budget of 3 actions/.test(error.detail),
  );
  assert.equal(harness.session.actionsUsed, 3);
});

test("AC-E6 an oversized screenshot is rescaled and the factor is reported", async () => {
  const page = createFakePage({ screenshotBytes: [3_000_000, 2_000_000, 900_000] });
  const harness = makeSession({}, createFakeBrowser({ page }));
  await harness.session.open({});

  const shot = await harness.session.screenshot({ fullPage: true });
  assert.equal(shot.bytes, 900_000);
  assert.ok(shot.scale < 1, "the applied scale is reported");
  assert.equal(shot.mimeType, "image/jpeg");

  const png = await harness.session.screenshot({ format: "png" });
  assert.equal(png.mimeType, "image/png");
});

test("a screenshot that cannot be brought inside the bound fails rather than returning it", async () => {
  const page = createFakePage({ screenshotBytes: 9_000_000 });
  const harness = makeSession({}, createFakeBrowser({ page }));
  await harness.session.open({});
  await assert.rejects(
    () => harness.session.screenshot({ fullPage: true }),
    (error: unknown) =>
      error instanceof BrowserRunError && /still \d+ bytes after rescaling/.test(error.detail),
  );
});

test("tabs open, list, select, and close, and closing the last tab ends the session", async () => {
  const harness = makeSession();
  await harness.session.open({ url: "https://example.com/one" });
  await harness.session.openTab("https://example.com/two");
  assert.equal(harness.session.tabCount, 2);
  assert.equal(harness.session.activeTabIndex, 1);

  const tabs = await harness.session.listTabs();
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1]?.active, true);

  await harness.session.selectTab(0);
  assert.equal(harness.session.activeTabIndex, 0);
  await assert.rejects(
    () => harness.session.selectTab(5),
    (error: unknown) => error instanceof BrowserRunError && /tab 5 does not exist/.test(error.detail),
  );

  await harness.session.closeTab(1);
  assert.equal(harness.session.tabCount, 1);
  await harness.session.closeTab(0);
  assert.equal(harness.session.state, "idle", "closing the last tab ends the session");
});

test("a handoff holds the session so model actions are rejected", async () => {
  const harness = makeSession();
  await harness.session.open({});
  harness.session.enterHandoff();

  await assert.rejects(
    () => harness.session.snapshot(),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "busy_handoff",
  );
  await assert.rejects(
    () => harness.session.open({}),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "busy_handoff",
  );

  harness.session.leaveHandoff();
  assert.equal(harness.session.state, "active");
  await harness.session.snapshot();
});

test("a failed connect leaves no half-open session", async () => {
  const session = new BrowserSession({
    config: CONFIG,
    connect: async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    },
  });
  await assert.rejects(
    () => session.open({}),
    (error: unknown) =>
      error instanceof BrowserRunError && /the browser session could not be opened/.test(error.detail),
  );
  assert.equal(session.state, "failed");
  await session.close();
  assert.equal(session.state, "idle");
});
