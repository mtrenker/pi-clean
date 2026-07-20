import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const queueDir = "/sandbox/.openshell-agent/browser-bridge";
const allowedPaths = new Set(["/navigate", "/snapshot", "/click", "/type", "/press"]);

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!allowedPaths.has(path)) throw new Error("browser_action_denied");
  await mkdir(queueDir, { recursive: true });
  const id = randomUUID();
  const pending = `${queueDir}/${id}.pending`;
  const request = `${queueDir}/${id}.request`;
  const response = `${queueDir}/${id}.response`;
  await writeFile(pending, JSON.stringify({ id, path, body }), { mode: 0o600 });
  await rename(pending, request);
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline) {
      const raw = await readFile(response, "utf8").catch(() => undefined);
      if (!raw) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const envelope = JSON.parse(raw) as { status?: number; body?: unknown };
      const result = envelope.body && typeof envelope.body === "object" ? envelope.body as Record<string, unknown> : {};
      if (typeof envelope.status !== "number" || envelope.status < 200 || envelope.status >= 300) {
        const code = typeof result.code === "string" ? result.code : "browser_action_denied";
        throw new Error(code === "manual_takeover_required"
          ? "This action requires operator confirmation and manual noVNC takeover. Stop and report the human-only step."
          : `Constrained browser controller denied the action: ${code}`);
      }
      return result;
    }
    throw new Error("Constrained browser controller timed out");
  } finally {
    await Promise.all([request, response, pending].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "worker_browser_navigate",
    label: "Sandbox Browser Navigate",
    description: "Navigate the isolated persistent browser to an HTTP(S) URL. CAPTCHA and login challenges require manual takeover.",
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, params) { return text(await call("/navigate", { url: params.url })); },
  });

  pi.registerTool({
    name: "worker_browser_snapshot",
    label: "Sandbox Browser Snapshot",
    description: "Read a bounded text and interactive-element snapshot. Raw cookies, storage, downloads, screenshots, and traces are never exposed.",
    parameters: Type.Object({}),
    async execute() { return text(await call("/snapshot")); },
  });

  pi.registerTool({
    name: "worker_browser_click",
    label: "Sandbox Browser Click",
    description: "Click a non-consequential element. The controller blocks submits and account, application, message, post, purchase, consent, login, and security actions for manual takeover.",
    parameters: Type.Object({ selector: Type.String() }),
    async execute(_id, params) { return text(await call("/click", { selector: params.selector })); },
  });

  pi.registerTool({
    name: "worker_browser_type",
    label: "Sandbox Browser Type",
    description: "Type non-sensitive text. Password, OTP, CAPTCHA, payment, and other sensitive fields are blocked for manual noVNC takeover.",
    parameters: Type.Object({ selector: Type.String(), text: Type.String(), clear: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) { return text(await call("/type", params)); },
  });

  pi.registerTool({
    name: "worker_browser_press",
    label: "Sandbox Browser Press",
    description: "Press a navigation key only; Enter is blocked because it can submit consequential forms.",
    parameters: Type.Object({ key: StringEnum(["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"] as const) }),
    async execute(_id, params) { return text(await call("/press", { key: params.key })); },
  });
}
