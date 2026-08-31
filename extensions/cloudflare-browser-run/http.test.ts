/**
 * Transport tests - DESIGN.md acceptance criteria AC-E1 and AC-E2, section 10.3.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Secret } from "./credentials.ts";
import { BrowserRunError } from "./errors.ts";
import { CloudflareClient, summarizeErrorBody, type HttpDeps } from "./http.ts";
import { SecretRegistry } from "./redact.ts";
import { FIXTURE_TOKEN, scriptedFetch, type ScriptedResponse } from "./test-support.ts";

interface Harness {
  client: CloudflareClient;
  calls: Array<{ url: string; init: RequestInit }>;
  sleeps: number[];
  clock: { value: number };
}

function harness(responses: ScriptedResponse[], options: { requestsPerSecond?: number } = {}): Harness {
  const scripted = scriptedFetch(responses);
  const sleeps: number[] = [];
  const clock = { value: 0 };
  const deps: HttpDeps = {
    fetch: scripted.fetch,
    now: () => clock.value,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.value += ms;
    },
    registry: new SecretRegistry(),
  };
  return {
    client: new CloudflareClient(deps, { requestsPerSecond: options.requestsPerSecond ?? 1000 }),
    calls: scripted.calls,
    sleeps,
    clock,
  };
}

const token = new Secret(FIXTURE_TOKEN);

test("a successful envelope is unwrapped and browser milliseconds are captured", async () => {
  const { client, calls } = harness([
    {
      body: { success: true, result: "# heading" },
      headers: { "x-browser-ms-used": "1234" },
    },
  ]);
  const response = await client.request<string>({
    method: "POST",
    url: "https://api.cloudflare.com/x",
    token,
    body: { url: "https://example.com" },
  });
  assert.equal(response.result, "# heading");
  assert.equal(response.browserMs, 1234);
  assert.equal(client.lastBrowserMs, 1234);

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], `Bearer ${FIXTURE_TOKEN}`);
  assert.equal(headers["content-type"], "application/json");
});

test("AC-E1 429 retries at most twice and honors Retry-After", async () => {
  const { client, sleeps } = harness([
    { status: 429, headers: { "retry-after": "2" }, bodyText: "slow down" },
    { status: 429, headers: { "retry-after": "3" }, bodyText: "slow down" },
    { status: 429, headers: { "retry-after": "4" }, bodyText: "slow down" },
  ]);
  await assert.rejects(
    () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "rate_limited" &&
      /after 2 retries/.test(error.detail),
  );
  assert.deepEqual(sleeps, [2000, 3000]);
});

test("AC-E1 a 429 that clears on retry succeeds", async () => {
  const { client, calls } = harness([
    { status: 429, headers: { "retry-after": "1" } },
    { body: { success: true, result: "ok" } },
  ]);
  const response = await client.request<string>({
    method: "GET",
    url: "https://api.cloudflare.com/x",
    token,
  });
  assert.equal(response.result, "ok");
  assert.equal(calls.length, 2);
});

test("AC-E2 5xx retries twice then reports upstream_error", async () => {
  const { client, calls } = harness([{ status: 503, bodyText: "unavailable" }]);
  await assert.rejects(
    () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "upstream_error" &&
      /returned 503/.test(error.detail),
  );
  assert.equal(calls.length, 3, "one attempt plus two retries");
});

test("AC-E2 401 is not retried and maps to credentials_rejected", async () => {
  const { client, calls } = harness([
    { status: 401, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
  ]);
  await assert.rejects(
    () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "credentials_rejected" &&
      /Authentication error/.test(error.detail),
  );
  assert.equal(calls.length, 1);
});

test("403, 404, and 400 map to their own classes without retrying", async () => {
  for (const [status, expected] of [
    [403, "credentials_rejected"],
    [404, "job_not_found"],
    [400, "invalid_request"],
  ] as Array<[number, string]>) {
    const { client, calls } = harness([{ status, bodyText: "nope" }]);
    await assert.rejects(
      () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
      (error: unknown) => error instanceof BrowserRunError && error.errorClass === expected,
    );
    assert.equal(calls.length, 1, `status ${status} must not retry`);
  }
});

test("a network failure is retryable and its message is scrubbed", async () => {
  const registry = new SecretRegistry();
  registry.remember(FIXTURE_TOKEN);
  let attempts = 0;
  const client = new CloudflareClient(
    {
      fetch: async () => {
        attempts += 1;
        throw new Error(`connect ECONNREFUSED with Bearer ${FIXTURE_TOKEN}`);
      },
      now: () => 0,
      sleep: async () => undefined,
      registry,
    },
    { requestsPerSecond: 1000 },
  );
  await assert.rejects(
    () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRunError);
      assert.equal(error.errorClass, "upstream_error");
      assert.ok(!error.message.includes(FIXTURE_TOKEN));
      return true;
    },
  );
  assert.equal(attempts, 1, "a thrown fetch is reported, not silently retried");
});

test("success:false in a 200 envelope is still a failure", async () => {
  const { client } = harness([
    { body: { success: false, errors: [{ message: "quota exceeded" }] } },
  ]);
  await assert.rejects(
    () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "upstream_error" &&
      /quota exceeded/.test(error.detail),
  );
});

test("a non-JSON body is reported rather than parsed loosely", async () => {
  const { client } = harness([{ bodyText: "<html>gateway</html>" }]);
  await assert.rejects(
    () => client.request({ method: "GET", url: "https://api.cloudflare.com/x", token }),
    (error: unknown) =>
      error instanceof BrowserRunError && /non-JSON response/.test(error.detail),
  );
});

test("the rate limiter spaces requests without dropping them", async () => {
  const { client, sleeps } = harness(
    [{ body: { success: true, result: "ok" } }],
    { requestsPerSecond: 2 },
  );
  await client.request({ method: "GET", url: "https://api.cloudflare.com/a", token });
  await client.request({ method: "GET", url: "https://api.cloudflare.com/b", token });
  await client.request({ method: "GET", url: "https://api.cloudflare.com/c", token });
  assert.deepEqual(sleeps, [500, 500], "500ms between calls at 2 requests per second");
});

test("error summaries prefer the Cloudflare envelope and stay bounded", () => {
  assert.equal(
    summarizeErrorBody(JSON.stringify({ errors: [{ message: "a" }, { message: "b" }] })),
    "a; b",
  );
  assert.equal(summarizeErrorBody(""), "");
  assert.equal(summarizeErrorBody("plain text").length, 10);
  assert.equal(summarizeErrorBody("x".repeat(900)).length, 400);
});

test("a GET carries no content-type and no body", async () => {
  const { client, calls } = harness([{ body: { success: true, result: "ok" } }]);
  await client.request({ method: "GET", url: "https://api.cloudflare.com/x", token });
  const init = calls[0]?.init as RequestInit;
  assert.equal(init.body, undefined);
  assert.equal((init.headers as Record<string, string>)["content-type"], undefined);
});
