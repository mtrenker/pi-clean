#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "/opt/openshell-browser/node_modules/playwright-core/index.mjs";

const PORT = 3010;
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 20 * 1024;
const HIGH_RISK = /(?:log\s*in|sign\s*in|password|passcode|one[- ]time|2fa|mfa|captcha|apply|application|submit|send|message|post|publish|purchase|buy|checkout|payment|accept|agree|terms|consent|delete|profile|account|bio|resume|curriculum|phone|address)/i;
const SENSITIVE_FIELD = /^(?:password|hidden|file)$/i;

const context = await chromium.launchPersistentContext("/var/lib/openshell-browser/profile", {
  headless: false,
  // OpenShell applies no_new_privs and blocks Chromium's nested namespace/setuid
  // sandbox. This browser therefore runs only in its dedicated agent-free
  // OpenShell sandbox; the untrusted Pi worker is in a separate sandbox.
  chromiumSandbox: false,
  viewport: null,
  args: [
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--host-resolver-rules=MAP android.clients.google.com ~NOTFOUND, MAP accounts.google.com ~NOTFOUND, MAP www.google.com ~NOTFOUND, MAP clients2.google.com ~NOTFOUND",
  ],
});
const page = context.pages()[0] ?? await context.newPage();
const controlSecretPath = "/var/lib/openshell-browser/.control-secret";
let controlSecret = await readFile(controlSecretPath, "utf8").then((value) => value.trim()).catch(() => undefined);
let paused = false;
let vncProcess;
const usedNonces = new Set();
await startVnc(controlSecret ? deriveVncPassword() : randomBytes(8).toString("hex").slice(0, 8));

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, paused });
    if (request.method !== "POST" && url.pathname !== "/snapshot") return send(response, 405, { code: "method_not_allowed" });
    if (request.method === "POST" && url.pathname === "/control/initialize") {
      const body = await jsonBody(request);
      if (controlSecret) throw new ControllerError("already_initialized");
      if (typeof body.secret !== "string" || !/^[a-zA-Z0-9_-]{40,64}$/.test(body.secret)) throw new ControllerError("invalid_control_secret");
      controlSecret = body.secret;
      await writeFile(controlSecretPath, `${controlSecret}\n`, { mode: 0o600 });
      await startVnc(deriveVncPassword());
      return send(response, 200, { ok: true });
    }
    if (request.method === "POST" && (url.pathname === "/control/pause" || url.pathname === "/control/resume")) {
      const action = url.pathname.endsWith("pause") ? "pause" : "resume";
      const body = await jsonBody(request);
      authorizeControl(body, action);
      if (action === "pause") {
        paused = true;
      } else {
        paused = false;
      }
      return send(response, 200, { ok: true, automation: paused ? "paused" : "active" });
    }
    if (paused) throw new ControllerError("automation_paused");
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

server.listen(PORT, "127.0.0.1");

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
  const authPath = "/var/lib/openshell-browser/.vnc-auth";
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
    env: { ...process.env, XAUTHORITY: "/var/lib/openshell-browser/.Xauthority" },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

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
  if (typeof body.text !== "string" || Buffer.byteLength(body.text) > MAX_BODY) throw new ControllerError("invalid_text");
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
