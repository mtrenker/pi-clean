import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));

test("Codex relay is image-owned, fixed-destination, request-bounded, and credential-blind", async () => {
  const [relay, genericRelay, genericImage, browserImage] = await Promise.all([
    readFile(join(root, "image", "codex-relay.mjs"), "utf8"),
    readFile(join(root, "image-pi", "codex-relay.mjs"), "utf8"),
    readFile(join(root, "image-pi", "Dockerfile"), "utf8"),
    readFile(join(root, "image", "Dockerfile"), "utf8"),
  ]);
  assert.equal(genericRelay, relay);
  assert.match(relay, /const TARGET = "https:\/\/chatgpt\.com\/backend-api\/codex\/responses"/);
  assert.match(relay, /MAX_REQUEST_BYTES/);
  assert.match(relay, /openshell:resolve:env:CODEX_AUTH_ACCESS_TOKEN/);
  assert.match(relay, /openshell:resolve:env:CODEX_AUTH_ACCOUNT_ID/);
  assert.equal(relay.includes("request.headers.authorization"), false);
  assert.equal(relay.includes("console."), false);
  assert.match(genericImage, /COPY codex-relay\.mjs \/opt\/openshell-agent\/codex-relay\.mjs[\s\S]*ln \/usr\/bin\/node \/opt\/openshell-agent\/relay-node[\s\S]*chmod 0555/);
  assert.match(browserImage, /ln \/usr\/bin\/node \/opt\/openshell-agent\/relay-node[\s\S]*chmod 0555/);
});

test("worker uses only a synthetic local Codex identity and disables local OAuth refresh", async () => {
  const worker = await readFile(join(root, "worker-runtime.mjs"), "utf8");
  assert.match(worker, /chatgpt_account_id: "openshell-placeholder"/);
  assert.match(worker, /settings\.json[\s\S]*transport: "sse"/);
  assert.match(worker, /spawn\("\/opt\/openshell-agent\/relay-node", \["\/opt\/openshell-agent\/codex-relay\.mjs"\]/);
  assert.equal(worker.includes("CODEX_AUTH_ACCESS_TOKEN"), false);
  assert.equal(worker.includes("CODEX_AUTH_REFRESH_TOKEN"), false);
});
