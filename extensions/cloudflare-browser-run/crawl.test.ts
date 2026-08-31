/**
 * Crawl policy tests - DESIGN.md acceptance criteria AC-R7, AC-R8, AC-R9.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CRAWL_DEPTH_CEILING, parseConfig } from "./config.ts";
import {
  buildCrawlBody,
  parseCrawlRead,
  refineCrawlError,
  startCrawl,
  readCrawl,
  cancelCrawl,
} from "./crawl.ts";
import { Secret } from "./credentials.ts";
import { BrowserRunError } from "./errors.ts";
import { CloudflareClient, type HttpDeps } from "./http.ts";
import { FIXTURE_ACCOUNT_ID, FIXTURE_TOKEN, scriptedFetch, type ScriptedResponse } from "./test-support.ts";

const SETTINGS = parseConfig({}).crawl;

const credentials = {
  accountId: new Secret(FIXTURE_ACCOUNT_ID),
  token: new Secret(FIXTURE_TOKEN),
};

function client(responses: ScriptedResponse[]): {
  client: CloudflareClient;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const scripted = scriptedFetch(responses);
  const deps: HttpDeps = {
    fetch: scripted.fetch,
    now: () => 0,
    sleep: async () => undefined,
  };
  return { client: new CloudflareClient(deps, { requestsPerSecond: 1000 }), calls: scripted.calls };
}

test("AC-R7 the default body is bounded, same site, and honestly scoped", () => {
  const { body, clamps } = buildCrawlBody({ url: "https://docs.example.com/" }, SETTINGS);
  assert.deepEqual(body, {
    url: "https://docs.example.com/",
    formats: ["markdown"],
    limit: 25,
    depth: 2,
    render: false,
    maxAge: 86_400,
    crawlPurposes: ["ai-input"],
    options: { includeExternalLinks: false, includeSubdomains: false },
  });
  assert.deepEqual(clamps, []);
});

test("AC-R8 an over-large request is clamped and the clamp is reported", () => {
  const { body, clamps } = buildCrawlBody(
    { url: "https://docs.example.com/", limit: 5_000, depth: 9 },
    SETTINGS,
  );
  assert.equal(body["limit"], 500);
  assert.equal(body["depth"], CRAWL_DEPTH_CEILING);
  assert.deepEqual(clamps, ["limit 5000 clamped to 500", "depth 9 clamped to 5"]);
});

test("defaultDepth is the default, not the cap", () => {
  // A caller may go deeper than the configured default, up to the extension's
  // own ceiling. Clamping to the default would make the setting a maximum, which
  // is not what DESIGN.md section 16.2 specifies.
  const deeper = buildCrawlBody({ url: "https://docs.example.com/", depth: 4 }, SETTINGS);
  assert.equal(deeper.body["depth"], 4);
  assert.deepEqual(deeper.clamps, []);

  const negative = buildCrawlBody({ url: "https://docs.example.com/", depth: -3 }, SETTINGS);
  assert.equal(negative.body["depth"], 0);
});

test("rendering is refused unless the operator enabled it, and reported when refused", () => {
  const refused = buildCrawlBody({ url: "https://docs.example.com/", render: true }, SETTINGS);
  assert.equal(refused.body["render"], false);
  assert.match(refused.clamps[0] ?? "", /render was refused: rendered crawls are metered/);

  const allowed = buildCrawlBody(
    { url: "https://docs.example.com/", render: true },
    { ...SETTINGS, allowRenderedCrawl: true },
  );
  assert.equal(allowed.body["render"], true);
  assert.deepEqual(allowed.clamps, []);
});

test("declared purposes come from configuration, never from the caller", () => {
  const configured = parseConfig({ crawl: { crawlPurposes: ["search", "ai-input"] } }).crawl;
  const { body } = buildCrawlBody({ url: "https://docs.example.com/" }, configured);
  assert.deepEqual(body["crawlPurposes"], ["search", "ai-input"]);

  // There is no parameter for purposes, so an attempt to pass one is ignored.
  const sneaky = buildCrawlBody(
    { url: "https://docs.example.com/", ...({ crawlPurposes: ["ai-train"] } as object) },
    SETTINGS,
  );
  assert.deepEqual(sneaky.body["crawlPurposes"], ["ai-input"]);
});

test("include and exclude patterns must be wildcards, not regular expressions", () => {
  const ok = buildCrawlBody(
    {
      url: "https://docs.example.com/",
      includePatterns: ["https://docs.example.com/guide/**"],
      excludePatterns: ["https://docs.example.com/legacy/*"],
    },
    SETTINGS,
  );
  assert.deepEqual((ok.body["options"] as Record<string, unknown>)["includePatterns"], [
    "https://docs.example.com/guide/**",
  ]);

  assert.throws(
    () => buildCrawlBody({ url: "https://d.example/", includePatterns: ["^https?://(a|b)$"] }, SETTINGS),
    (error: unknown) =>
      error instanceof BrowserRunError && /is not a URL wildcard pattern/.test(error.detail),
  );
});

test("a crawl read is parsed tolerantly across plausible envelopes", () => {
  const parsed = parseCrawlRead({
    status: "running",
    browserSecondsUsed: 12.5,
    cursor: "abc",
    total: 40,
    results: [
      {
        url: "https://docs.example.com/a",
        status: "completed",
        markdown: "# A",
        metadata: { status: 200, title: "A", url: "https://docs.example.com/a" },
      },
      { url: "https://docs.example.com/b", status: "disallowed" },
    ],
  });
  assert.equal(parsed.status, "running");
  assert.equal(parsed.browserSecondsUsed, 12.5);
  assert.equal(parsed.cursor, "abc");
  assert.equal(parsed.total, 40);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0]?.markdown, "# A");
  assert.equal(parsed.records[1]?.status, "disallowed");

  // Alternative container keys and a missing envelope are both handled.
  assert.equal(parseCrawlRead({ records: [{ url: "u", status: "completed" }] }).records.length, 1);
  assert.deepEqual(parseCrawlRead(undefined).records, []);
  assert.equal(parseCrawlRead({}).cursor, null);
});

test("starting a crawl posts the body and returns the job id", async () => {
  const { client: cf, calls } = client([{ body: { success: true, result: { jobId: "job-1" } } }]);
  const jobId = await startCrawl(cf, credentials, buildCrawlBody({ url: "https://d.example/" }, SETTINGS).body);
  assert.equal(jobId, "job-1");
  assert.match(calls[0]?.url ?? "", /\/browser-rendering\/crawl$/);
  assert.equal(calls[0]?.init.method, "POST");

  const bare = client([{ body: { success: true, result: "job-2" } }]);
  assert.equal(await startCrawl(bare.client, credentials, {}), "job-2");

  const empty = client([{ body: { success: true, result: {} } }]);
  await assert.rejects(
    () => startCrawl(empty.client, credentials, {}),
    (error: unknown) => error instanceof BrowserRunError && /returned no job id/.test(error.detail),
  );
});

test("AC-R9 a Content Signals refusal is its own class and is never retried", async () => {
  const { client: cf, calls } = client([
    {
      status: 400,
      body: {
        success: false,
        errors: [{ message: "Content-Signal ai-train=no disallows the declared crawlPurposes" }],
      },
    },
  ]);
  await assert.rejects(
    () => startCrawl(cf, credentials, { crawlPurposes: ["search", "ai-input"] }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "content_signals_declined" &&
      /not retried with a narrower purpose/.test(error.detail) &&
      /purpose search, ai-input/.test(error.detail),
  );
  assert.equal(calls.length, 1, "a refusal is not retried");
});

test("an ordinary 400 stays an invalid_request", () => {
  const plain = new BrowserRunError("invalid_request", "Cloudflare returned 400: bad url");
  assert.equal(refineCrawlError(plain, ["ai-input"]), plain);
  const unrelated = new BrowserRunError("upstream_error", "content signal mention but wrong class");
  assert.equal(refineCrawlError(unrelated, ["ai-input"]), unrelated);
});

test("reading a crawl passes cursor, limit, and status through as query parameters", async () => {
  const { client: cf, calls } = client([{ body: { success: true, result: { status: "completed" } } }]);
  await readCrawl(cf, credentials, "job-1", { cursor: "abc", limit: 5, status: "completed" });
  const url = new URL(calls[0]?.url ?? "https://x/");
  assert.equal(url.pathname.endsWith("/crawl/job-1"), true);
  assert.equal(url.searchParams.get("cursor"), "abc");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("status"), "completed");

  const bare = client([{ body: { success: true, result: {} } }]);
  await readCrawl(bare.client, credentials, "job-1");
  assert.ok(!bare.calls[0]?.url.includes("?"), "no query string when nothing is filtered");
});

test("cancelling issues a DELETE against the job", async () => {
  const { client: cf, calls } = client([{ body: { success: true, result: {} } }]);
  await cancelCrawl(cf, credentials, "job-1");
  assert.equal(calls[0]?.init.method, "DELETE");
  assert.match(calls[0]?.url ?? "", /\/crawl\/job-1$/);
});
