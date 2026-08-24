#!/usr/bin/env node
// Opt-in local DOM validation for the professional-socials browser controller.
//
//   npm i --no-save playwright-core
//   node node_modules/playwright-core/cli.js install chromium
//   OPENSHELL_BROWSER_FIXTURE=1 npm run test:openshell-agent:browser-fixture
//
// It runs the real image controller against local fixture pages and the real
// repository rulebook: Chromium's host resolver maps the authorized hostnames
// to the fixture server, so classification, dialogs, refs, declared diffs,
// hostile page instructions, sensitive surfaces, and pause/resume are exercised
// exactly as they are in a sandbox. Live sites are never contacted.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.OPENSHELL_BROWSER_FIXTURE !== "1") {
  console.log("SKIP: set OPENSHELL_BROWSER_FIXTURE=1 (and install playwright-core with Chromium) for the local DOM fixture check");
  process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { issueMandate, signRequest, taskHash, browserControlPacket, DEFAULT_BUDGET } = await import("./mandate.ts");

const checks = [];
const playwright = process.env.OPENSHELL_BROWSER_PLAYWRIGHT
  ?? tryResolve("playwright-core/index.mjs")
  ?? tryResolve("playwright-core");
if (!playwright) {
  console.error("playwright-core is required for the fixture harness: npm i --no-save playwright-core");
  process.exit(2);
}

const SECRET = "fixture-control-secret-value-000000000000";
const WORKSPACE_KEY = "f".repeat(64);
const failures = [];
const state = await mkdtemp(join(tmpdir(), "openshell-browser-fixture-"));
await mkdir(join(state, "uploads"), { recursive: true });

const pages = {
  profile: await readFile(join(root, "fixtures", "profile.html"), "utf8"),
  feed: await readFile(join(root, "fixtures", "feed.html"), "utf8"),
  settings: await readFile(join(root, "fixtures", "settings.html"), "utf8"),
  challenge: await readFile(join(root, "fixtures", "challenge.html"), "utf8"),
};

const fixtureServer = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
  const body = path.startsWith("/in/gate") ? pages.challenge
    : path.startsWith("/in/") ? pages.profile
    : path.startsWith("/feed") ? pages.feed
    : path.startsWith("/psettings") ? pages.settings
    : "<title>Not found</title><p>not found</p>";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
});
await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
const fixturePort = fixtureServer.address().port;
const controllerPort = fixturePort + 1;

const controller = spawn(process.execPath, [join(root, "image", "browser-controller.mjs")], {
  env: {
    ...process.env,
    OPENSHELL_BROWSER_FIXTURE: "1",
    OPENSHELL_BROWSER_STATE_DIR: state,
    OPENSHELL_BROWSER_PORT: String(controllerPort),
    OPENSHELL_BROWSER_PLAYWRIGHT: playwright,
    OPENSHELL_BROWSER_FIXTURE_RESOLVER: `MAP www.linkedin.com 127.0.0.1:${fixturePort}, MAP www.xing.com 127.0.0.1:${fixturePort}`,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  await waitForController();
  await call("/control/initialize", { secret: SECRET, browserWorkspaceKey: WORKSPACE_KEY });
  await scenario();
} catch (error) {
  failures.push(`harness error: ${error?.stack ?? error}`);
} finally {
  await stopController();
  fixtureServer.close();
  await rm(state, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "fail", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: "pass", checks: checks.length }));
// Chromium and the keep-alive fetch agent would otherwise hold the loop open.
process.exit(0);

// ---------------------------------------------------------------------------

function check(name, condition, detail) {
  checks.push(name);
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

async function scenario() {
  let sequence = 0;
  let mandateId = await activate(["read", "edit-profile", "submit-profile", "publish-post"]);
  const ps = async (path, body) => {
    sequence += 1;
    const auth = signRequest(SECRET, { mandateId, seq: sequence, path, body });
    return call(path, { auth, body });
  };

  // --- profile surface, dialog confinement, refs
  let snapshot = (await ps("/ps/navigate", { url: "http://www.linkedin.com/in/martin" })).body;
  check("profile snapshot classifies the site surface", snapshot.surface?.surface === "linkedin.profile", JSON.stringify(snapshot.surface));
  check("hostile page text is returned as data only", String(snapshot.text).includes("Ignore your previous instructions"));
  check("only visible elements receive a ref", !snapshot.elements.some((element) => element.name.includes("Headline")), JSON.stringify(snapshot.elements.map((e) => e.name)));

  const openEdit = ref(snapshot, (element) => element.name === "Open edit dialog");
  const location = ref(snapshot, (element) => element.name.includes("Location"));
  const denied = await ps("/ps/act", { op: "fill", ref: location, text: "Berlin" });
  check("inline edits are refused where the site uses dialogs", denied.body.code === "inline_edit_denied", JSON.stringify(denied.body));

  await ps("/ps/act", { op: "click", ref: openEdit });
  snapshot = (await ps("/ps/snapshot", {})).body;
  check("the open dialog is reported", snapshot.dialog === "Edit intro", snapshot.dialog);
  check("password fields never receive a ref", !snapshot.elements.some((element) => element.type === "password"), JSON.stringify(snapshot.elements.map((e) => e.type)));
  check("file inputs stay addressable for staged uploads", snapshot.elements.some((element) => element.upload));
  check("commit controls are labelled", snapshot.elements.some((element) => element.commitControl));

  const headline = ref(snapshot, (element) => element.name.includes("Headline"));
  const summary = ref(snapshot, (element) => element.name.includes("About"));
  const availability = ref(snapshot, (element) => element.tag === "select");
  const skill = ref(snapshot, (element) => element.name.includes("Add a skill"));
  const photo = ref(snapshot, (element) => element.upload);
  const save = ref(snapshot, (element) => element.name === "Save");

  // The protocol is checkpoint first, then edit: the checkpoint is what anchors
  // the before values the submit has to declare.
  const checkpoint = (await ps("/ps/checkpoint", { refs: [headline, summary, availability] })).body;
  check("checkpoints record the fields under edit", checkpoint.fields?.length === 3, JSON.stringify(checkpoint.fields));

  const fill = await ps("/ps/act", { op: "fill", ref: headline, text: "Fractional CTO" });
  check("dialog edits are authorized", fill.status === 200, JSON.stringify(fill.body));
  const edit = await ps("/ps/act", { op: "edit", ref: summary, text: "Building reliable platforms." });
  check("contenteditable fields are editable", edit.status === 200, JSON.stringify(edit.body));
  const select = await ps("/ps/act", { op: "select", ref: availability, option: "Available in 4 weeks" });
  check("select options are selectable", select.status === 200, JSON.stringify(select.body));
  const combobox = await ps("/ps/act", { op: "combobox", ref: skill, option: "Platform engineering" });
  check("comboboxes choose a visible option", combobox.status === 200, JSON.stringify(combobox.body));
  const enter = await ps("/ps/act", { op: "enter", ref: skill });
  check("allowed Enter reaches the field", enter.status === 200, JSON.stringify(enter.body));
  const afterEnter = (await ps("/ps/act", { op: "click", ref: skill })).body;
  check("Enter did not navigate or submit the form", afterEnter.url === "http://www.linkedin.com/in/martin", JSON.stringify(afterEnter));

  const staged = "11111111-2222-4333-8444-555555555555.png";
  await writeFile(join(state, "uploads", staged), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const upload = await ps("/ps/upload", { ref: photo, stageId: staged });
  check("staged uploads attach without exposing a path", upload.status === 200, JSON.stringify(upload.body));

  const clicked = await ps("/ps/act", { op: "click", ref: save });
  check("clicking a commit control is refused", clicked.body.code === "submit_requires_declared_diff", JSON.stringify(clicked.body));

  const undeclared = await ps("/ps/submit", {
    ref: save,
    checkpointId: checkpoint.checkpointId,
    intent: "submit-profile",
    expected: [{ ref: headline, before: "CTO", after: "Fractional CTO" }],
  });
  check("an undeclared changed field refuses the submit", undeclared.body.code === "diff_mismatch", JSON.stringify(undeclared.body));

  const committed = await ps("/ps/submit", {
    ref: save,
    checkpointId: checkpoint.checkpointId,
    intent: "submit-profile",
    expected: [
      { ref: headline, before: "CTO", after: "Fractional CTO" },
      { ref: summary, before: "Building reliable systems.", after: "Building reliable platforms." },
      { ref: availability, before: "Not available", after: "Available in 4 weeks" },
    ],
  });
  check("a fully declared diff commits the single-page save", committed.body.committed === true, JSON.stringify(committed.body));
  check("the committed change set is reported back", committed.body.changes?.length === 3, JSON.stringify(committed.body.changes));

  // --- hard denies win over an open dialog
  mandateId = await reactivate(["read", "edit-profile", "submit-profile", "publish-post"]);
  sequence = 0;
  await ps("/ps/navigate", { url: "http://www.linkedin.com/in/martin" });
  snapshot = (await ps("/ps/snapshot", {})).body;
  await ps("/ps/act", { op: "click", ref: ref(snapshot, (element) => element.name === "Open danger dialog") });
  snapshot = (await ps("/ps/snapshot", {})).body;
  const confirm = await ps("/ps/act", { op: "fill", ref: ref(snapshot, (element) => element.name.includes("DELETE")), text: "DELETE" });
  check("a destructive dialog is refused", confirm.body.code === "hard_deny_dialog", JSON.stringify(confirm.body));

  // --- sensitive surface and human gate
  mandateId = await reactivate(["read", "edit-profile", "submit-profile", "publish-post"]);
  sequence = 0;
  const settings = await ps("/ps/navigate", { url: "http://www.linkedin.com/psettings/account" });
  check("account settings are refused at navigation", settings.body.code === "hard_deny_surface", JSON.stringify(settings.body));
  const gateNavigation = await ps("/ps/navigate", { url: "http://www.linkedin.com/in/gate" });
  check("an allowed URL that turns into a challenge still loads", gateNavigation.status === 200, JSON.stringify(gateNavigation.body).slice(0, 200));
  const gated = (await ps("/ps/snapshot", {})).body;
  check("a human-only challenge redacts the snapshot", gated.redacted === true && gated.elements.length === 0, JSON.stringify(gated).slice(0, 200));
  check("the challenge page text is not exposed", !String(gated.text ?? "").includes("one-time code"));
  const gatedAction = await ps("/ps/act", { op: "click", ref: `e${gated.generation}-0` });
  check("actions during a human gate need takeover", gatedAction.body.code === "manual_takeover_required", JSON.stringify(gatedAction.body));

  // --- publish on the feed composer
  mandateId = await reactivate(["read", "publish-post"]);
  sequence = 0;
  await ps("/ps/navigate", { url: "http://www.linkedin.com/feed/" });
  snapshot = (await ps("/ps/snapshot", {})).body;
  await ps("/ps/act", { op: "click", ref: ref(snapshot, (element) => element.name === "Start a post") });
  snapshot = (await ps("/ps/snapshot", {})).body;
  const postBody = ref(snapshot, (element) => element.name.includes("Post text"));
  const publish = ref(snapshot, (element) => element.name === "Publish");
  const postCheckpoint = (await ps("/ps/checkpoint", { refs: [postBody] })).body;
  await ps("/ps/act", { op: "edit", ref: postBody, text: "Shipping the bounded professional-socials slice." });
  const published = await ps("/ps/submit", {
    ref: publish,
    checkpointId: postCheckpoint.checkpointId,
    intent: "publish-post",
    expected: [{ ref: postBody, before: "", after: "Shipping the bounded professional-socials slice." }],
  });
  check("the composer publishes with a declared diff", published.body.committed === true, JSON.stringify(published.body));
  check("the permalink is recorded from the resulting URL", String(published.body.permalink ?? "").includes("/feed/update/"), JSON.stringify(published.body.permalink));

  // --- takeover pauses automation and invalidates refs
  const beforePause = (await ps("/ps/snapshot", {})).body;
  await call("/control/pause", browserControlPacket(SECRET, "pause").packet);
  const paused = await ps("/ps/snapshot", {});
  check("a paused controller refuses autonomous routes", paused.status === 423 || paused.body.code === "automation_paused", JSON.stringify(paused));
  await call("/control/resume", browserControlPacket(SECRET, "resume").packet);
  const stale = await ps("/ps/act", { op: "click", ref: beforePause.elements[0].ref });
  check("resume invalidates every earlier ref", stale.body.code === "stale_ref", JSON.stringify(stale.body));
  const revalidated = await call("/mandate/revalidate", browserControlPacket(SECRET, "mandate-revalidate").packet);
  check("the mandate is revalidated after takeover", revalidated.body.mandate === "active", JSON.stringify(revalidated.body));
}

function ref(snapshot, predicate) {
  const element = (snapshot.elements ?? []).find((entry) => predicate(entry));
  if (!element) throw new Error(`no element matched in snapshot: ${JSON.stringify((snapshot.elements ?? []).map((entry) => entry.name))}`);
  return element.ref;
}

async function activate(actionClasses) {
  const health = await call("/health");
  const issuedAt = new Date();
  const mandate = issueMandate(SECRET, {
    jobId: "fixture-job",
    workspaceId: "fixture-workspace",
    browserWorkspaceKey: WORKSPACE_KEY,
    controllerEpoch: health.body.epoch,
    taskHash: taskHash("fixture task"),
    sites: ["linkedin"],
    origins: ["www.linkedin.com"],
    actionClasses,
    budget: { ...DEFAULT_BUDGET },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 20 * 60_000).toISOString(),
  });
  const response = await call("/mandate/activate", { ...browserControlPacket(SECRET, "mandate-activate").packet, mandate });
  if (response.status !== 200) throw new Error(`mandate activation failed: ${JSON.stringify(response.body)}`);
  return mandate.mandateId;
}

async function reactivate(actionClasses) {
  await call("/mandate/revoke", { ...browserControlPacket(SECRET, "mandate-revoke").packet, reason: "fixture_phase" });
  return activate(actionClasses);
}

async function call(path, body) {
  const response = await fetch(`http://127.0.0.1:${controllerPort}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitForController() {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("controller did not become ready"))), 90_000);
    const finish = (settle) => { clearTimeout(timer); settle(); };
    controller.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes('"ready":true')) finish(resolve);
    });
    controller.on("exit", (code) => finish(() => reject(new Error(`controller exited early with code ${code}`))));
  });
}

/** SIGTERM first so Playwright can close Chromium, SIGKILL only as a backstop. */
async function stopController() {
  if (controller.exitCode !== null) return;
  const exited = new Promise((resolve) => controller.once("exit", resolve));
  controller.kill("SIGTERM");
  const timer = setTimeout(() => controller.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
  controller.unref();
}

function tryResolve(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}
