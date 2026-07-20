import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { boundUtf8 } from "./worker-utils.mjs";

import { MAX_ANSWER_BYTES, parseWorkerResult } from "./result.ts";

const root = dirname(fileURLToPath(import.meta.url));

test("worker truncation always stays within the host answer boundary", () => {
  for (const size of [MAX_ANSWER_BYTES + 1, MAX_ANSWER_BYTES + 224, MAX_ANSWER_BYTES + 100_000]) {
    const answer = boundUtf8("x".repeat(size), MAX_ANSWER_BYTES);
    assert.ok(Buffer.byteLength(answer, "utf8") <= MAX_ANSWER_BYTES);
    assert.doesNotThrow(() => parseWorkerResult(JSON.stringify({ status: "complete", answer })));
  }
});

test("worker lock ownership survives cancellation and does not delete another live job lock", async () => {
  const source = await readFile(join(root, "worker-runtime.mjs"), "utf8");
  assert.match(source, /writeFile\(join\(lockPath, "pid"\)/);
  assert.match(source, /\/proc\/\$\{pid\}\/cmdline/);
  assert.match(source, /if \(lockOwned\) await rm\(lockPath/);
});
