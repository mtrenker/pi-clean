#!/usr/bin/env node
import { randomBytes } from "node:crypto";
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
  executablePath: "/usr/bin/chromium",
  headless: false,
  viewport: null,
  args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
});
const page = context.pages()[0] ?? await context.newPage();
const vncPassword = await ensureVncPassword();
await writeFile("/run/openshell-browser/controller.pid", `${process.pid}\n`, { mode: 0o660 });

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
    if (request.method === "POST" && url.pathname === "/pause") {
      await writeFile("/run/openshell-browser/paused", "manual takeover\n", { mode: 0o660 });
      send(response, 200, { ok: true, automation: "os_suspended", vncPassword });
      // Keep Chromium alive for noVNC, but stop the controller process itself.
      // The root-owned image monitor resumes it only after the host removes the
      // explicit pause marker. No automation or capture can run while stopped.
      setTimeout(() => process.kill(process.pid, "SIGSTOP"), 50);
      return;
    }
    if (request.method === "GET" && url.pathname === "/snapshot") return send(response, 200, await snapshot());
    if (request.method !== "POST") return send(response, 405, { code: "method_not_allowed" });
    const body = await jsonBody(request);
    if (url.pathname === "/navigate") return send(response, 200, await navigate(body));
    if (url.pathname === "/click") return send(response, 200, await click(body));
    if (url.pathname === "/type") return send(response, 200, await typeText(body));
    if (url.pathname === "/press") return send(response, 200, await press(body));
    return send(response, 404, { code: "not_found" });
  } catch (error) {
    const code = error instanceof ControllerError ? error.code : "controller_error";
    send(response, code === "manual_takeover_required" ? 409 : 400, { code });
  }
});

server.listen(PORT, "127.0.0.1");

async function ensureVncPassword() {
  const passwordPath = "/var/lib/openshell-browser/.vnc-password";
  const authPath = "/var/lib/openshell-browser/.vnc-auth";
  let password;
  try { password = (await readFile(passwordPath, "utf8")).trim(); }
  catch {
    password = randomBytes(8).toString("hex").slice(0, 8);
    await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
  }
  spawnSync("x11vnc", ["-storepasswd", password, authPath], { stdio: "ignore" });
  spawn("x11vnc", ["-display", ":99", "-localhost", "-forever", "-shared", "-rfbauth", authPath, "-quiet"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, XAUTHORITY: "/var/lib/openshell-browser/.Xauthority" },
  }).unref();
  return password;
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
