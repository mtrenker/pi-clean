#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

import { MandateGuard } from "./mandate.mjs";
import { authorizeSurface, classifyUrl, isCommitControl, isSensitiveField, permalinkFor, siteRules } from "./site-rules.mjs";

// The fixture mode exists only for the opt-in local DOM validation harness. The
// image entrypoint never sets it, so a production controller always uses the
// pinned browser-user paths, the real display, and the loopback control port.
const FIXTURE = process.env.OPENSHELL_BROWSER_FIXTURE === "1";
const STATE_DIR = FIXTURE ? process.env.OPENSHELL_BROWSER_STATE_DIR : "/var/lib/openshell-browser";
const UPLOAD_DIR = FIXTURE ? join(STATE_DIR, "uploads") : "/run/openshell-browser/uploads";
const PORT = FIXTURE ? Number(process.env.OPENSHELL_BROWSER_PORT ?? 3010) : 3010;
const PLAYWRIGHT = FIXTURE
  ? process.env.OPENSHELL_BROWSER_PLAYWRIGHT
  : "/opt/openshell-browser/node_modules/playwright-core/index.mjs";
const MAX_BODY = 256 * 1024;
// The safe-mode text bound is unchanged; only the autonomous submit envelope,
// which carries a declared diff, needs the larger body limit above.
const LEGACY_MAX_TEXT = 64 * 1024;
const MAX_TEXT = 20 * 1024;
const MAX_ELEMENTS = 200;
const HIGH_RISK = /(?:log\s*in|sign\s*in|password|passcode|one[- ]time|2fa|mfa|captcha|apply|application|submit|send|message|post|publish|purchase|buy|checkout|payment|accept|agree|terms|consent|delete|profile|account|bio|resume|curriculum|phone|address)/i;
const SENSITIVE_FIELD = /^(?:password|hidden|file)$/i;
const REF_PATTERN = /^e[0-9]{1,6}-[0-9]{1,4}$/;
const STAGE_PATTERN = /^[a-f0-9-]{36}(?:\.[a-z0-9]{1,8})?$/;
const EPOCH = randomUUID();
// Only authorization refusals feed the circuit breaker. Ordinary workflow
// errors such as a stale ref must not silently revoke a task mandate.
const AUTHORIZATION_DENIALS = new Set([
  "hard_deny_surface", "hard_deny_dialog", "hard_deny_heading", "surface_class_denied", "class_not_granted",
  "origin_not_authorized", "dialog_not_authorized", "inline_edit_denied", "sensitive_field_denied",
  "submit_requires_declared_diff", "diff_mismatch", "enter_not_allowed", "not_a_commit_control", "commit_outside_dialog",
]);

const playwrightModule = await import(PLAYWRIGHT);
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
const context = await chromium.launchPersistentContext(join(STATE_DIR, "profile"), {
  headless: FIXTURE,
  // OpenShell applies no_new_privs and blocks Chromium's nested namespace/setuid
  // sandbox. This browser therefore runs only in its dedicated agent-free
  // OpenShell sandbox; the untrusted Pi worker is in a separate sandbox.
  chromiumSandbox: false,
  viewport: FIXTURE ? { width: 1280, height: 800 } : null,
  args: [
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    // Fixture mode points the authorized hostnames at the local fixture server
    // so the opt-in harness exercises the real rulebook instead of a stand-in.
    FIXTURE && process.env.OPENSHELL_BROWSER_FIXTURE_RESOLVER
      ? `--host-resolver-rules=${process.env.OPENSHELL_BROWSER_FIXTURE_RESOLVER}`
      : "--host-resolver-rules=MAP android.clients.google.com ~NOTFOUND, MAP accounts.google.com ~NOTFOUND, MAP www.google.com ~NOTFOUND, MAP clients2.google.com ~NOTFOUND",
  ],
});
const page = context.pages()[0] ?? await context.newPage();
const controlSecretPath = join(STATE_DIR, ".control-secret");
const workspaceKeyPath = join(STATE_DIR, ".workspace-key");
let controlSecret = await readFile(controlSecretPath, "utf8").then((value) => value.trim()).catch(() => undefined);
const boundWorkspaceKey = await readFile(workspaceKeyPath, "utf8").then((value) => value.trim()).catch(() => undefined);
let paused = false;
let vncProcess;
const usedNonces = new Set();
let guard = new MandateGuard(controlSecret, EPOCH);
if (boundWorkspaceKey) guard.bindWorkspace(boundWorkspaceKey);

let generation = 0;
let baseline = new Map();
// File inputs are excluded from every declared diff: their value is a
// browser-owned path the worker never sees. Uploads are audited separately.
let uploadRefs = new Set();
let pendingDialog;
let pendingDialogTimer;
const checkpoints = new Map();

page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) invalidateRefs();
});
page.on("dialog", (dialog) => {
  // A page can raise a native dialog at any time and an unanswered one blocks
  // every later action, so an unclaimed dialog is dismissed on its own.
  clearTimeout(pendingDialogTimer);
  pendingDialog = dialog;
  pendingDialogTimer = setTimeout(() => {
    if (pendingDialog !== dialog) return;
    pendingDialog = undefined;
    dialog.dismiss().catch(() => {});
  }, 30_000);
});

if (!FIXTURE) await startVnc(controlSecret ? deriveVncPassword() : randomBytes(8).toString("hex").slice(0, 8));

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return send(response, 200, { ok: true, paused, epoch: EPOCH, mandate: guard.active ? "active" : "none" });
    }
    if (request.method !== "POST" && url.pathname !== "/snapshot") return send(response, 405, { code: "method_not_allowed" });
    if (request.method === "POST" && url.pathname === "/control/initialize") {
      const body = await jsonBody(request);
      if (controlSecret) throw new ControllerError("already_initialized");
      if (typeof body.secret !== "string" || !/^[a-zA-Z0-9_-]{40,64}$/.test(body.secret)) throw new ControllerError("invalid_control_secret");
      controlSecret = body.secret;
      await writeFile(controlSecretPath, `${controlSecret}\n`, { mode: 0o600 });
      guard = new MandateGuard(controlSecret, EPOCH);
      if (typeof body.browserWorkspaceKey === "string" && /^[a-f0-9]{16,64}$/.test(body.browserWorkspaceKey)) {
        await writeFile(workspaceKeyPath, `${body.browserWorkspaceKey}\n`, { mode: 0o600 });
        guard.bindWorkspace(body.browserWorkspaceKey);
      }
      if (!FIXTURE) await startVnc(deriveVncPassword());
      return send(response, 200, { ok: true, epoch: EPOCH });
    }
    if (request.method === "POST" && (url.pathname === "/control/pause" || url.pathname === "/control/resume")) {
      const action = url.pathname.endsWith("pause") ? "pause" : "resume";
      const body = await jsonBody(request);
      authorizeControl(body, action);
      if (action === "pause") {
        paused = true;
      } else {
        paused = false;
        // A human-only interval can change the page, the account, or both.
        // Every ref and checkpoint minted before takeover is discarded.
        invalidateRefs();
      }
      return send(response, 200, { ok: true, automation: paused ? "paused" : "active" });
    }
    if (request.method === "POST" && url.pathname === "/mandate/activate") {
      const body = await jsonBody(request);
      authorizeControl(body, "mandate-activate");
      const result = guard.activate(body.mandate);
      if (!result.ok) return send(response, 403, { code: result.code });
      const identity = await captureIdentity(guard.active.origins);
      for (const [origin, tag] of identity) guard.recordIdentity(origin, tag);
      invalidateRefs();
      return send(response, 200, { ok: true, epoch: EPOCH, mandateId: guard.active.mandateId, identity: Object.fromEntries(identity) });
    }
    if (request.method === "POST" && url.pathname === "/mandate/revalidate") {
      const body = await jsonBody(request);
      authorizeControl(body, "mandate-revalidate");
      if (!guard.active) return send(response, 200, { ok: false, mandate: "none", reason: guard.revokedReason });
      const identity = await captureIdentity(guard.active.origins);
      const states = {};
      let drift = false;
      for (const [origin, tag] of identity) {
        const comparison = guard.compareIdentity(origin, tag);
        states[origin] = comparison.state;
        if (comparison.state === "drift") drift = true;
        else guard.recordIdentity(origin, tag);
      }
      const expired = Date.now() > Date.parse(guard.active.expiresAt);
      if (drift) guard.revoke("identity_drift");
      else if (expired) guard.revoke("expired");
      invalidateRefs();
      return send(response, 200, {
        ok: !drift && !expired,
        mandate: guard.active ? "active" : "revoked",
        reason: guard.revokedReason,
        identity: states,
      });
    }
    if (request.method === "POST" && url.pathname === "/mandate/revoke") {
      const body = await jsonBody(request);
      authorizeControl(body, "mandate-revoke");
      const reason = typeof body.reason === "string" && /^[a-z0-9_:-]{1,64}$/.test(body.reason) ? body.reason : "host_revoked";
      guard.revoke(reason);
      invalidateRefs();
      return send(response, 200, { ok: true, use: guard.use });
    }
    if (paused) throw new ControllerError("automation_paused");

    if (url.pathname.startsWith("/ps/")) {
      const envelope = await jsonBody(request);
      return send(response, ...await professionalSocials(url.pathname, envelope));
    }

    // Legacy safe-mode routes. They stay exactly as the authenticated-browser
    // profile has always used them, and they are refused while a task mandate
    // is active so an autonomous run cannot fall back to selector automation.
    if (guard.active) throw new ControllerError("legacy_path_denied");
    if (request.method === "GET" && url.pathname === "/snapshot") return send(response, 200, await snapshot());
    const body = await jsonBody(request);
    if (url.pathname === "/navigate") return send(response, 200, await navigate(body));
    if (url.pathname === "/click") return send(response, 200, await click(body));
    if (url.pathname === "/type") return send(response, 200, await typeText(body));
    if (url.pathname === "/press") return send(response, 200, await press(body));
    return send(response, 404, { code: "not_found" });
  } catch (error) {
    const code = error instanceof ControllerError ? error.code : "controller_error";
    const status = code === "manual_takeover_required" ? 409 : code === "automation_paused" ? 423 : 400;
    send(response, status, { code });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  if (FIXTURE) process.stdout.write(`${JSON.stringify({ ready: true, port: PORT, epoch: EPOCH })}\n`);
});

function authorizeControl(packet, action) {
  if (!controlSecret || typeof packet.timestamp !== "number" || Math.abs(Date.now() - packet.timestamp) > 30_000 ||
      typeof packet.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(packet.nonce) || usedNonces.has(packet.nonce) ||
      typeof packet.mac !== "string" || !/^[a-f0-9]{64}$/.test(packet.mac)) {
    throw new ControllerError("control_unauthorized");
  }
  const expected = createHmac("sha256", controlSecret).update(`${action}:${packet.timestamp}:${packet.nonce}`).digest();
  const supplied = Buffer.from(packet.mac, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ControllerError("control_unauthorized");
  usedNonces.add(packet.nonce);
}

function deriveVncPassword() {
  return createHmac("sha256", controlSecret).update("vnc").digest("hex").slice(0, 8);
}

async function startVnc(password) {
  const authPath = join(STATE_DIR, ".vnc-auth");
  if (vncProcess?.exitCode === null) {
    vncProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => vncProcess.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  spawnSync("x11vnc", ["-storepasswd", password, authPath], { stdio: "ignore" });
  vncProcess = spawn("x11vnc", ["-display", ":99", "-localhost", "-forever", "-shared", "-rfbauth", authPath, "-quiet"], {
    stdio: "ignore",
    env: { ...process.env, XAUTHORITY: join(STATE_DIR, ".Xauthority") },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// ---------------------------------------------------------------------------
// Legacy safe-mode operations (authenticated-browser). Unchanged behavior.
// ---------------------------------------------------------------------------

async function navigate(body) {
  if (typeof body.url !== "string") throw new ControllerError("invalid_url");
  const target = new URL(body.url);
  if (!["http:", "https:"].includes(target.protocol)) throw new ControllerError("invalid_url");
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  return snapshot();
}

async function snapshot() {
  const title = await page.title();
  const bodyText = bound(await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""));
  const elements = await page.locator("a,button,input,textarea,select,[role=button],[contenteditable=true]").evaluateAll((nodes) =>
    nodes.slice(0, 100).map((node, index) => ({
      index,
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute("type") ?? undefined,
      text: ((node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.textContent || "").trim()).slice(0, 160),
      selector: node.id ? `#${CSS.escape(node.id)}` : undefined,
    })),
  ).catch(() => []);
  const humanRequired = /captcha|verify you are human|security challenge|two-factor|one-time code/i.test(bodyText);
  return { title, url: page.url(), text: bodyText, elements, humanRequired, guidance: humanRequired ? "Use host /openshell takeover; do not automate this challenge." : undefined };
}

async function click(body) {
  const locator = getLocator(body.selector);
  const risk = await riskDescription(locator);
  if (risk) throw new ControllerError("manual_takeover_required");
  await locator.click({ timeout: 10_000 });
  return { ok: true, url: page.url() };
}

async function typeText(body) {
  if (typeof body.text !== "string" || Buffer.byteLength(body.text) > LEGACY_MAX_TEXT) throw new ControllerError("invalid_text");
  const locator = getLocator(body.selector);
  const type = await locator.getAttribute("type");
  const autocomplete = await locator.getAttribute("autocomplete");
  const risk = await riskDescription(locator);
  if (SENSITIVE_FIELD.test(type ?? "") || /one-time-code|cc-|current-password|new-password/i.test(autocomplete ?? "") || risk) {
    throw new ControllerError("manual_takeover_required");
  }
  if (body.clear) await locator.fill("");
  await locator.fill(body.text, { timeout: 10_000 });
  return { ok: true };
}

async function press(body) {
  const allowed = new Set(["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);
  if (!allowed.has(body.key)) throw new ControllerError("key_not_allowed");
  await page.keyboard.press(body.key);
  return { ok: true };
}

function getLocator(selector) {
  if (typeof selector !== "string" || !selector.trim() || selector.length > 500) throw new ControllerError("invalid_selector");
  return page.locator(selector).first();
}

async function riskDescription(locator) {
  const info = await locator.evaluate((node) => {
    const form = node.closest("form");
    return {
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute("type") ?? "",
      role: node.getAttribute("role") ?? "",
      text: [node.getAttribute("aria-label"), node.getAttribute("name"), node.getAttribute("placeholder"), node.textContent, form?.textContent].filter(Boolean).join(" ").slice(0, 2000),
    };
  });
  return info.tag === "button" || info.role === "button" || info.type.toLowerCase() === "submit" || HIGH_RISK.test(info.text) ? (info.text || info.tag) : "";
}

// ---------------------------------------------------------------------------
// Professional-socials mode. Every route below needs a verified task mandate
// and a per-request authorization packet, then repeats the host's rulebook
// checks against the live DOM.
// ---------------------------------------------------------------------------

async function professionalSocials(path, envelope) {
  const body = envelope?.body ?? {};
  const verified = guard.verifyRequest(path, body, envelope?.auth);
  if (!verified.ok) return [403, { code: verified.code }];
  try {
    const outcome = await dispatch(path, body);
    return [200, outcome];
  } catch (error) {
    const code = error instanceof ControllerError ? error.code : "controller_error";
    if (AUTHORIZATION_DENIALS.has(code)) guard.recordDenial(code);
    return [code === "manual_takeover_required" ? 409 : 403, { code, mandate: guard.active ? "active" : "revoked", revocation: guard.revokedReason }];
  }
}

async function dispatch(path, body) {
  switch (path) {
    case "/ps/navigate": return psNavigate(body);
    case "/ps/snapshot": return psSnapshot();
    case "/ps/act": return psAct(body);
    case "/ps/scroll": return psScroll(body);
    case "/ps/wait": return psWait(body);
    case "/ps/back": return psBack();
    case "/ps/dialog": return psDialog(body);
    case "/ps/upload": return psUpload(body);
    case "/ps/checkpoint": return psCheckpoint(body);
    case "/ps/submit": return psSubmit(body);
    default: throw new ControllerError("path_not_allowed");
  }
}

function chargeOrDeny(dimensions) {
  const exhausted = guard.checkBudget(dimensions);
  if (exhausted) throw new ControllerError(exhausted);
  guard.charge(dimensions);
}

function invalidateRefs() {
  generation += 1;
  baseline = new Map();
  uploadRefs = new Set();
  checkpoints.clear();
}

function currentClassification() {
  return classifyUrl(page.url());
}

/**
 * Surface authorization for one action.
 *
 * `targetDialog` is the dialog that actually contains the element being acted
 * on, so a hidden or decoy dialog elsewhere on the page can neither authorize
 * an edit nor disguise one. Any visible dialog whose name matches a global hard
 * deny stops the action outright.
 */
async function requireSurface(actionClass, targetDialog) {
  const classification = currentClassification();
  const context = await pageContext();
  if (context.humanRequired) throw new ControllerError("manual_takeover_required");
  if (actionClass !== "read" && !guard.allowsClass(actionClass)) throw new ControllerError("class_not_granted");
  if (actionClass !== "read" && !guard.allowsOrigin(classification.host)) throw new ControllerError("origin_not_authorized");
  for (const name of context.dialogNames) {
    const verdict = authorizeSurface(classification, "read", { dialogName: name });
    if (!verdict.allowed) throw new ControllerError(verdict.code);
  }
  const verdict = authorizeSurface(classification, actionClass, {
    dialogName: targetDialog ?? context.dialogNames[0] ?? "",
    headingText: context.headingText,
  });
  if (!verdict.allowed) throw new ControllerError(verdict.code);
  return { classification, context };
}

async function pageContext() {
  return page.evaluate(() => {
    const name = (node) => (node.getAttribute("aria-label")
      || document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent
      || node.querySelector("h1,h2,h3")?.textContent
      || "").replace(/\s+/g, " ").trim().slice(0, 200);
    // Only dialogs the operator would actually see count as open.
    const dialogNames = [...document.querySelectorAll('[role="dialog"],dialog')]
      .filter((node) => node.getClientRects().length > 0 && node.getAttribute("aria-hidden") !== "true")
      .map(name)
      .filter(Boolean)
      .slice(0, 8);
    const heading = (document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const text = (document.body?.innerText ?? "").slice(0, 4000);
    return { dialogNames, headingText: heading, humanRequired: /captcha|verify you are human|security challenge|two-factor|one-time code|enter your password/i.test(text) };
  }).catch(() => ({ dialogNames: [], headingText: "", humanRequired: false }));
}

async function psNavigate(body) {
  if (typeof body.url !== "string") throw new ControllerError("invalid_url");
  const target = new URL(body.url);
  if (target.protocol !== "https:" && !(FIXTURE && target.protocol === "http:")) throw new ControllerError("invalid_url");
  const classification = classifyUrl(target.toString());
  if (classification.hardDeny) throw new ControllerError("hard_deny_surface");
  if (!guard.allowsOrigin(classification.host)) throw new ControllerError("origin_not_authorized");
  chargeOrDeny(["actions"]);
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  return psSnapshot();
}

async function psSnapshot() {
  generation += 1;
  const gen = generation;
  const classification = currentClassification();
  const context = await pageContext();
  const title = await page.title().catch(() => "");
  if (classification.hardDeny || context.humanRequired) {
    baseline = new Map();
    return {
      url: page.url(),
      title,
      generation: gen,
      redacted: true,
      surface: summarize(classification),
      humanRequired: context.humanRequired,
      guidance: context.humanRequired
        ? "A human-only challenge is present. Stop and report it; the operator completes it through /openshell takeover."
        : "This surface is denied by the professional-socials rulebook and its content is not exposed.",
      elements: [],
      text: "",
    };
  }
  const rules = siteRules();
  const raw = await page.evaluate(({ gen, sensitiveAutocomplete, limit }) => {
    for (const tagged of document.querySelectorAll("[data-osref]")) tagged.removeAttribute("data-osref");
    const selector = "a,button,input,textarea,select,[role=button],[role=combobox],[role=textbox],[role=option],[role=checkbox],[contenteditable=true],[contenteditable='']";
    const nodes = [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length > 0).slice(0, limit);
    const accessibleName = (node) => {
      const labelledBy = node.getAttribute("aria-labelledby");
      const labelled = labelledBy ? document.getElementById(labelledBy)?.textContent : undefined;
      const label = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent : undefined;
      return (node.getAttribute("aria-label") || labelled || label || node.closest("label")?.textContent
        || node.getAttribute("placeholder") || node.getAttribute("title") || node.getAttribute("name") || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
    };
    return nodes.map((node, index) => {
      const ref = `e${gen}-${index}`;
      node.setAttribute("data-osref", ref);
      const tag = node.tagName.toLowerCase();
      const type = (node.getAttribute("type") ?? "").toLowerCase();
      const autocomplete = (node.getAttribute("autocomplete") ?? "").toLowerCase();
      const editable = tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable;
      const secret = type === "password" || type === "hidden" || sensitiveAutocomplete.some((entry) => autocomplete.includes(entry));
      const value = secret || !editable
        ? undefined
        : (tag === "select" ? (node.selectedOptions?.[0]?.label ?? "") : node.isContentEditable ? node.innerText : node.value ?? "").slice(0, 4000);
      return {
        ref,
        tag,
        type: type || undefined,
        role: node.getAttribute("role") ?? undefined,
        name: accessibleName(node),
        autocomplete: autocomplete || undefined,
        editable,
        disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true",
        checked: type === "checkbox" || type === "radio" ? node.checked === true : undefined,
        options: tag === "select" ? [...node.options].slice(0, 50).map((option) => option.label.slice(0, 120)) : undefined,
        inDialog: Boolean(node.closest('[role="dialog"],dialog')),
        submitControl: type === "submit" || (tag === "button" && type !== "button" && Boolean(node.closest("form"))),
        value,
      };
    });
  }, { gen, sensitiveAutocomplete: rules.globalHardDeny.sensitiveAutocomplete, limit: MAX_ELEMENTS }).catch(() => []);

  baseline = new Map();
  uploadRefs = new Set();
  const elements = [];
  for (const element of raw) {
    const sensitive = isSensitiveField({ type: element.type, name: element.name, autocomplete: element.autocomplete, label: element.name });
    if (sensitive && element.type !== "file") continue;
    if (element.type === "file") uploadRefs.add(element.ref);
    else if (element.editable && element.value !== undefined) baseline.set(element.ref, element.value);
    elements.push({
      ref: element.ref,
      tag: element.tag,
      type: element.type,
      role: element.role,
      name: element.name,
      editable: element.editable,
      disabled: element.disabled,
      checked: element.checked,
      options: element.options,
      inDialog: element.inDialog,
      commitControl: element.submitControl || isCommitControl(element.name),
      upload: element.type === "file",
      value: element.value,
    });
  }
  const text = bound(await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""));
  return {
    url: page.url(),
    title,
    generation: gen,
    surface: summarize(classification),
    dialog: context.dialogNames[0],
    dialogs: context.dialogNames.length > 1 ? context.dialogNames : undefined,
    humanRequired: false,
    elements,
    text,
  };
}

function summarize(classification) {
  return {
    site: classification.siteId,
    surface: classification.surfaceId,
    classes: classification.classes,
    hardDeny: classification.hardDeny,
    reason: classification.reason,
  };
}

function locatorFor(ref) {
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) throw new ControllerError("invalid_ref");
  if (Number(ref.slice(1).split("-")[0]) !== generation) throw new ControllerError("stale_ref");
  return page.locator(`[data-osref="${ref}"]`).first();
}

async function describeRef(ref) {
  const locator = locatorFor(ref);
  const info = await locator.evaluate((node) => {
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute("type") ?? "").toLowerCase();
    return {
      tag,
      type,
      role: node.getAttribute("role") ?? "",
      autocomplete: (node.getAttribute("autocomplete") ?? "").toLowerCase(),
      name: (() => {
        const labelledBy = node.getAttribute("aria-labelledby");
        const labelled = labelledBy ? document.getElementById(labelledBy)?.textContent : undefined;
        const label = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent : undefined;
        return (node.getAttribute("aria-label") || labelled || label || node.closest("label")?.textContent
          || node.getAttribute("placeholder") || node.getAttribute("title") || node.getAttribute("name") || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      })(),
      editable: tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable,
      contentEditable: node.isContentEditable === true,
      submitControl: type === "submit" || (tag === "button" && type !== "button" && Boolean(node.closest("form"))),
      inDialog: Boolean(node.closest('[role="dialog"],dialog')),
      dialogName: (() => {
        const dialog = node.closest('[role="dialog"],dialog');
        if (!dialog) return "";
        return (dialog.getAttribute("aria-label")
          || document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent
          || dialog.querySelector("h1,h2,h3")?.textContent
          || "").replace(/\s+/g, " ").trim().slice(0, 200);
      })(),
    };
  }).catch(() => { throw new ControllerError("ref_not_found"); });
  if (isSensitiveField({ type: info.type, name: info.name, autocomplete: info.autocomplete, label: info.name })) {
    if (info.type !== "file") throw new ControllerError("sensitive_field_denied");
  }
  return { locator, info };
}

async function psAct(body) {
  const op = String(body.op);
  const mutating = op !== "click";
  // A human-only challenge outranks every other refusal, including a stale ref.
  if ((await pageContext()).humanRequired) throw new ControllerError("manual_takeover_required");
  const { locator, info } = await describeRef(body.ref);
  const { classification } = await requireSurface(mutating ? mutatingClass(currentClassification()) : "read", info.dialogName);
  if (op === "click") {
    if (info.submitControl || isCommitControl(info.name)) throw new ControllerError("submit_requires_declared_diff");
    chargeOrDeny(["actions"]);
    await locator.click({ timeout: 10_000 });
    return { ok: true, url: page.url(), surface: summarize(classification) };
  }
  if (!info.editable && op !== "enter") throw new ControllerError("not_editable");
  const budget = guard.checkBudget(["actions", "edits"]);
  if (budget) throw new ControllerError(budget);
  switch (op) {
    case "fill":
      if (typeof body.text !== "string") throw new ControllerError("invalid_text");
      await fillValue(locator, info, body.text);
      break;
    case "clear":
      await fillValue(locator, info, "");
      break;
    case "edit":
      if (typeof body.text !== "string") throw new ControllerError("invalid_text");
      if (!info.contentEditable) throw new ControllerError("not_contenteditable");
      await fillValue(locator, info, body.text);
      break;
    case "check":
      await locator.check({ timeout: 10_000 });
      break;
    case "uncheck":
      await locator.uncheck({ timeout: 10_000 });
      break;
    case "select":
      if (typeof body.option !== "string") throw new ControllerError("invalid_option");
      await locator.selectOption({ label: body.option }, { timeout: 10_000 }).catch(() => locator.selectOption(body.option, { timeout: 10_000 }));
      break;
    case "combobox": {
      if (typeof body.option !== "string") throw new ControllerError("invalid_option");
      await locator.click({ timeout: 10_000 });
      const option = page.getByRole("option", { name: body.option }).first();
      await option.click({ timeout: 10_000 });
      break;
    }
    case "enter": {
      if (!classification.enterKeys) throw new ControllerError("enter_not_allowed");
      await withSubmitGuard(async () => {
        await locator.focus({ timeout: 10_000 });
        await page.keyboard.press("Enter");
      });
      break;
    }
    default:
      throw new ControllerError("invalid_op");
  }
  guard.charge(["actions", "edits"]);
  return { ok: true, url: page.url(), surface: summarize(classification) };
}

async function fillValue(locator, info, value) {
  if (info.contentEditable) {
    await locator.click({ timeout: 10_000 });
    await page.keyboard.press("ControlOrMeta+a");
    if (value === "") await page.keyboard.press("Delete");
    else await page.keyboard.insertText(value);
    return;
  }
  await locator.fill(value, { timeout: 10_000 });
}

/**
 * Enter is useful for comboboxes and tag inputs but must never become an
 * undeclared submit path, so form submission is suppressed while it is sent.
 */
async function withSubmitGuard(action) {
  await page.evaluate(() => {
    window.__openshellSubmitGuard = (event) => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener("submit", window.__openshellSubmitGuard, true);
  }).catch(() => {});
  try {
    await action();
  } finally {
    await page.evaluate(() => {
      if (window.__openshellSubmitGuard) document.removeEventListener("submit", window.__openshellSubmitGuard, true);
      delete window.__openshellSubmitGuard;
    }).catch(() => {});
  }
}

function mutatingClass(classification) {
  for (const candidate of ["edit-profile", "publish-post"]) {
    if (classification.classes.includes(candidate) && guard.allowsClass(candidate)) return candidate;
  }
  return "edit-profile";
}

async function psScroll(body) {
  await requireSurface("read");
  const amount = Number.isFinite(Number(body.amount)) ? Math.min(Math.abs(Number(body.amount)), 5000) : 600;
  chargeOrDeny(["actions"]);
  await page.evaluate(({ direction, amount }) => {
    if (direction === "top") window.scrollTo(0, 0);
    else if (direction === "bottom") window.scrollTo(0, document.body.scrollHeight);
    else window.scrollBy(0, direction === "up" ? -amount : amount);
  }, { direction: String(body.direction), amount }).catch(() => {});
  return { ok: true, url: page.url() };
}

async function psWait(body) {
  await requireSurface("read");
  chargeOrDeny(["actions"]);
  if (typeof body.text === "string" && body.text) {
    await page.getByText(body.text, { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  } else {
    await new Promise((resolve) => setTimeout(resolve, Math.min(Number(body.ms) || 500, 20_000)));
  }
  return { ok: true, url: page.url() };
}

async function psBack() {
  chargeOrDeny(["actions"]);
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  const classification = currentClassification();
  return { ok: true, url: page.url(), surface: summarize(classification) };
}

async function psDialog(body) {
  const action = String(body.action);
  if (!["accept", "dismiss"].includes(action)) throw new ControllerError("invalid_dialog");
  if (!pendingDialog) throw new ControllerError("no_dialog");
  const dialog = pendingDialog;
  pendingDialog = undefined;
  clearTimeout(pendingDialogTimer);
  chargeOrDeny(["actions"]);
  if (action === "accept") await dialog.accept().catch(() => {});
  else await dialog.dismiss().catch(() => {});
  return { ok: true, url: page.url() };
}

async function psUpload(body) {
  if ((await pageContext()).humanRequired) throw new ControllerError("manual_takeover_required");
  if (typeof body.stageId !== "string" || !STAGE_PATTERN.test(body.stageId)) throw new ControllerError("invalid_stage");
  const { locator, info } = await describeRef(body.ref);
  const { classification } = await requireSurface(mutatingClass(currentClassification()), info.dialogName);
  const budget = guard.checkBudget(["actions", "uploads"]);
  if (budget) throw new ControllerError(budget);
  if (info.type !== "file") throw new ControllerError("not_a_file_input");
  await mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});
  await locator.setInputFiles(join(UPLOAD_DIR, body.stageId), { timeout: 15_000 });
  guard.charge(["actions", "uploads"]);
  return { ok: true, url: page.url(), surface: summarize(classification) };
}

async function psCheckpoint(body) {
  await requireSurface("read");
  const refs = Array.isArray(body.refs) ? body.refs : [];
  const fields = [];
  for (const ref of refs) {
    const { info } = await describeRef(ref);
    if (!info.editable) throw new ControllerError("not_editable");
    if (uploadRefs.has(ref)) throw new ControllerError("upload_not_checkpointable");
    fields.push({ ref, name: info.name, value: await readValue(ref) });
  }
  const checkpointId = randomUUID();
  checkpoints.set(checkpointId, { generation, url: page.url(), fields });
  chargeOrDeny(["actions"]);
  return { ok: true, checkpointId, generation, fields };
}

async function readValue(ref) {
  const locator = page.locator(`[data-osref="${ref}"]`).first();
  return locator.evaluate((node) => {
    const tag = node.tagName.toLowerCase();
    if (tag === "select") return node.selectedOptions?.[0]?.label ?? "";
    if (node.isContentEditable) return node.innerText ?? "";
    if (node.type === "checkbox" || node.type === "radio") return node.checked ? "checked" : "unchecked";
    return node.value ?? "";
  }).then((value) => String(value).slice(0, 4000)).catch(() => "");
}

function normalize(value) {
  return String(value).normalize("NFC").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * A submit or publish only commits when the observed field diff is exactly the
 * diff the worker declared: no undeclared field, no missing field, no other
 * value. Everything else is a denial that feeds the circuit breaker.
 */
async function psSubmit(body) {
  const intent = String(body.intent);
  const actionClass = intent === "publish-post" ? "publish-post" : "submit-profile";
  if ((await pageContext()).humanRequired) throw new ControllerError("manual_takeover_required");
  const commit = await describeRef(body.ref);
  const { classification, context } = await requireSurface(actionClass, commit.info.dialogName);
  const checkpoint = checkpoints.get(String(body.checkpointId));
  if (!checkpoint) throw new ControllerError("unknown_checkpoint");
  if (checkpoint.generation !== generation) throw new ControllerError("stale_checkpoint");
  const budget = guard.checkBudget(intent === "publish-post" ? ["actions", "publishes"] : ["actions", "submits"]);
  if (budget) throw new ControllerError(budget);

  const declared = new Map();
  for (const entry of body.expected ?? []) declared.set(entry.ref, entry);

  const observedRefs = new Set([...baseline.keys(), ...checkpoint.fields.map((field) => field.ref)].filter((ref) => !uploadRefs.has(ref)));
  const before = new Map(baseline);
  for (const field of checkpoint.fields) before.set(field.ref, field.value);

  const observed = [];
  for (const ref of observedRefs) {
    const current = await readValue(ref);
    if (normalize(current) !== normalize(before.get(ref) ?? "")) {
      observed.push({ ref, before: before.get(ref) ?? "", after: current });
    }
  }

  const observedRefsChanged = new Set(observed.map((entry) => entry.ref));
  for (const entry of observed) {
    const expectation = declared.get(entry.ref);
    if (!expectation) throw new ControllerError("diff_mismatch");
    if (normalize(expectation.after) !== normalize(entry.after)) throw new ControllerError("diff_mismatch");
    if (normalize(expectation.before) !== normalize(entry.before)) throw new ControllerError("diff_mismatch");
  }
  for (const ref of declared.keys()) {
    if (!observedRefsChanged.has(ref)) throw new ControllerError("diff_mismatch");
  }

  const { locator, info } = commit;
  if (!info.submitControl && !isCommitControl(info.name)) throw new ControllerError("not_a_commit_control");
  if (context.dialogNames.length > 0 && !info.inDialog && !classification.allowInlineEdit) throw new ControllerError("commit_outside_dialog");

  const names = new Map(checkpoint.fields.map((field) => [field.ref, field.name]));
  const changes = observed.map((entry) => ({ field: names.get(entry.ref) ?? entry.ref, before: entry.before, after: entry.after }));
  await locator.click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  guard.charge(intent === "publish-post" ? ["actions", "publishes"] : ["actions", "submits"]);
  const url = page.url();
  const after = classifyUrl(url);
  const permalink = permalinkFor(after.permalinkPatterns.length ? after : classification, url);
  const closed = await page.evaluate(() => !document.querySelector('[role="dialog"],dialog[open]')).catch(() => undefined);
  invalidateRefs();
  return { ok: true, committed: true, intent, url, permalink, dialogClosed: closed, changes, surface: summarize(classification) };
}

async function captureIdentity(origins) {
  const identity = new Map();
  for (const origin of origins) {
    const cookies = await context.cookies(`https://${origin}/`).catch(() => []);
    identity.set(origin, guard.identityTag(origin, cookies.map((cookie) => ({ name: cookie.name, value: cookie.value }))));
  }
  return identity;
}

function jsonBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { reject(new ControllerError("body_too_large")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new ControllerError("invalid_json")); }
    });
    request.on("error", reject);
  });
}

function send(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function bound(value) {
  if (Buffer.byteLength(value, "utf8") <= MAX_TEXT) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > MAX_TEXT) result = result.slice(0, -256);
  return `${result}\n[page text truncated]`;
}

class ControllerError extends Error {
  constructor(code) { super(code); this.code = code; }
}
