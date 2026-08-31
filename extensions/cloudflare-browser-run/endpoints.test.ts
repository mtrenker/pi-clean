/**
 * Endpoint construction tests - DESIGN.md section 3.
 *
 * Cloudflare's naming currently mixes /browser-rendering and /browser-run. These
 * tests pin the shape so a future correction is one change in one module.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cdpSessionUrl,
  cdpWebSocketUrl,
  crawlUrl,
  quickActionUrl,
  SERVICE_SEGMENT,
} from "./endpoints.ts";
import { BrowserRunError } from "./errors.ts";
import { FIXTURE_ACCOUNT_ID } from "./test-support.ts";

const BASE = `https://api.cloudflare.com/client/v4/accounts/${FIXTURE_ACCOUNT_ID}/${SERVICE_SEGMENT}`;

test("quick action URLs follow the documented REST shape", () => {
  assert.equal(quickActionUrl(FIXTURE_ACCOUNT_ID, "markdown"), `${BASE}/markdown`);
  assert.equal(quickActionUrl(FIXTURE_ACCOUNT_ID, "content"), `${BASE}/content`);
  assert.throws(
    () => quickActionUrl(FIXTURE_ACCOUNT_ID, "nonsense" as "markdown"),
    (error: unknown) => error instanceof BrowserRunError && /unknown quick action/.test(error.detail),
  );
});

test("crawl URLs cover start, status, and cancel", () => {
  assert.equal(crawlUrl(FIXTURE_ACCOUNT_ID), `${BASE}/crawl`);
  assert.equal(crawlUrl(FIXTURE_ACCOUNT_ID, "job-123"), `${BASE}/crawl/job-123`);
  assert.throws(() => crawlUrl(FIXTURE_ACCOUNT_ID, "../../evil"), /not well formed/);
  assert.throws(() => crawlUrl(FIXTURE_ACCOUNT_ID, ""), /not well formed/);
});

test("the CDP endpoint is a websocket URL carrying keep_alive", () => {
  const url = cdpWebSocketUrl(FIXTURE_ACCOUNT_ID, 600_000);
  assert.equal(url, `${BASE.replace("https:", "wss:")}/devtools/browser?keep_alive=600000`);
  assert.match(cdpWebSocketUrl(FIXTURE_ACCOUNT_ID, 1234.9), /keep_alive=1234$/);
  assert.equal(cdpSessionUrl(FIXTURE_ACCOUNT_ID, "abc"), `${BASE}/devtools/browser/abc`);
  assert.throws(() => cdpSessionUrl(FIXTURE_ACCOUNT_ID, "a/b"), /not well formed/);
});

test("a malformed account id is rejected before any request is built", () => {
  for (const bad of ["", "short", "has/slash", "has space", "x".repeat(65)]) {
    assert.throws(
      () => quickActionUrl(bad, "markdown"),
      (error: unknown) =>
        error instanceof BrowserRunError && error.errorClass === "credentials_rejected",
      `account id ${JSON.stringify(bad)}`,
    );
  }
});
