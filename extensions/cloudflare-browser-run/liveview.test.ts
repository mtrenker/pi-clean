/**
 * Live View tests - DESIGN.md acceptance criteria AC-X2, AC-X3, AC-X4.
 *
 * The fixture "JWT URL" is synthetic. The point of every test here is that it
 * never escapes into anything durable or into a process argument list.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRunError } from "./errors.ts";
import {
  getLiveViewUrl,
  HANDOFF_MAX_MS,
  openInBrowser,
  REDIRECT_TTL_MS,
  runHandoff,
  startRedirector,
} from "./liveview.ts";
import { type CdpSessionLike } from "./session.ts";

const LIVE_VIEW_URL =
  "https://live.browser.run/ui/inspector?wss=session-abc&jwt=eyJhbGciOiJIUzI1NiJ9.fixture.signature";

interface FakeCdp extends CdpSessionLike {
  sent: Array<{ method: string; params?: Record<string, unknown> }>;
  emit(event: string, payload: unknown): void;
}

function fakeCdp(responses: Record<string, unknown> = {}): FakeCdp {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    sent,
    async send(method, params) {
      sent.push(params === undefined ? { method } : { method, params });
      if (method in responses) {
        const value = responses[method];
        if (value instanceof Error) throw value;
        return value;
      }
      return {};
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

test("AC-X2 the redirector hands out a loopback nonce, never the capability URL", async () => {
  const redirector = await startRedirector(LIVE_VIEW_URL);
  try {
    assert.match(redirector.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
    assert.ok(!redirector.url.includes("jwt="));
    assert.ok(!redirector.url.includes("live.browser.run"));
  } finally {
    await redirector.close();
  }
});

test("AC-X3 the redirector serves exactly one redirect and then stops", async () => {
  const redirector = await startRedirector(LIVE_VIEW_URL);
  try {
    const first = await fetch(redirector.url, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), LIVE_VIEW_URL);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(redirector.wasUsed(), true);

    // The server closes after the single redirect, so a replay cannot reach it.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(() => fetch(redirector.url, { redirect: "manual" }));
  } finally {
    await redirector.close();
  }
});

test("a wrong path gets 404 and does not consume the nonce", async () => {
  const redirector = await startRedirector(LIVE_VIEW_URL);
  try {
    const base = new URL(redirector.url);
    const wrong = await fetch(`${base.origin}/guess`, { redirect: "manual" });
    assert.equal(wrong.status, 404);
    assert.equal(redirector.wasUsed(), false);

    const right = await fetch(redirector.url, { redirect: "manual" });
    assert.equal(right.status, 302);
  } finally {
    await redirector.close();
  }
});

test("the redirector expires on its own and binds loopback only", async () => {
  const redirector = await startRedirector(LIVE_VIEW_URL, { ttlMs: 30 });
  const host = new URL(redirector.url).hostname;
  assert.equal(host, "127.0.0.1");

  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(() => fetch(redirector.url, { redirect: "manual" }));
  await redirector.close();
  assert.equal(REDIRECT_TTL_MS, 120_000);
});

test("closing twice is safe", async () => {
  const redirector = await startRedirector(LIVE_VIEW_URL);
  await redirector.close();
  await redirector.close();
});

test("the browser opener is chosen per platform and never receives a JWT URL", () => {
  // openInBrowser is only ever called with the loopback URL; this pins that the
  // helper reports failure rather than throwing when no opener exists.
  assert.equal(typeof openInBrowser("http://127.0.0.1:1/abc", "linux"), "boolean");
  assert.equal(typeof openInBrowser("http://127.0.0.1:1/abc", "darwin"), "boolean");
  assert.equal(typeof openInBrowser("http://127.0.0.1:1/abc", "win32"), "boolean");
});

test("getLiveViewUrl asks for tab mode and accepts the documented response shapes", async () => {
  const cdp = fakeCdp({ "Cloudflare.getLiveView": { url: LIVE_VIEW_URL } });
  assert.equal(await getLiveViewUrl(cdp), LIVE_VIEW_URL);
  assert.deepEqual(cdp.sent[0]?.params, { mode: "tab", expiresInMs: 300_000 });

  for (const response of [
    LIVE_VIEW_URL,
    { liveViewUrl: LIVE_VIEW_URL },
    { devtoolsFrontendUrl: LIVE_VIEW_URL },
  ]) {
    assert.equal(
      await getLiveViewUrl(fakeCdp({ "Cloudflare.getLiveView": response })),
      LIVE_VIEW_URL,
    );
  }
});

test("an expiry request is capped at one hour", async () => {
  const cdp = fakeCdp({ "Cloudflare.getLiveView": { url: LIVE_VIEW_URL } });
  await getLiveViewUrl(cdp, { expiresInMs: 9_000_000 });
  assert.equal((cdp.sent[0]?.params as { expiresInMs: number }).expiresInMs, 3_600_000);
});

test("a Live View failure never echoes the response body", async () => {
  await assert.rejects(
    () => getLiveViewUrl(fakeCdp({ "Cloudflare.getLiveView": { unexpected: LIVE_VIEW_URL } })),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRunError);
      assert.equal(error.detail, "Cloudflare.getLiveView returned no URL");
      assert.ok(!error.message.includes("jwt="));
      return true;
    },
  );

  await assert.rejects(
    () => getLiveViewUrl(fakeCdp({ "Cloudflare.getLiveView": new Error("protocol error") })),
    (error: unknown) => error instanceof BrowserRunError && /getLiveView failed/.test(error.detail),
  );
});

test("a structured handoff resolves on handoffComplete and keeps the session warm", async () => {
  const cdp = fakeCdp();
  const pending = runHandoff(cdp, {
    instructions: "Sign in",
    timeoutMs: 60_000,
    keepAliveMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  cdp.emit("Cloudflare.handoffComplete", { success: true });
  const result = await pending;

  assert.equal(result.success, true);
  assert.equal(cdp.sent[0]?.method, "Cloudflare.handoff");
  assert.equal((cdp.sent[0]?.params as { instructions: string }).instructions, "Sign in");
  assert.ok(
    cdp.sent.some((call) => call.method === "Browser.getVersion"),
    "protocol traffic keeps Cloudflare's idle timer from closing the session",
  );
});

test("a failed or timed-out handoff reports why and saves nothing", async () => {
  const failed = fakeCdp();
  const pendingFailed = runHandoff(failed, { instructions: "x", timeoutMs: 60_000 });
  failed.emit("Cloudflare.handoffComplete", { success: false });
  const failure = await pendingFailed;
  assert.equal(failure.success, false);
  assert.match(failure.reason, /marked the handoff failed/);

  const timedOut = await runHandoff(fakeCdp(), { instructions: "x", timeoutMs: 1_000 });
  assert.equal(timedOut.success, false);
  assert.match(timedOut.reason, /timed out after 1 seconds/);
});

test("a handoff that Cloudflare refuses is reported, not thrown", async () => {
  const cdp = fakeCdp({ "Cloudflare.handoff": new Error("not supported") });
  const result = await runHandoff(cdp, { instructions: "x", timeoutMs: 60_000 });
  assert.equal(result.success, false);
  assert.match(result.reason, /Cloudflare.handoff failed: not supported/);
});

test("the handoff timeout stays inside Cloudflare's documented maximum", async () => {
  const cdp = fakeCdp();
  const pending = runHandoff(cdp, { instructions: "x", timeoutMs: HANDOFF_MAX_MS * 4 });
  cdp.emit("Cloudflare.handoffComplete", { success: true });
  await pending;
  assert.equal((cdp.sent[0]?.params as { timeoutMs: number }).timeoutMs, HANDOFF_MAX_MS);
});
