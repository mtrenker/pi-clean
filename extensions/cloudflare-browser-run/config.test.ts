/**
 * Configuration tests - DESIGN.md acceptance criterion AC-C6 and section 6.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  KEEP_ALIVE_MAX_MS,
  loadConfig,
  parseConfig,
  statePaths,
} from "./config.ts";
import { BrowserRunError } from "./errors.ts";

function detailOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BrowserRunError);
    assert.equal(error.errorClass, "invalid_request");
    return error.detail;
  }
  return assert.fail("expected a validation failure");
}

test("an empty document yields the documented defaults", () => {
  const config = parseConfig({});
  assert.deepEqual(config.crawl.crawlPurposes, ["ai-input"]);
  assert.equal(config.crawl.defaultLimit, 25);
  assert.equal(config.crawl.defaultDepth, 2);
  assert.equal(config.crawl.allowRenderedCrawl, false);
  assert.equal(config.browser.screenshotsWithProfile, "ask");
  assert.equal(config.browser.confirmClicks, "never");
  assert.equal(config.credentials.source, "env");
  assert.deepEqual(config.profiles, {});
});

test("AC-C6 unknown keys are rejected by name at every level", () => {
  assert.match(detailOf(() => parseConfig({ browsers: {} })), /config browsers: unknown key/);
  assert.match(
    detailOf(() => parseConfig({ browser: { keepAlive: 1000 } })),
    /config browser\.keepAlive: unknown key/,
  );
  assert.match(
    detailOf(() => parseConfig({ crawl: { purposes: ["search"] } })),
    /config crawl\.purposes: unknown key/,
  );
  assert.match(
    detailOf(() => parseConfig({ profiles: { site: { origins: [], extra: 1 } } })),
    /config profiles\.site\.extra: unknown key/,
  );
});

test("AC-C6 ai-train is rejected with the reason stated", () => {
  const detail = detailOf(() => parseConfig({ crawl: { crawlPurposes: ["search", "ai-train"] } }));
  assert.match(detail, /ai-train is not supported/);
  assert.match(detail, /no training pipeline/);
});

test("AC-C6 keepAliveMs is capped at Cloudflare's documented maximum", () => {
  assert.match(
    detailOf(() => parseConfig({ browser: { keepAliveMs: KEEP_ALIVE_MAX_MS + 1 } })),
    /browser\.keepAliveMs: must be between 10000 and 600000/,
  );
  assert.equal(
    parseConfig({ browser: { keepAliveMs: KEEP_ALIVE_MAX_MS } }).browser.keepAliveMs,
    KEEP_ALIVE_MAX_MS,
  );
});

test("crawl purposes accept the two honest values and deduplicate", () => {
  const config = parseConfig({ crawl: { crawlPurposes: ["search", "ai-input", "search"] } });
  assert.deepEqual(config.crawl.crawlPurposes, ["search", "ai-input"]);
  assert.match(
    detailOf(() => parseConfig({ crawl: { crawlPurposes: ["indexing"] } })),
    /must be one of search, ai-input/,
  );
  assert.match(detailOf(() => parseConfig({ crawl: { crawlPurposes: [] } })), /at least one purpose/);
});

test("crawl limits stay inside their ceilings and defaultLimit cannot exceed maxLimit", () => {
  assert.match(
    detailOf(() => parseConfig({ crawl: { defaultLimit: 900, maxLimit: 500 } })),
    /defaultLimit: must not exceed crawl\.maxLimit/,
  );
  assert.match(
    detailOf(() => parseConfig({ crawl: { defaultDepth: 9 } })),
    /defaultDepth: must be between 0 and 5/,
  );
  assert.match(
    detailOf(() => parseConfig({ crawl: { resultCacheDays: 30 } })),
    /resultCacheDays: must be between 1 and 14/,
  );
});

test("profile origins must be exact origins", () => {
  const config = parseConfig({
    profiles: { "example-site": { origins: ["https://www.example.com", "https://www.example.com"] } },
  });
  assert.deepEqual(config.profiles["example-site"]?.origins, ["https://www.example.com"]);
  assert.equal(config.profiles["example-site"]?.allowNavigationOutsideProfile, false);

  assert.match(
    detailOf(() => parseConfig({ profiles: { a: { origins: ["https://www.example.com/jobs"] } } })),
    /must be an exact origin such as https:\/\/www\.example\.com/,
  );
  assert.match(
    detailOf(() => parseConfig({ profiles: { a: { origins: ["https://www.example.com/"] } } })),
    /must be an exact origin/,
  );
  assert.match(
    detailOf(() => parseConfig({ profiles: { a: { origins: ["ftp://example.com"] } } })),
    /must use http or https/,
  );
  assert.match(
    detailOf(() => parseConfig({ profiles: { a: { origins: ["https://u:p@example.com"] } } })),
    /must not carry credentials/,
  );
  assert.match(detailOf(() => parseConfig({ profiles: { a: { origins: [] } } })), /at least one origin/);
  assert.match(
    detailOf(() => parseConfig({ profiles: { "bad name": { origins: ["https://a.example"] } } })),
    /name must be 1-64 characters/,
  );
});

test("the proton-pass locator requires every field name and holds no secret", () => {
  const config = parseConfig({
    credentials: {
      source: "proton-pass",
      vault: "hub",
      item: "cloudflare",
      accountIdField: "Account ID",
      tokenField: "browser-run token",
    },
  });
  assert.equal(config.credentials.vault, "hub");
  assert.match(
    detailOf(() => parseConfig({ credentials: { source: "proton-pass", vault: "hub" } })),
    /credentials\.item: is required/,
  );
  assert.match(
    detailOf(() => parseConfig({ credentials: { source: "command", argv: ["secret-get"] } })),
    /must contain a \{field\} placeholder/,
  );
});

test("state paths derive from the agent directory and never from the repository", () => {
  const paths = statePaths("/tmp/agent-dir");
  assert.equal(paths.root, "/tmp/agent-dir/cloudflare-browser-run");
  assert.equal(paths.configFile, "/tmp/agent-dir/cloudflare-browser-run/config.json");
  assert.equal(paths.profilesDir, "/tmp/agent-dir/cloudflare-browser-run/profiles");
  assert.equal(paths.crawlsDir, "/tmp/agent-dir/cloudflare-browser-run/crawls");
  assert.equal(paths.logFile, "/tmp/agent-dir/cloudflare-browser-run/activity.jsonl");
});

test("a missing config file yields the defaults", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-config-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadConfig(statePaths(dir)), DEFAULT_CONFIG);
});

test("a malformed config file reports the path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-config-bad-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const paths = statePaths(dir);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.configFile, "{ not json", "utf8");
  await assert.rejects(
    () => loadConfig(paths),
    (error: unknown) =>
      error instanceof BrowserRunError && /config is not valid JSON/.test(error.detail),
  );
});
