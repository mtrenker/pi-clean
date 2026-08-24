import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const queueDir = "/sandbox/.openshell-agent/browser-bridge";
const modePath = "/sandbox/.openshell-agent/browser-mode.json";
const safePaths = new Set(["/navigate", "/snapshot", "/click", "/type", "/press"]);
const professionalSocialsPaths = new Set([
  "/ps/navigate", "/ps/snapshot", "/ps/act", "/ps/scroll", "/ps/wait", "/ps/back",
  "/ps/dialog", "/ps/upload", "/ps/checkpoint", "/ps/submit",
]);

function activeMode(): "safe" | "professional-socials" {
  try {
    const parsed = JSON.parse(readFileSync(modePath, "utf8")) as { mode?: string };
    return parsed.mode === "professional-socials" ? "professional-socials" : "safe";
  } catch {
    return "safe";
  }
}

async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!safePaths.has(path) && !professionalSocialsPaths.has(path)) throw new Error("browser_action_denied");
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
        throw new Error(explain(code));
      }
      return result;
    }
    throw new Error("Constrained browser controller timed out");
  } finally {
    await Promise.all([request, response, pending, `${queueDir}/${id}.processing`, `${response}.pending`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

function explain(code: string): string {
  if (code === "manual_takeover_required") {
    return "This action requires operator confirmation and manual noVNC takeover. Stop and report the human-only step.";
  }
  if (code.startsWith("mandate_revoked") || code === "mandate_expired") {
    return `The task authorization is no longer valid (${code}). Stop and report what remains unfinished.`;
  }
  if (code === "diff_mismatch") {
    return "Refused: the observed field changes did not match the declared diff exactly. Take a fresh snapshot, re-read the values, and declare every changed field with its exact before and after value.";
  }
  if (code === "stale_ref" || code === "stale_checkpoint") {
    return "The page changed, so refs and checkpoints from the previous snapshot are gone. Take a new snapshot and start this step again.";
  }
  if (code === "submit_requires_declared_diff") {
    return "This control commits a form. Use worker_browser_submit with a checkpoint and a declared diff instead of clicking it.";
  }
  return `Constrained browser controller denied the action: ${code}`;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} };
}

function registerSafeTools(pi: ExtensionAPI): void {
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

function registerProfessionalSocialsTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "worker_browser_navigate",
    label: "Sandbox Browser Navigate",
    description: "Navigate the isolated persistent browser to an authorized professional-social URL. Login, password, OTP, CAPTCHA, and security surfaces are refused and belong to the operator's noVNC takeover.",
    parameters: Type.Object({ url: Type.String({ description: "https URL on an authorized site" }) }),
    async execute(_id, params) { return text(await call("/ps/navigate", { url: params.url })); },
  });

  pi.registerTool({
    name: "worker_browser_snapshot",
    label: "Sandbox Browser Snapshot",
    description: "Read a bounded snapshot with element refs such as e4-12. Refs are the only way to address elements and expire whenever the page changes. Cookies, storage, downloads, screenshots, traces, and page JavaScript are never exposed.",
    parameters: Type.Object({}),
    async execute() { return text(await call("/ps/snapshot")); },
  });

  pi.registerTool({
    name: "worker_browser_act",
    label: "Sandbox Browser Act",
    description: [
      "Interact with one snapshot ref: click, fill, clear, check, uncheck, select, combobox, edit (contenteditable), or enter.",
      "Controls that would commit a form are refused here; use worker_browser_submit with a declared diff instead.",
    ].join(" "),
    parameters: Type.Object({
      op: StringEnum(["click", "fill", "clear", "check", "uncheck", "select", "combobox", "edit", "enter"] as const),
      ref: Type.String({ description: "Ref from the latest snapshot" }),
      text: Type.Optional(Type.String({ description: "Value for fill and edit" })),
      option: Type.Optional(Type.String({ description: "Visible option label for select and combobox" })),
    }),
    async execute(_id, params) { return text(await call("/ps/act", params)); },
  });

  pi.registerTool({
    name: "worker_browser_scroll",
    label: "Sandbox Browser Scroll",
    description: "Scroll the page so lazily rendered sections become visible. Take a new snapshot afterwards.",
    parameters: Type.Object({
      direction: StringEnum(["up", "down", "top", "bottom"] as const),
      amount: Type.Optional(Type.Number({ description: "Pixels, default 600" })),
    }),
    async execute(_id, params) { return text(await call("/ps/scroll", params)); },
  });

  pi.registerTool({
    name: "worker_browser_wait",
    label: "Sandbox Browser Wait",
    description: "Wait for a single-page-application update, either a bounded delay or until a short text appears.",
    parameters: Type.Object({
      ms: Type.Optional(Type.Number({ description: "Milliseconds, at most 20000" })),
      text: Type.Optional(Type.String({ description: "Text to wait for" })),
    }),
    async execute(_id, params) { return text(await call("/ps/wait", params)); },
  });

  pi.registerTool({
    name: "worker_browser_back",
    label: "Sandbox Browser Back",
    description: "Go back one history entry. All refs from the previous snapshot expire.",
    parameters: Type.Object({}),
    async execute() { return text(await call("/ps/back")); },
  });

  pi.registerTool({
    name: "worker_browser_dialog",
    label: "Sandbox Browser Dialog",
    description: "Accept or dismiss a native browser dialog raised by the page.",
    parameters: Type.Object({ action: StringEnum(["accept", "dismiss"] as const) }),
    async execute(_id, params) { return text(await call("/ps/dialog", params)); },
  });

  pi.registerTool({
    name: "worker_browser_upload",
    label: "Sandbox Browser Upload",
    description: "Attach a file you wrote to the job uploads directory to a file input ref. Only PNG, JPEG, and PDF up to 5 MiB are staged, and the browser-side path is never exposed.",
    parameters: Type.Object({
      ref: Type.String({ description: "Ref of the file input" }),
      artifact: Type.String({ description: "File name inside the job uploads directory" }),
    }),
    async execute(_id, params) { return text(await call("/ps/upload", params)); },
  });

  pi.registerTool({
    name: "worker_browser_checkpoint",
    label: "Sandbox Browser Checkpoint",
    description: "Record the current values of the fields you are about to edit. A checkpoint is required before submitting or publishing and expires when the page changes.",
    parameters: Type.Object({ refs: Type.Array(Type.String(), { description: "Refs of the fields you will edit" }) }),
    async execute(_id, params) { return text(await call("/ps/checkpoint", params)); },
  });

  pi.registerTool({
    name: "worker_browser_submit",
    label: "Sandbox Browser Submit",
    description: [
      "Commit an edit or publish a post. Declare the exact diff you expect: every changed field with its before and after value.",
      "The controller compares the declaration with what it observed and refuses when a field is undeclared, missing, or carries a different value.",
    ].join(" "),
    parameters: Type.Object({
      ref: Type.String({ description: "Ref of the save, submit, or publish control" }),
      checkpointId: Type.String({ description: "Checkpoint recorded before the edits" }),
      intent: StringEnum(["submit-profile", "publish-post"] as const),
      expected: Type.Array(Type.Object({
        ref: Type.String(),
        before: Type.String(),
        after: Type.String(),
      }), { description: "Every field you changed" }),
    }),
    async execute(_id, params) { return text(await call("/ps/submit", params)); },
  });
}

export default function (pi: ExtensionAPI) {
  if (activeMode() === "professional-socials") registerProfessionalSocialsTools(pi);
  else registerSafeTools(pi);
}
