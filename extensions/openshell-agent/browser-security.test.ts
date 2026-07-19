import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));

test("browser controller exposes no credential, storage, screenshot, trace, or arbitrary evaluation API", async () => {
  const source = await readFile(join(root, "image", "browser-controller.mjs"), "utf8");
  for (const forbiddenRoute of ["/cookies", "/storage", "/download", "/screenshot", "/trace", "/evaluate", "/cdp"]) {
    assert.equal(source.includes(`\"${forbiddenRoute}\"`), false, `${forbiddenRoute} must not be exposed`);
  }
  assert.match(source, /manual_takeover_required/);
  assert.match(source, /password\|passcode/);
  assert.match(source, /captcha/);
  assert.match(source, /SIGSTOP/, "pause must OS-suspend the automation controller");
  assert.equal(source.includes("connectOverCDP"), false, "worker-reachable CDP must not exist");
});

test("manual takeover is loopback-only and the browser profile is Unix-isolated", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    readFile(join(root, "image", "Dockerfile"), "utf8"),
    readFile(join(root, "image", "entrypoint.sh"), "utf8"),
  ]);
  assert.match(dockerfile, /chmod 0700 \/var\/lib\/openshell-browser/);
  assert.match(entrypoint, /127\.0\.0\.1:6080 127\.0\.0\.1:5900/);
  assert.equal(entrypoint.includes("remote-debugging-port"), false);
  assert.match(entrypoint, /kill -CONT/);
  assert.match(entrypoint, /runuser -u browser/);
});
