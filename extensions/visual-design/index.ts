import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  withFileMutationQueue,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildClientAssets } from "./assets.js";
import type { DesignMutation } from "./design.js";
import { VisualDesignServer, type BrowserPrompt } from "./server.js";

const mutationSchema = Type.Object({
  action: StringEnum(["add", "move", "remove", "update_text", "update_properties"] as const),
  nodeId: Type.Optional(Type.String({ description: "Stable ID of the node to change" })),
  parentId: Type.Optional(Type.String({ description: "Stable ID of the destination container; omit for root" })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based destination index" })),
  node: Type.Optional(Type.Any({ description: "Complete validated node for add" })),
  text: Type.Optional(Type.String({ description: "Replacement text for update_text" })),
  properties: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "Properties to merge for update_properties; null removes a property",
  })),
});

type MutationInput = {
  action: "add" | "move" | "remove" | "update_text" | "update_properties";
  nodeId?: string;
  parentId?: string;
  index?: number;
  node?: unknown;
  text?: string;
  properties?: Record<string, unknown>;
};

const visualDesignExtension: ExtensionFactory = (pi) => {
  let runtime: VisualDesignServer | undefined;
  let currentContext: ExtensionContext | undefined;

  pi.registerCommand("design", {
    description: "Start the visual design relay: /design <path.design.json> | status | stop",
    async handler(args, ctx) {
      currentContext = ctx;
      const command = args.trim();
      if (command === "status") {
        ctx.ui.notify(runtime ? `Design relay: ${runtime.url}` : "Design relay is not running", "info");
        return;
      }
      if (command === "stop") {
        await stopRuntime();
        ctx.ui.setStatus("visual-design", undefined);
        ctx.ui.notify("Design relay stopped", "info");
        return;
      }

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before opening a repository design file", "error");
        return;
      }

      const requestedPath = command || "designs/example.design.json";
      try {
        const designPath = await resolveDesignPath(ctx.cwd, requestedPath);
        if (runtime && runtime.store.path === designPath) {
          ctx.ui.notify(`Design relay already running: ${runtime.url}`, "info");
          return;
        }

        await stopRuntime();
        ctx.ui.setStatus("visual-design", "building browser client…");
        const assets = await buildClientAssets();
        const server = new VisualDesignServer({
          root: await realpath(ctx.cwd),
          designPath,
          ...assets,
          onPrompt: (prompt) => deliverPrompt(prompt),
        });
        runtime = server;
        await server.start();
        ctx.ui.setStatus("visual-design", "relay live");
        ctx.ui.notify(`Visual design relay ready\n${server.url}`, "info");
      } catch (error) {
        await stopRuntime();
        ctx.ui.setStatus("visual-design", undefined);
        ctx.ui.notify(`Could not start design relay: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "visual_design_mutate",
    label: "Mutate Visual Design",
    description:
      "Apply one validated add, move, remove, text, or property mutation to the active visual design. " +
      "The tool preserves stable IDs, serializes deterministically, and notifies the browser. Start /design first.",
    promptSnippet: "Mutate the active repo-native visual design through validated node operations",
    promptGuidelines: [
      "Use visual_design_mutate instead of write or edit when changing the active .design.json artifact.",
      "Use stable node IDs from the browser context with visual_design_mutate; never rely on stale Slate paths.",
    ],
    parameters: mutationSchema,
    async execute(_toolCallId, params) {
      if (!runtime) throw new Error("No active design. Ask the user to run /design <path.design.json> first.");
      const mutation = toMutation(params as MutationInput);
      const active = runtime;
      const path = active.store.path;
      return withFileMutationQueue(path, async () => {
        const document = await active.store.mutate(mutation);
        return {
          content: [{ type: "text", text: `${mutation.action} applied to ${relative(currentContext?.cwd ?? "", path)}` }],
          details: { action: mutation.action, path, title: document.title },
        };
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentContext = ctx;
    runtime?.broadcast({ type: "agent-status", status: "working", message: "Pi is working…" });
  });

  pi.on("message_update", async (event, ctx) => {
    currentContext = ctx;
    const text = assistantText(event.message);
    if (text) runtime?.broadcast({ type: "agent-output", text });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    currentContext = ctx;
    runtime?.broadcast({ type: "agent-status", status: "idle", message: "Pi is ready" });
  });

  pi.on("session_shutdown", async () => {
    await stopRuntime();
    currentContext = undefined;
  });

  async function deliverPrompt({ packet, behavior }: BrowserPrompt): Promise<void> {
    const ctx = currentContext;
    if (!ctx) throw new Error("Pi session is not ready");
    const prompt = [
      "A visual design request arrived from the local browser.",
      "Use visual_design_mutate for artifact changes; do not rewrite the design JSON directly.",
      "After applying appropriate mutations, briefly explain the result and any className limitations.",
      "",
      "Context packet:",
      JSON.stringify(packet, null, 2),
    ].join("\n");
    if (ctx.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: behavior });
  }

  async function stopRuntime(): Promise<void> {
    const active = runtime;
    runtime = undefined;
    if (active) await active.stop();
  }
};

function toMutation(input: MutationInput): DesignMutation {
  switch (input.action) {
    case "add":
      if (input.node === undefined) throw new Error("add requires node");
      return { action: "add", node: input.node, parentId: input.parentId, index: input.index };
    case "move":
      return { action: "move", nodeId: required(input.nodeId, "move requires nodeId"), parentId: input.parentId, index: input.index };
    case "remove":
      return { action: "remove", nodeId: required(input.nodeId, "remove requires nodeId") };
    case "update_text":
      return {
        action: "update_text",
        nodeId: required(input.nodeId, "update_text requires nodeId"),
        text: required(input.text, "update_text requires text"),
      };
    case "update_properties":
      if (!input.properties) throw new Error("update_properties requires properties");
      return {
        action: "update_properties",
        nodeId: required(input.nodeId, "update_properties requires nodeId"),
        properties: input.properties,
      };
  }
}

async function resolveDesignPath(root: string, requestedPath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(resolve(canonicalRoot, requestedPath.replace(/^@/, "")));
  const relation = relative(canonicalRoot, candidate);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("Design path must stay inside the current repository");
  if (!candidate.endsWith(".design.json")) throw new Error("Design path must end in .design.json");
  return candidate;
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default visualDesignExtension;
