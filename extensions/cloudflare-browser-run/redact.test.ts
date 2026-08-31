/**
 * Redaction tests - DESIGN.md section 18 and acceptance criterion AC-X1.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { REDACTED, SecretRegistry, redact, redactValue } from "./redact.ts";
import { FIXTURE_ACCOUNT_ID, FIXTURE_TOKEN } from "./test-support.ts";

test("registered secret values are removed by exact match", () => {
  const registry = new SecretRegistry();
  registry.remember(FIXTURE_TOKEN);
  registry.remember(FIXTURE_ACCOUNT_ID);

  const text = `POST https://api.cloudflare.com/client/v4/accounts/${FIXTURE_ACCOUNT_ID}/browser-rendering/markdown failed with ${FIXTURE_TOKEN}`;
  const scrubbed = redact(text, registry);
  assert.ok(!scrubbed.includes(FIXTURE_TOKEN));
  assert.ok(!scrubbed.includes(FIXTURE_ACCOUNT_ID));
  assert.match(scrubbed, /accounts\/\[redacted\]\/browser-rendering/);
});

test("a secret appearing many times is removed every time", () => {
  const registry = new SecretRegistry();
  registry.remember(FIXTURE_TOKEN);
  const scrubbed = redact(`${FIXTURE_TOKEN} and ${FIXTURE_TOKEN}`, registry);
  assert.equal(scrubbed, `${REDACTED} and ${REDACTED}`);
});

test("short values are never registered, so ordinary words survive", () => {
  const registry = new SecretRegistry();
  registry.remember("abc");
  registry.remember("");
  registry.remember(undefined);
  assert.equal(registry.size, 0);
  assert.equal(redact("abc is a common string", registry), "abc is a common string");
});

test("JWT-bearing capability URLs are scrubbed without a registry", () => {
  const url =
    "https://live.browser.run/ui/inspector?wss=abc&jwt=eyJhbGciOiJIUzI1NiJ9.payload.signature";
  const scrubbed = redact(url);
  assert.ok(!scrubbed.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.match(scrubbed, /jwt=\[redacted\]/);
  assert.match(scrubbed, /wss=abc/, "only the jwt parameter is removed");
});

test("Authorization echoes and the CDP websocket endpoint are scrubbed", () => {
  assert.match(
    redact(`authorization: Bearer ${FIXTURE_TOKEN}`),
    /authorization: Bearer \[redacted\]/,
  );
  assert.match(redact(`Bearer ${FIXTURE_TOKEN}`), /^Bearer \[redacted\]$/);
  const wss = `wss://api.cloudflare.com/client/v4/accounts/${FIXTURE_ACCOUNT_ID}/browser-rendering/devtools/browser?keep_alive=600000`;
  const scrubbed = redact(`connect failed: ${wss}`);
  assert.ok(!scrubbed.includes(FIXTURE_ACCOUNT_ID));
  assert.match(scrubbed, /wss:\/\/api\.cloudflare\.com\/\[redacted\]/);
});

test("hex-shaped content is left alone unless it is a registered secret", () => {
  // A commit id and an md5 digest must survive: corrupting page content to chase
  // a value we already redact by exact match would be a real cost for no gain.
  const text =
    "commit 9f2a1c4e7b8d0a3f6c5e2b1d4a7f0c3e6b9d2a1c and md5 d41d8cd98f00b204e9800998ecf8427e";
  assert.equal(redact(text), text);
});

test("redactValue walks arrays and objects", () => {
  const registry = new SecretRegistry();
  registry.remember(FIXTURE_TOKEN);
  const scrubbed = redactValue(
    { a: FIXTURE_TOKEN, b: [1, FIXTURE_TOKEN, { c: FIXTURE_TOKEN }], d: true, e: null },
    registry,
  );
  assert.deepEqual(scrubbed, {
    a: REDACTED,
    b: [1, REDACTED, { c: REDACTED }],
    d: true,
    e: null,
  });
});

test("a registry never renders its contents", () => {
  const registry = new SecretRegistry();
  registry.remember(FIXTURE_TOKEN);
  assert.equal(String(registry), "SecretRegistry(1)");
  assert.equal(JSON.stringify({ registry }), '{"registry":"[redacted]"}');
  registry.clear();
  assert.equal(registry.size, 0);
});

test("longer secrets are replaced before shorter ones they contain", () => {
  const registry = new SecretRegistry();
  registry.remember("prefix-secret");
  registry.remember("prefix-secret-extended");
  assert.equal(redact("prefix-secret-extended", registry), REDACTED);
});
