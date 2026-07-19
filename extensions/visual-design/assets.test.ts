import assert from "node:assert/strict";
import test from "node:test";

import { buildClientAssets } from "./assets.ts";

test("browser assets bundle PlateJS and the visual workspace without external scripts", async () => {
  const assets = await buildClientAssets();

  assert.ok(assets.clientScript.length > 100_000);
  assert.match(assets.clientScript, /Design relay/);
  assert.match(assets.styleSheet, /\.design-viewport/);
  assert.doesNotMatch(assets.clientScript, /import\(["']https?:\/\//);
});
