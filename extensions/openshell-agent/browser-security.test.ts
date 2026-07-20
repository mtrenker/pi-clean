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
  assert.match(source, /authorizeControl\(body, action\)/, "pause and resume require a host-authenticated one-time packet");
  assert.match(source, /automation_paused/);
  assert.equal(source.includes("connectOverCDP"), false, "worker-reachable CDP must not exist");
});

test("manual takeover is loopback-only and the browser profile is Unix-isolated", async () => {
  const [dockerfile, entrypoint, controller, hostExtension, servicePolicy, workerBridge] = await Promise.all([
    readFile(join(root, "image", "Dockerfile"), "utf8"),
    readFile(join(root, "image", "entrypoint.sh"), "utf8"),
    readFile(join(root, "image", "browser-controller.mjs"), "utf8"),
    readFile(join(root, "index.ts"), "utf8"),
    readFile(join(root, "profiles", "authenticated-browser-service.policy.yaml"), "utf8"),
    readFile(join(root, "worker-browser.ts"), "utf8"),
  ]);
  assert.match(dockerfile, /chmod 0700 \/var\/lib\/openshell-browser/);
  assert.match(entrypoint, /127\.0\.0\.1:6080 127\.0\.0\.1:5900/);
  assert.match(entrypoint, /Xvfb.*-auth/);
  assert.equal(entrypoint.includes("remote-debugging-port"), false);
  assert.equal(controller.includes("-nopw"), false);
  assert.match(controller, /-rfbauth/);
  assert.match(controller, /controlSecretPath[\s\S]*mode: 0o600/);
  assert.match(controller, /deriveVncPassword/);
  assert.equal(controller.includes("vncPassword });"), false, "the controller must not disclose the derived VNC password");
  assert.match(hostExtension, /control\/pause[\s\S]*kill -CONT/, "failed controller pause must resume the worker");
  assert.match(hostExtension, /action === "resume"[\s\S]*control\/resume/, "explicit resume must repair a pause even without a forward handle");
  assert.match(entrypoint, /No untrusted worker process runs in this sandbox/);
  assert.match(hostExtension, /record\.browserSandboxName/);
  assert.match(servicePolicy, /run_as_user: 2000/);
  assert.match(servicePolicy, /network_policies: \{\}/);
  assert.equal(workerBridge.includes("127.0.0.1:3010"), false, "the worker must not reach the browser controller directly");
  assert.match(workerBridge, /browser-bridge/);
});
