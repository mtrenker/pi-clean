import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { relative } from "node:path";
import type { AddressInfo } from "node:net";

import {
  applyDesignMutation,
  createContextPacket,
  readDesign,
  serializeDesign,
  writeDesign,
  type DesignContextPacket,
  type DesignDocument,
  type DesignMutation,
} from "./design.ts";

export type BrowserPrompt = {
  packet: DesignContextPacket;
  behavior: "steer" | "followUp";
};

export type DesignServerEvent =
  | { type: "design"; document: DesignDocument; source: "initial" | "mutation" | "external" }
  | { type: "design-error"; message: string }
  | { type: "agent-status"; status: "idle" | "working" | "queued"; message?: string }
  | { type: "agent-output"; text: string };

export type VisualDesignServerOptions = {
  root: string;
  designPath: string;
  clientScript: string;
  styleSheet: string;
  token?: string;
  onPrompt: (prompt: BrowserPrompt) => void | Promise<void>;
};

type StoreListener = (event: DesignServerEvent) => void;

export class DesignStore {
  readonly path: string;
  private documentValue!: DesignDocument;
  private readonly listeners = new Set<StoreListener>();
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private lastWritten = "";
  private stopped = false;

  constructor(path: string) {
    this.path = path;
  }

  get document(): DesignDocument {
    return structuredClone(this.documentValue);
  }

  async start(): Promise<void> {
    this.documentValue = await readDesign(this.path);
    this.lastWritten = serializeDesign(this.documentValue);
    this.watcher = watch(this.path, () => this.scheduleReload());
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async mutate(mutation: DesignMutation): Promise<DesignDocument> {
    if (this.stopped) throw new Error("Design store is stopped");
    const current = await readDesign(this.path);
    const next = applyDesignMutation(current, mutation);
    const serialized = serializeDesign(next);
    await writeDesign(this.path, next);
    this.documentValue = next;
    this.lastWritten = serialized;
    this.emit({ type: "design", document: this.document, source: "mutation" });
    return this.document;
  }

  stop(): void {
    this.stopped = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reloadExternal();
    }, 60);
  }

  private async reloadExternal(): Promise<void> {
    try {
      const document = await readDesign(this.path);
      const serialized = serializeDesign(document);
      if (serialized === this.lastWritten) return;
      this.documentValue = document;
      this.lastWritten = serialized;
      this.emit({ type: "design", document: this.document, source: "external" });
    } catch (error) {
      this.emit({ type: "design-error", message: errorMessage(error) });
    }
  }

  private emit(event: DesignServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class VisualDesignServer {
  readonly token: string;
  readonly store: DesignStore;
  private readonly options: VisualDesignServerOptions;
  private readonly clients = new Set<ServerResponse>();
  private server: Server | undefined;
  private unsubscribeStore: (() => void) | undefined;
  private urlValue: string | undefined;

  constructor(options: VisualDesignServerOptions) {
    this.options = options;
    this.token = options.token ?? randomBytes(24).toString("base64url");
    this.store = new DesignStore(options.designPath);
  }

  get url(): string {
    if (!this.urlValue) throw new Error("Design server has not started");
    return this.urlValue;
  }

  async start(): Promise<string> {
    if (this.server) return this.url;
    await this.store.start();
    this.unsubscribeStore = this.store.subscribe((event) => this.broadcast(event));
    this.server = createServer((request, response) => {
      void this.handleRequest(request.url ?? "/", request.method ?? "GET", request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: errorMessage(error) });
        else response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address() as AddressInfo;
    this.urlValue = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(this.token)}`;
    return this.url;
  }

  broadcast(event: DesignServerEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  async stop(): Promise<void> {
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.store.stop();
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.urlValue = undefined;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  private async handleRequest(
    rawUrl: string,
    method: string,
    request: NodeJS.ReadableStream,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (!this.authorized(url.searchParams.get("token"))) {
      sendJson(response, 403, { error: "Invalid or missing design-session token" });
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      send(response, 200, "text/html; charset=utf-8", htmlShell(this.token));
      return;
    }
    if (method === "GET" && url.pathname === "/app.js") {
      send(response, 200, "text/javascript; charset=utf-8", this.options.clientScript);
      return;
    }
    if (method === "GET" && url.pathname === "/styles.css") {
      send(response, 200, "text/css; charset=utf-8", this.options.styleSheet);
      return;
    }
    if (method === "GET" && url.pathname === "/api/design") {
      sendJson(response, 200, {
        path: relative(this.options.root, this.options.designPath),
        document: this.store.document,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/events") {
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Content-Type-Options": "nosniff",
      });
      response.write(`data: ${JSON.stringify({ type: "design", document: this.store.document, source: "initial" })}\n\n`);
      this.clients.add(response);
      request.once("close", () => this.clients.delete(response));
      return;
    }
    if (method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(request);
      const selectedId = readString(body, "selectedId");
      const instruction = readString(body, "instruction");
      const behavior = body.behavior === "steer" ? "steer" : "followUp";
      const packet = createContextPacket(
        this.store.document,
        relative(this.options.root, this.options.designPath),
        selectedId,
        instruction,
      );
      await this.options.onPrompt({ packet, behavior });
      this.broadcast({ type: "agent-status", status: "queued", message: `${behavior} request accepted` });
      sendJson(response, 202, { accepted: true, behavior });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  }

  private authorized(candidate: string | null): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

async function readJsonBody(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`${key} must be a string`);
  return result;
}

function htmlShell(token: string): string {
  const suffix = `?token=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Design Relay</title>
  <link rel="stylesheet" href="/styles.css${suffix}">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js${suffix}"></script>
</body>
</html>`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
