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
import { ensureStateDir, statePaths } from "./config.ts";
import { ProfileStore } from "./profiles.ts";
import { createEnvBackend, ProfileVault, PROFILE_KEY_ENV } from "./vault.ts";
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

/** Tests never touch real DNS; every hostname resolves to one public address. */
const publicLookup = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: "93.184.216.34", family: 4 },
];

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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });

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
      "browser_crawl_start",
      "browser_crawl_status",
      "browser_crawl_results",
      "browser_crawl_cancel",
    ],
  );
  assert.deepEqual(
    [...box.pi.commands.keys()],
    ["browser", "browser-crawls", "browser-login", "browser-profiles"],
  );
  assert.ok(box.pi.handlers.has("session_start"));
  assert.ok(box.pi.handlers.has("session_shutdown"));
  assert.equal(box.pi.execCalls.length, 0, "no process is spawned at factory time");
  assert.equal(box.fetchCalls.length, 0, "no network call is made at factory time");
});

test("session_start leaves the interaction tools inactive on a fresh branch", async (t) => {
  const box = await sandbox(t);
  box.pi.activeTools = ["read", "bash", "browser_click"];
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext();

  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  assert.deepEqual(box.pi.activeTools, ["read", "bash"]);
});

test("a resumed branch that used the interaction tools keeps their schemas active", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
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
    lookup: publicLookup,
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
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
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
  const { ctx } = createFakeContext({ confirm: false });
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")?.execute("o", {}, undefined, undefined, ctx);

  await assert.rejects(
    () => box.pi.tools.get("browser_click")!.execute("c", { ref: "e1" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof BrowserRunError && /declined this click/.test(error.detail),
  );
});

// ---------------------------------------------------------------------------
// Phase 3: named authenticated profiles.
// ---------------------------------------------------------------------------

const PROFILE_MASTER_KEY = Buffer.alloc(48, 11).toString("base64");

async function writeConfig(agentDir: string, document: unknown): Promise<void> {
  const paths = statePaths(agentDir);
  await ensureStateDir(paths);
  await writeFile(paths.configFile, JSON.stringify(document), "utf8");
}

async function seedProfile(agentDir: string, name: string, origins: string[]): Promise<void> {
  const paths = statePaths(agentDir);
  await ensureStateDir(paths);
  const vault = new ProfileVault(paths, {
    backend: createEnvBackend({ [PROFILE_KEY_ENV]: PROFILE_MASTER_KEY }),
    canMintKeys: false,
  });
  const store = new ProfileStore(paths, vault);
  const host = new URL(origins[0] as string).hostname;
  await store.save(
    name,
    { origins, allowNavigationOutsideProfile: false },
    {
      cookies: [
        {
          name: "sid",
          value: "seeded-session-value",
          domain: host,
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 86_400,
        },
      ],
      origins: [{ origin: origins[0] as string, localStorage: [{ name: "t", value: "v" }] }],
    },
  );
}

test("browser_open fails closed on an undeclared or unsaved profile", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  process.env[PROFILE_KEY_ENV] = PROFILE_MASTER_KEY;
  t.after(() => {
    delete process.env[PROFILE_KEY_ENV];
  });
  await writeConfig(box.agentDir, {
    profileVault: { backend: "env" },
    profiles: { "example-site": { origins: ["https://www.example.com"] } },
  });

  let connects = 0;
  cloudflareBrowserRun(box.pi.api, {
    lookup: publicLookup,
    connect: async () => {
      connects += 1;
      return createFakeBrowser().browser;
    },
  });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  const open = box.pi.tools.get("browser_open");
  assert.ok(open);

  await assert.rejects(
    () => open.execute("o1", { profile: "not-declared" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_missing" &&
      /is not defined/.test(error.detail),
  );

  await assert.rejects(
    () => open.execute("o2", { profile: "example-site" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_missing" &&
      /\/browser-login example-site/.test(error.detail),
  );

  assert.equal(connects, 0, "no browser is opened when the profile cannot be restored");
});

test("a saved profile is restored into an isolated context and confines navigation", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  process.env[PROFILE_KEY_ENV] = PROFILE_MASTER_KEY;
  t.after(() => {
    delete process.env[PROFILE_KEY_ENV];
  });
  await writeConfig(box.agentDir, {
    profileVault: { backend: "env" },
    profiles: { "example-site": { origins: ["https://www.example.com"] } },
  });
  await seedProfile(box.agentDir, "example-site", ["https://www.example.com"]);

  const contexts: Array<Record<string, unknown>> = [];
  const base = createFakeBrowser({ page: createFakePage({ url: "https://www.example.com/" }) });
  const browser = {
    ...base.browser,
    async newContext(options?: Record<string, unknown>) {
      contexts.push(options ?? {});
      return base.context;
    },
  };
  cloudflareBrowserRun(box.pi.api, { connect: async () => browser, lookup: publicLookup });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  const result = await box.pi.tools
    .get("browser_open")!
    .execute("o", { profile: "example-site" }, undefined, undefined, ctx);

  assert.match(result.content[0]?.text ?? "", /Profile example-site restored/);
  assert.equal((result.details as { profile: string }).profile, "example-site");

  // The restored state reached the isolated context, and only the allowlisted parts.
  const storageState = contexts[0]?.["storageState"] as { cookies: Array<{ domain: string }> };
  assert.equal(storageState.cookies.length, 1);
  assert.equal(storageState.cookies[0]?.domain, "www.example.com");

  // The profile's origins confine navigation by default.
  await assert.rejects(
    () =>
      box.pi.tools
        .get("browser_navigate")!
        .execute("n", { url: "https://tracker.example.net/" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError && error.errorClass === "target_rejected",
  );

  // No secret from the profile reaches a model-visible or durable surface.
  const surfaces = [...collectStrings(result.content), ...collectStrings(result.details)];
  for (const surface of surfaces) {
    assert.ok(!surface.includes("seeded-session-value"), "a cookie value leaked");
  }
});

test("a screenshot on an authenticated page needs a deliberate yes", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  process.env[PROFILE_KEY_ENV] = PROFILE_MASTER_KEY;
  t.after(() => {
    delete process.env[PROFILE_KEY_ENV];
  });
  await writeConfig(box.agentDir, {
    profileVault: { backend: "env" },
    profiles: { "example-site": { origins: ["https://www.example.com"] } },
  });
  await seedProfile(box.agentDir, "example-site", ["https://www.example.com"]);

  const fake = createFakeBrowser({ page: createFakePage({ url: "https://www.example.com/" }) });
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
  const { ctx } = createFakeContext({ confirm: false });
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")!.execute("o", { profile: "example-site" }, undefined, undefined, ctx);

  await assert.rejects(
    () => box.pi.tools.get("browser_screenshot")!.execute("s", {}, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError && /declined this screenshot/.test(error.detail),
  );

  const allowed = createFakeContext({ confirm: true });
  const shot = await box.pi.tools
    .get("browser_screenshot")!
    .execute("s2", {}, undefined, undefined, allowed.ctx);
  assert.equal(shot.content[1]?.type, "image");
});

test("a screenshot with a profile is refused outright when there is no operator to ask", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  process.env[PROFILE_KEY_ENV] = PROFILE_MASTER_KEY;
  t.after(() => {
    delete process.env[PROFILE_KEY_ENV];
  });
  await writeConfig(box.agentDir, {
    profileVault: { backend: "env" },
    profiles: { "example-site": { origins: ["https://www.example.com"] } },
  });
  await seedProfile(box.agentDir, "example-site", ["https://www.example.com"]);

  const fake = createFakeBrowser({ page: createFakePage({ url: "https://www.example.com/" }) });
  cloudflareBrowserRun(box.pi.api, { connect: async () => fake.browser, lookup: publicLookup });
  const { ctx } = createFakeContext({ hasUI: false });
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  await box.pi.tools.get("browser_open")!.execute("o", { profile: "example-site" }, undefined, undefined, ctx);

  await assert.rejects(
    () => box.pi.tools.get("browser_screenshot")!.execute("s", {}, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError && /need operator confirmation/.test(error.detail),
  );
});

test("/browser-login refuses to run without an interactive host", async (t) => {
  const box = await sandbox(t);
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx, ui } = createFakeContext({ hasUI: false });
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  await box.pi.commands.get("browser-login")?.handler("example-site", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /needs an interactive host/);

  await box.pi.commands.get("browser-login")?.handler("", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /Usage: \/browser-login/);
});

test("/browser-profiles lists, inspects, and deletes without printing secrets", async (t) => {
  const box = await sandbox(t);
  process.env[PROFILE_KEY_ENV] = PROFILE_MASTER_KEY;
  t.after(() => {
    delete process.env[PROFILE_KEY_ENV];
  });
  await writeConfig(box.agentDir, {
    profileVault: { backend: "env" },
    profiles: { "example-site": { origins: ["https://www.example.com"] } },
  });

  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  const command = box.pi.commands.get("browser-profiles");
  assert.ok(command);

  await command.handler("list", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /No saved profiles/);

  await seedProfile(box.agentDir, "example-site", ["https://www.example.com"]);

  await command.handler("list", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /example-site\s+saved\s+https:\/\/www\.example\.com/);

  await command.handler("status example-site", ctx);
  const status = ui.notifications.at(-1)?.text ?? "";
  assert.match(status, /cookies {8}: 1 kept/);
  assert.match(status, /key backend {4}: env/);
  assert.ok(!status.includes("seeded-session-value"));

  // The env backend derives keys from one master key, so it says plainly that a
  // single profile's key cannot be destroyed.
  await command.handler("delete example-site", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /Rotate the variable/);
});

// ---------------------------------------------------------------------------
// Phase 4: asynchronous crawls.
// ---------------------------------------------------------------------------

test("browser_crawl_start registers a durable job and activates the follow-up tools", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  assert.ok(!box.pi.activeTools.includes("browser_crawl_status"), "inactive until a job exists");

  box.setResponse({ body: { success: true, result: { jobId: "job-abc" } } });
  const result = await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c", { url: "https://docs.example.com/" }, undefined, undefined, ctx);

  const text = result.content[0]?.text ?? "";
  assert.match(text, /Crawl job-abc started on https:\/\/docs\.example\.com/);
  assert.match(text, /pages {7}: up to 25/);
  assert.match(text, /render {6}: no/);
  assert.match(text, /purposes {4}: ai-input/);
  assert.match(text, /same site, no external links, no subdomains/);
  assert.match(text, /survives this Pi session/);
  assert.match(text, /Tools now available: browser_crawl_status/);

  for (const name of ["browser_crawl_status", "browser_crawl_results", "browser_crawl_cancel"]) {
    assert.ok(box.pi.activeTools.includes(name), name);
  }

  const body = JSON.parse(String(box.fetchCalls.at(-1)?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body["formats"], ["markdown"]);
  assert.equal(body["render"], false);
  assert.deepEqual(body["crawlPurposes"], ["ai-input"]);
  assert.deepEqual(body["options"], { includeExternalLinks: false, includeSubdomains: false });
});

test("a job in the durable registry activates the follow-up tools in a later session", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext({ cwd: "/repo/here" });
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  box.setResponse({ body: { success: true, result: { jobId: "job-later" } } });
  await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c", { url: "https://docs.example.com/" }, undefined, undefined, ctx);

  // A brand new extension instance, as a later Pi process would build.
  const second = createFakePi();
  cloudflareBrowserRun(second.api, { lookup: publicLookup });
  await second.emit("session_start", { reason: "startup" }, ctx);
  assert.ok(second.activeTools.includes("browser_crawl_status"));

  const listed = await second.commands.get("browser-crawls")?.handler("list", ctx);
  void listed;
});

test("the daily crawl cap is enforced before any request", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  await writeConfig(box.agentDir, { crawl: { maxJobsPerDay: 1 } });
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  box.setResponse({ body: { success: true, result: { jobId: "job-1" } } });
  await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c1", { url: "https://docs.example.com/" }, undefined, undefined, ctx);
  const callsAfterFirst = box.fetchCalls.length;

  await assert.rejects(
    () =>
      box.pi.tools
        .get("browser_crawl_start")!
        .execute("c2", { url: "https://docs.example.com/" }, undefined, undefined, ctx),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "quota_exhausted" &&
      /configured maximum of 1/.test(error.detail),
  );
  assert.equal(box.fetchCalls.length, callsAfterFirst, "the cap costs nothing to enforce");
});

test("crawl results page, cache, and mark the text untrusted", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  box.setResponse({ body: { success: true, result: { jobId: "job-page" } } });
  await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c", { url: "https://docs.example.com/" }, undefined, undefined, ctx);

  box.setResponse({
    body: {
      success: true,
      result: {
        status: "completed",
        browserSecondsUsed: 4,
        cursor: "cursor-2",
        total: 12,
        results: [
          {
            url: "https://docs.example.com/a",
            status: "completed",
            markdown: `# A\n${"detail ".repeat(300)}`,
            metadata: { status: 200, title: "Page A" },
          },
          { url: "https://docs.example.com/blocked", status: "disallowed" },
        ],
      },
    },
  });

  const first = await box.pi.tools
    .get("browser_crawl_results")!
    .execute("r", { job_id: "job-page" }, undefined, undefined, ctx);
  const text = first.content[0]?.text ?? "";
  assert.match(text, /Crawl job-page \(completed\)/);
  assert.match(text, /next cursor: cursor-2/);
  assert.match(text, /<untrusted-page-content source="https:\/\/docs\.example\.com\/" tool="browser_crawl_results">/);
  assert.match(text, /https:\/\/docs\.example\.com\/blocked \[disallowed\]/);
  assert.equal((first.details as { fromCache: boolean }).fromCache, false);

  const before = box.fetchCalls.length;
  const second = await box.pi.tools
    .get("browser_crawl_results")!
    .execute("r2", { job_id: "job-page" }, undefined, undefined, ctx);
  assert.equal(box.fetchCalls.length, before, "a cached page costs no request");
  assert.equal((second.details as { fromCache: boolean }).fromCache, true);
  assert.match(second.content[0]?.text ?? "", /served from the local cache/);

  // A URL filter narrows the current page without another request.
  const filtered = await box.pi.tools
    .get("browser_crawl_results")!
    .execute("r3", { job_id: "job-page", url: "blocked" }, undefined, undefined, ctx);
  assert.match(filtered.content[0]?.text ?? "", /records on this page: 1 \(filtered from 2\)/);
});

test("crawl status and cancel update the durable record", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);

  box.setResponse({ body: { success: true, result: { jobId: "job-x" } } });
  await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c", { url: "https://docs.example.com/" }, undefined, undefined, ctx);

  box.setResponse({
    body: { success: true, result: { status: "running", browserSecondsUsed: 2, total: 3 } },
  });
  const status = await box.pi.tools
    .get("browser_crawl_status")!
    .execute("s", { job_id: "job-x" }, undefined, undefined, ctx);
  assert.match(status.content[0]?.text ?? "", /status {6}: running/);
  assert.equal((status.details as { pagesSeen: number }).pagesSeen, 3);

  box.setResponse({ body: { success: true, result: {} } });
  const cancelled = await box.pi.tools
    .get("browser_crawl_cancel")!
    .execute("x", { job_id: "job-x" }, undefined, undefined, ctx);
  assert.match(cancelled.content[0]?.text ?? "", /not refunded/);
  assert.equal((cancelled.details as { status: string }).status, "cancelled_by_user");

  // Cancelling a finished job is reported rather than repeated upstream.
  const before = box.fetchCalls.length;
  const again = await box.pi.tools
    .get("browser_crawl_cancel")!
    .execute("x2", { job_id: "job-x" }, undefined, undefined, ctx);
  assert.match(again.content[0]?.text ?? "", /already finished as cancelled_by_user/);
  assert.equal(box.fetchCalls.length, before);
});

test("an unknown job id is reported without contacting Cloudflare", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  box.setResponse({ body: { success: true, result: { jobId: "job-known" } } });
  await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c", { url: "https://docs.example.com/" }, undefined, undefined, ctx);

  const before = box.fetchCalls.length;
  await assert.rejects(
    () =>
      box.pi.tools
        .get("browser_crawl_status")!
        .execute("s", { job_id: "job-unknown" }, undefined, undefined, ctx),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "job_not_found",
  );
  assert.equal(box.fetchCalls.length, before);
});

test("/browser-crawls lists, shows, and forgets durable jobs", async (t) => {
  const box = await sandbox(t);
  configureEnvCredentials();
  cloudflareBrowserRun(box.pi.api, { lookup: publicLookup });
  const { ctx, ui } = createFakeContext();
  await box.pi.emit("session_start", { reason: "startup" }, ctx);
  const command = box.pi.commands.get("browser-crawls");
  assert.ok(command);

  await command.handler("list", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /No crawls in the registry/);

  box.setResponse({ body: { success: true, result: { jobId: "job-cmd" } } });
  await box.pi.tools
    .get("browser_crawl_start")!
    .execute("c", { url: "https://docs.example.com/" }, undefined, undefined, ctx);

  await command.handler("list", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /job-cmd\s+queued/);

  await command.handler("show job-cmd", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /status {6}: queued \(local\)/);

  await command.handler("forget job-cmd", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /removed from the local registry/);
  await command.handler("list", ctx);
  assert.match(ui.notifications.at(-1)?.text ?? "", /No crawls in the registry/);
});
