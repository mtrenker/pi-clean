/**
 * Extension wiring tests - DESIGN.md acceptance criteria AC-C2 and AC-X1.
 *
 * These drive the real factory through a minimal Pi double, so the assertions
 * cover the code paths a session actually takes.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import cloudflareBrowserRun from "./index.ts";
import { ACCOUNT_ID_ENV, TOKEN_ENV } from "./credentials.ts";
import { statePaths } from "./config.ts";
import { BrowserRunError } from "./errors.ts";
import {
  collectStrings,
  createFakeBrowser,
  createFakeContext,
  createFakePage,
  createFakePi,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_TOKEN,
  toolResultEntry,
  type FakePi,
} from "./test-support.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface Sandbox {
  pi: FakePi;
  agentDir: string;
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  setResponse(response: { status?: number; body?: unknown; headers?: Record<string, string> }): void;
}

async function sandbox(t: {
  after: (fn: () => Promise<void> | void) => void;
}): Promise<Sandbox> {
  const agentDir = await mkdtemp(join(tmpdir(), "cfbr-agent-"));
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  const previousAccount = process.env[ACCOUNT_ID_ENV];
  const previousToken = process.env[TOKEN_ENV];
  const previousFetch = globalThis.fetch;

  process.env[AGENT_DIR_ENV] = agentDir;
  delete process.env[ACCOUNT_ID_ENV];
  delete process.env[TOKEN_ENV];

  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  let scripted: { status?: number; body?: unknown; headers?: Record<string, string> } = {
    body: { success: true, result: "# Example\n\nBody text." },
  };

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify(scripted.body ?? { success: true, result: "" }), {
      status: scripted.status ?? 200,
      headers: scripted.headers ?? {},
    });
  }) as unknown as typeof globalThis.fetch;

  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previousAgentDir;
    if (previousAccount === undefined) delete process.env[ACCOUNT_ID_ENV];
    else process.env[ACCOUNT_ID_ENV] = previousAccount;
    if (previousToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previousToken;
    await rm(agentDir, { recursive: true, force: true });
  });

  const pi = createFakePi();
  return {
    pi,
    agentDir,
    fetchCalls,
    setResponse(response) {
      scripted = response;
    },
  };
}

function configureEnvCredentials(): void {
  process.env[ACCOUNT_ID_ENV] = FIXTURE_ACCOUNT_ID;
  process.env[TOKEN_ENV] = FIXTURE_TOKEN;
}

test("AC-C2 the factory registers its surface and does nothing else", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);

  assert.deepEqual(
    [...box.pi.tools.keys()],
    [
      "browser_read",
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_select",
      "browser_press",
      "browser_screenshot",
      "browser_tabs",
      "browser_close",
    ],
  );
  assert.deepEqual([...box.pi.commands.keys()], ["browser"]);
  assert.ok(box.pi.handlers.has("session_start"));
  assert.ok(box.pi.handlers.has("session_shutdown"));
  assert.equal(box.pi.execCalls.length, 0, "no process is spawned at factory time");
  assert.equal(box.fetchCalls.length, 0, "no network call is made at factory time");
});

test("session_start leaves the interaction tools inactive on a fresh branch", async (t) => {
  const box = await sandbox(t);
  box.pi.activeTools = ["read", "bash", "browser_click"];
  cloudflareBrowserRun(box.pi.api);
  const { ctx } = createFakeContext();

  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(box.pi.activeTools, ["read", "bash"]);
});

test("a resumed branch that used the interaction tools keeps their schemas active", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext({
    branch: [
      toolResultEntry("browser_open", { state: "active", profile: null, page: null }),
      toolResultEntry("browser_click", {
        state: "active",
        profile: "example-site",
        page: { origin: "https://www.example.com", path: "/jobs" },
      }),
    ],
  });

  await box.pi.emit("session_start", { reason: "resume" }, ctx);

  for (const name of ["browser_click", "browser_snapshot", "browser_close"]) {
    assert.ok(box.pi.activeTools.includes(name), `${name} should stay active after resume`);
  }

  // The browser itself is gone, so a stale call fails with an actionable class.
  const tool = box.pi.tools.get("browser_click");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-r", { ref: "e1" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "no_session",
  );

  const command = box.pi.commands.get("browser");
  await command?.handler("status", ctx);
  const text = ui.notifications.at(-1)?.text ?? "";
  assert.match(text, /last profile {2}: example-site/);
  assert.match(text, /last page {5}: https:\/\/www\.example\.com\/jobs/);
});

test("AC-C2 session_start reads no secret store and opens no socket", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();

  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  assert.equal(box.pi.execCalls.length, 0);
  assert.equal(box.fetchCalls.length, 0);
  // Unconfigured sessions show no badge rather than an inaccurate one.
  assert.deepEqual(ui.status, [undefined]);
});

test("session_start sets a badge once credentials are configured, still without resolving", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();

  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(ui.status, ["browser run: idle"]);
  assert.equal(box.fetchCalls.length, 0);

  await box.pi.emit("session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(ui.status, ["browser run: idle", undefined]);
});

test("AC-X1 browser_read returns bounded untrusted content and leaks no secret", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  box.setResponse({
    body: { success: true, result: "# Example\n\nBody text with a link." },
    headers: { "x-browser-ms-used": "812" },
  });

  const tool = box.pi.tools.get("browser_read");
  assert.ok(tool);
  const updates: unknown[] = [];
  const result = await tool.execute(
    "call-1",
    { url: "https://example.com/docs" },
    undefined,
    (partial) => updates.push(partial),
    ctx,
  );

  const text = result.content[0]?.text ?? "";
  assert.match(text, /^<untrusted-page-content source="https:\/\/example\.com\/docs" tool="browser_read">/);
  assert.match(text, /Body text with a link\./);
  assert.match(text, /<\/untrusted-page-content>$/);
  assert.deepEqual(result.details, {
    state: "idle",
    profile: null,
    tab: null,
    page: { origin: "https://example.com", path: "/docs" },
    truncated: false,
    bytes: 33,
  });
  assert.equal(updates.length, 1);

  // The request carried the token in a header, never in the URL.
  const call = box.fetchCalls.at(-1);
  assert.ok(call);
  assert.match(call.url, /\/browser-rendering\/markdown$/);
  assert.deepEqual(JSON.parse(String(call.init.body)), { url: "https://example.com/docs" });

  const logText = await readFile(statePaths(box.agentDir).logFile, "utf8");
  const surfaces = [
    ...collectStrings(result.content),
    ...collectStrings(result.details),
    ...collectStrings(updates),
    ...ui.notifications.map((entry) => entry.text),
    ...ui.status.filter((entry): entry is string => typeof entry === "string"),
    ...box.pi.execCalls.flatMap((entry) => [entry.command, ...entry.args]),
    logText,
  ];
  for (const surface of surfaces) {
    assert.ok(!surface.includes(FIXTURE_TOKEN), `token leaked into: ${surface.slice(0, 120)}`);
    assert.ok(!surface.includes(FIXTURE_ACCOUNT_ID), `account id leaked into: ${surface.slice(0, 120)}`);
  }

  const logged = JSON.parse(logText.trim().split("\n")[0] as string) as Record<string, unknown>;
  assert.equal(logged["event"], "quick_action");
  assert.equal(logged["target"], "https://example.com/docs");
  assert.equal(logged["browserMs"], 812);
});

test("browser_read rejects a prohibited target before any request", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api);
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const tool = box.pi.tools.get("browser_read");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-2", { url: "http://127.0.0.1:8080/admin" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError && error.errorClass === "target_rejected",
  );
  assert.equal(box.fetchCalls.length, 0);

  await assert.rejects(
    () => tool.execute("call-3", { url: "https://user:pw@example.com/" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof BrowserRunError && /userinfo/.test(error.detail),
  );
  assert.equal(box.fetchCalls.length, 0);
});

test("browser_read without credentials reports not_configured and makes no request", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const tool = box.pi.tools.get("browser_read");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-4", { url: "https://example.com/" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError && error.errorClass === "not_configured",
  );
  assert.equal(box.fetchCalls.length, 0);
});

test("prepareArguments strips a leading @ from the URL", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);
  const tool = box.pi.tools.get("browser_read");
  assert.ok(tool?.prepareArguments);
  assert.deepEqual(tool.prepareArguments({ url: "@https://example.com/" }), {
    url: "https://example.com/",
  });
  assert.deepEqual(tool.prepareArguments({ url: "https://example.com/" }), {
    url: "https://example.com/",
  });
  assert.equal(tool.prepareArguments("not an object"), "not an object");
});

test("truncated reads report the bound and name the spill file", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api);
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const long = Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join("\n");
  box.setResponse({ body: { success: true, result: long } });

  const tool = box.pi.tools.get("browser_read");
  assert.ok(tool);
  const result = await tool.execute(
    "call-5",
    { url: "https://example.com/long", max_bytes: 4_000 },
    undefined,
    undefined,
    ctx,
  );
  const text = result.content[0]?.text ?? "";
  assert.match(text, /\[Output truncated: \d+ of 4000 lines/);
  assert.match(text, /Full output saved to: .*page\.md\]/);
  assert.equal((result.details as { truncated: boolean }).truncated, true);
});

test("/browser status prints configuration without resolving credentials", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const command = box.pi.commands.get("browser");
  assert.ok(command);
  await command.handler("", ctx);

  const text = ui.notifications.at(-1)?.text ?? "";
  assert.match(text, /credentials {3}: not configured/);
  assert.match(text, /crawl purposes: ai-input/);
  assert.match(text, /Browser Rendering - Edit permission/);
  assert.equal(box.pi.execCalls.length, 0);
  assert.equal(box.fetchCalls.length, 0);

  assert.deepEqual(command.getArgumentCompletions?.("c"), [
    { value: "check", label: "check" },
    { value: "close", label: "close" },
  ]);
});

test("/browser check reports a rejected token and invalidates the cache", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  box.setResponse({
    status: 401,
    body: { success: false, errors: [{ message: "Authentication error" }] },
  });

  const command = box.pi.commands.get("browser");
  assert.ok(command);
  await command.handler("check", ctx);

  const notification = ui.notifications.at(-1);
  assert.equal(notification?.level, "error");
  assert.match(notification?.text ?? "", /credentials_rejected/);
  assert.ok(!(notification?.text ?? "").includes(FIXTURE_TOKEN));
  assert.equal(box.fetchCalls.length, 1, "401 is not retried");
});

test("/browser check reports success against a healthy account", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  box.setResponse({ body: { success: true, result: "# pi" }, headers: { "x-browser-ms-used": "40" } });

  const command = box.pi.commands.get("browser");
  assert.ok(command);
  await command.handler("check", ctx);

  assert.match(ui.notifications.at(-1)?.text ?? "", /credentials are valid/);
  // The probe renders inline HTML rather than fetching a third party's page.
  assert.deepEqual(JSON.parse(String(box.fetchCalls[0]?.init.body)), { html: "<h1>pi</h1>" });
});

test("/browser close reports that there is no session yet", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api);
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const command = box.pi.commands.get("browser");
  await command?.handler("close", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /No active browser session/);
});

// ---------------------------------------------------------------------------
// Phase 2: the stateful tool surface, driven against the browser doubles.
// ---------------------------------------------------------------------------

test("browser_open activates the interaction tools additively and reports them", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  const fake = createFakeBrowser();
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const before = [...box.pi.activeTools];
  const open = box.pi.tools.get("browser_open");
  assert.ok(open);
  const result = await open.execute(
    "call-open",
    { url: "https://example.com/jobs" },
    undefined,
    undefined,
    ctx,
  );

  const text = result.content[0]?.text ?? "";
  assert.match(text, /^Browser session open\. Tools now available: browser_navigate/);
  assert.match(text, /<untrusted-page-content source="https:\/\/example\.com\/jobs" tool="browser_open">/);
  assert.match(text, /url: https:\/\/example\.com\/jobs/);

  // Additive: nothing that was active before was removed.
  for (const name of before) assert.ok(box.pi.activeTools.includes(name), name);
  for (const name of ["browser_click", "browser_snapshot", "browser_close"]) {
    assert.ok(box.pi.activeTools.includes(name), name);
  }

  const details = result.details as { state: string; tab: { index: number; count: number } };
  assert.equal(details.state, "active");
  assert.deepEqual(details.tab, { index: 0, count: 1 });
});

test("the interaction tools drive one page and end with bounded orientation", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  const log: string[] = [];
  const page = createFakePage({
    log,
    locators: { e1: { attributes: { type: "text" } }, e2: {} },
    snapshot: '- searchbox "Query" [ref=e1]\n- button "Search" [ref=e2]',
  });
  const fake = createFakeBrowser({ page, log });
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);

  const snapshot = await box.pi.tools.get("browser_snapshot")?.execute("s", {}, undefined, undefined, ctx);
  assert.match(snapshot?.content[0]?.text ?? "", /tool="browser_snapshot"/);
  assert.match(snapshot?.content[0]?.text ?? "", /\[ref=e1\]/);

  await box.pi.tools.get("browser_fill")?.execute("f", { ref: "e1", text: "typescript" }, undefined, undefined, ctx);
  await box.pi.tools.get("browser_click")?.execute("c", { ref: "e2" }, undefined, undefined, ctx);
  await box.pi.tools.get("browser_press")?.execute("p", { key: "Escape" }, undefined, undefined, ctx);

  assert.ok(log.includes("fill:e1:typescript"));
  assert.ok(log.includes("click:e2"));
  assert.ok(log.includes("key:Escape"));

  const tabs = await box.pi.tools.get("browser_tabs")?.execute("t", { action: "list" }, undefined, undefined, ctx);
  assert.match(tabs?.content[0]?.text ?? "", /tool="browser_tabs"/);

  const closed = await box.pi.tools.get("browser_close")?.execute("x", {}, undefined, undefined, ctx);
  assert.match(closed?.content[0]?.text ?? "", /Browser session closed/);
  assert.equal((closed?.details as { state: string }).state, "idle");
  assert.ok(log.includes("context.close"));
  assert.ok(log.includes("browser.close"));
});

test("interaction tools stay listed after close and report no_session", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  const fake = createFakeBrowser();
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);
  await box.pi.tools.get("browser_close")?.execute("x", {}, undefined, undefined, ctx);

  assert.ok(box.pi.activeTools.includes("browser_click"), "the schema stays active");
  await assert.rejects(
    () => box.pi.tools.get("browser_click")!.execute("c", { ref: "e1" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "no_session" &&
      /Call browser_open first/.test(error.detail),
  );
});

test("browser_open validates the URL before connecting", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  let connects = 0;
  cloudflareBrowserRun(box.pi.api, {
    connect: async () => {
      connects += 1;
      return createFakeBrowser().browser;
    },
  });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  await assert.rejects(
    () => box.pi.tools.get("browser_open")!.execute("o", { url: "http://10.0.0.1/" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "target_rejected",
  );
  assert.equal(connects, 0, "no connection is opened for a rejected target");
});

test("session_shutdown closes an open browser exactly once", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  const fake = createFakeBrowser();
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx } = createFakeContext();

  for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
    await box.pi.emit("session_start", { reason: "startup" }, ctx);
    await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);
    const before = fake.log.filter((entry) => entry === "browser.close").length;
    await box.pi.emit("session_shutdown", { reason }, ctx);
    await box.pi.emit("session_shutdown", { reason }, ctx);
    const after = fake.log.filter((entry) => entry === "browser.close").length;
    assert.equal(after - before, 1, `reason ${reason} closes once`);
  }
});

test("/browser close closes an open session and status reports the budget", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  const fake = createFakeBrowser();
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);

  const command = box.pi.commands.get("browser");
  await command?.handler("status", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /browser {7}: active \(\d+\/200 actions, 1 tabs\)/);

  await command?.handler("close", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /Browser session closed/);
  await command?.handler("close", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /No active browser session/);
});

test("a screenshot on an unauthenticated page returns one bounded image", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  const page = createFakePage({ screenshotBytes: 2_048 });
  const fake = createFakeBrowser({ page });
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);

  const shot = await box.pi.tools.get("browser_screenshot")?.execute("sc", {}, undefined, undefined, ctx);
  assert.equal(shot?.content.length, 2);
  assert.equal(shot?.content[0]?.type, "text");
  assert.equal(shot?.content[1]?.type, "image");
  assert.match(shot?.content[0]?.text ?? "", /Screenshot captured \(2048 bytes, image\/jpeg\)/);
});

test("confirmClicks always asks the operator and honours a refusal", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  await mkdir(statePaths(box.agentDir).root, { recursive: true });
  await writeFile(
    statePaths(box.agentDir).configFile,
    JSON.stringify({ browser: { confirmClicks: "always" } }),
    "utf8",
  );

  const page = createFakePage({ locators: { e1: {} } });
  const fake = createFakeBrowser({ page });
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser });
  const { ctx } = createFakeContext({ confirm: false });
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);

  await assert.rejects(
    () => box.pi.tools.get("browser_click")!.execute("c", { ref: "e1" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof BrowserRunError && /declined this click/.test(error.detail),
  );
});
