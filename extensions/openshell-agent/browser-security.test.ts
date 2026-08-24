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

test("the autonomous mode adds no credential, storage, script, or path escape route", async () => {
  const [controller, workerBridge, entrypoint] = await Promise.all([
    readFile(join(root, "image", "browser-controller.mjs"), "utf8"),
    readFile(join(root, "worker-browser.ts"), "utf8"),
    readFile(join(root, "image", "entrypoint.sh"), "utf8"),
  ]);
  for (const forbiddenRoute of ["/ps/cookies", "/ps/storage", "/ps/evaluate", "/ps/screenshot", "/ps/download", "/ps/cdp", "/ps/profile"]) {
    assert.equal(controller.includes(`"${forbiddenRoute}"`), false, `${forbiddenRoute} must not exist`);
  }
  assert.equal(/case "\/ps\/[a-z]+": return ps[A-Za-z]+/.test(controller), true, "every autonomous route is an explicit case");
  assert.equal(workerBridge.includes("setInputFiles"), false, "the worker never names a browser-side path");
  assert.match(controller, /join\(UPLOAD_DIR, body\.stageId\)/, "uploads are addressed by staged id only");
  assert.match(controller, /STAGE_PATTERN\.test\(body\.stageId\)/);
  assert.equal(controller.includes("process.env.OPENSHELL_BROWSER_PLAYWRIGHT"), true);
  assert.equal(entrypoint.includes("OPENSHELL_BROWSER_FIXTURE"), false, "the production entrypoint never enables fixture mode");
  assert.equal(entrypoint.includes("OPENSHELL_BROWSER_PLAYWRIGHT"), false);
  assert.match(controller, /const FIXTURE = process\.env\.OPENSHELL_BROWSER_FIXTURE === "1"/);
  assert.match(controller, /const PLAYWRIGHT = FIXTURE[\s\S]*?"\/opt\/openshell-browser\/node_modules\/playwright-core\/index\.mjs"/);
});

test("a task mandate never unlocks the legacy selector surface and refuses selector input", async () => {
  const controller = await readFile(join(root, "image", "browser-controller.mjs"), "utf8");
  assert.match(controller, /if \(guard\.active\) throw new ControllerError\("legacy_path_denied"\)/);
  assert.match(controller, /REF_PATTERN = \/\^e\[0-9\]\{1,6\}-\[0-9\]\{1,4\}\$\//);
  assert.match(controller, /if \(Number\(ref\.slice\(1\)\.split\("-"\)\[0\]\) !== generation\) throw new ControllerError\("stale_ref"\)/);
  assert.match(controller, /page\.locator\(`\[data-osref="\$\{ref\}"\]`\)/);
});

test("sensitive fields and denied surfaces are redacted before a worker snapshot", async () => {
  const controller = await readFile(join(root, "image", "browser-controller.mjs"), "utf8");
  assert.match(controller, /if \(classification\.hardDeny \|\| context\.humanRequired\) \{[\s\S]*?redacted: true[\s\S]*?elements: \[\],[\s\S]*?text: "",/);
  assert.match(controller, /if \(sensitive && element\.type !== "file"\) continue;/);
  assert.match(controller, /const secret = type === "password" \|\| type === "hidden"/);
  assert.match(controller, /manual_takeover_required/);
});

test("takeover and resume invalidate refs and force mandate revalidation", async () => {
  const [controller, hostExtension] = await Promise.all([
    readFile(join(root, "image", "browser-controller.mjs"), "utf8"),
    readFile(join(root, "index.ts"), "utf8"),
  ]);
  assert.match(controller, /paused = false;[\s\S]*?invalidateRefs\(\);/);
  assert.match(controller, /url\.pathname === "\/mandate\/revalidate"[\s\S]*?authorizeControl\(body, "mandate-revalidate"\)/);
  assert.match(controller, /if \(drift\) guard\.revoke\("identity_drift"\)/);
  assert.match(hostExtension, /control\/resume[\s\S]*?mandate\/revalidate/);
  assert.match(controller, /if \(paused\) throw new ControllerError\("automation_paused"\);[\s\S]*?url\.pathname\.startsWith\("\/ps\/"\)/, "paused automation blocks the autonomous routes too");
});
