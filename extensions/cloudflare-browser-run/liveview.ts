/**
 * Cloudflare Browser Run - Live View delivery and human handoff
 *
 * Section 12 of DESIGN.md.
 *
 * A Live View URL carries a JWT. Anyone holding it within its validity controls
 * the browser, so it must not reach the model, the session file, or a process
 * argument list. Per the sink table in DESIGN.md section 2.3 that rules out tool
 * content, tool details, appendEntry, and sendMessage, and leaves only ephemeral
 * UI. Issue #36 also rules out argv, which rules out `xdg-open "<jwt url>"`.
 *
 * So the URL goes to a one-shot loopback redirector, following the pattern
 * extensions/visual-design/server.ts already established here. The opener
 * receives a single-use, two-minute, loopback-only nonce instead of a JWT.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { platform } from "node:os";

import { BrowserRunError, errorMessage } from "./errors.ts";
import { type CdpSessionLike } from "./session.ts";

export const REDIRECT_TTL_MS = 120_000;
/** Cloudflare documents a 30 minute maximum for a handoff. */
export const HANDOFF_MAX_MS = 30 * 60 * 1000;
/** Cloudflare's own default Live View validity is five minutes. */
export const LIVE_VIEW_DEFAULT_MS = 5 * 60 * 1000;

export interface Redirector {
  /** Loopback URL carrying only the nonce. Safe for argv and for ephemeral UI. */
  url: string;
  wasUsed(): boolean;
  close(): Promise<void>;
}

/**
 * A one-shot loopback redirect to `target`.
 *
 * Binds 127.0.0.1 on an ephemeral port, answers exactly one GET on a random
 * path with a 302, then invalidates the nonce. Expires after its TTL whether or
 * not it was used. The target is never written to disk and never logged.
 */
export async function startRedirector(
  target: string,
  options: { ttlMs?: number } = {},
): Promise<Redirector> {
  const nonce = randomBytes(32).toString("base64url");
  let used = false;
  let closed = false;

  const server: Server = createServer((request, response) => {
    if (!used && request.method === "GET" && request.url === `/${nonce}`) {
      used = true;
      response.writeHead(302, { location: target, "cache-control": "no-store" });
      response.end();
      // One redirect is all this capability is worth.
      setImmediate(() => {
        void close();
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const timer = setTimeout(() => {
    void close();
  }, options.ttlMs ?? REDIRECT_TTL_MS);
  timer.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new BrowserRunError("invalid_request", "the local Live View redirector could not bind");
  }

  return {
    url: `http://127.0.0.1:${address.port}/${nonce}`,
    wasUsed: () => used,
    close,
  };
}

/** Open a loopback URL in the operator's browser. Never called with a JWT URL. */
export function openInBrowser(url: string, osPlatform: string = platform()): boolean {
  const opener =
    osPlatform === "darwin"
      ? { command: "open", args: [url] }
      : osPlatform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  try {
    const child = spawn(opener.command, opener.args, { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", () => undefined);
    return true;
  } catch {
    return false;
  }
}

export type LiveViewMode = "tab" | "full" | "inspector";

/**
 * Ask Cloudflare for a Live View URL.
 *
 * `inspector` mode is deliberately never requested by this extension: it hands
 * the operator a JavaScript console, and arbitrary page JavaScript is a non-goal
 * for this slice.
 */
export async function getLiveViewUrl(
  cdp: CdpSessionLike,
  options: { mode?: Exclude<LiveViewMode, "inspector">; expiresInMs?: number } = {},
): Promise<string> {
  const params: Record<string, unknown> = {
    mode: options.mode ?? "tab",
    expiresInMs: Math.min(options.expiresInMs ?? LIVE_VIEW_DEFAULT_MS, 60 * 60 * 1000),
  };
  let response: unknown;
  try {
    response = await cdp.send("Cloudflare.getLiveView", params);
  } catch (error) {
    throw new BrowserRunError(
      "upstream_error",
      `Cloudflare.getLiveView failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const url = extractUrl(response);
  if (!url) {
    // Never echo the response: it is the capability itself.
    throw new BrowserRunError("upstream_error", "Cloudflare.getLiveView returned no URL");
  }
  return url;
}

function extractUrl(response: unknown): string | undefined {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  for (const key of ["url", "liveViewUrl", "devtoolsFrontendUrl", "inspectorUrl"]) {
    const value = record[key];
    if (typeof value === "string" && value.startsWith("http")) return value;
  }
  return undefined;
}

export interface HandoffOptions {
  instructions: string;
  timeoutMs: number;
  /** Protocol traffic that keeps Cloudflare's idle timer from closing the session. */
  keepAliveMs?: number;
  onKeepAliveError?: (error: unknown) => void;
}

export interface HandoffResult {
  success: boolean;
  reason: string;
}

/**
 * Structured handoff: ask Cloudflare to hand control to a person, then wait for
 * `Cloudflare.handoffComplete`.
 *
 * The keepalive is protocol traffic (`Browser.getVersion`), not page JavaScript.
 * Whether Cloudflare counts it as session activity is the open check recorded in
 * DESIGN.md section 2.4; if it does not, a handoff must finish inside the
 * `keep_alive` window and the operator is told so.
 */
export async function runHandoff(
  cdp: CdpSessionLike,
  options: HandoffOptions,
): Promise<HandoffResult> {
  // Floor and ceiling: a handoff shorter than a second is meaningless, and
  // Cloudflare documents 30 minutes as the maximum.
  const timeoutMs = Math.min(Math.max(options.timeoutMs, 1_000), HANDOFF_MAX_MS);

  let settle: ((result: HandoffResult) => void) | undefined;
  const completed = new Promise<HandoffResult>((resolve) => {
    settle = resolve;
  });

  const onComplete = (payload: unknown): void => {
    const record = (payload ?? {}) as { success?: boolean; status?: string; reason?: string };
    const success = record.success === true || record.status === "completed";
    settle?.({
      success,
      reason: record.reason ?? (success ? "the operator marked the handoff done" : "the operator marked the handoff failed"),
    });
  };

  cdp.on("Cloudflare.handoffComplete", onComplete);
  const keepAlive = setInterval(() => {
    cdp.send("Browser.getVersion").catch((error: unknown) => options.onKeepAliveError?.(error));
  }, options.keepAliveMs ?? 30_000);
  keepAlive.unref?.();

  // Not unref'd: the handoff is a foreground operation, and the timer is cleared
  // in the finally block below.
  const timer = setTimeout(() => {
    settle?.({
      success: false,
      reason: `the handoff timed out after ${Math.round(timeoutMs / 1_000)} seconds`,
    });
  }, timeoutMs);

  try {
    await cdp.send("Cloudflare.handoff", { instructions: options.instructions, timeoutMs });
    return await completed;
  } catch (error) {
    return {
      success: false,
      reason: `Cloudflare.handoff failed: ${errorMessage(error)}`,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(keepAlive);
    cdp.off("Cloudflare.handoffComplete", onComplete);
  }
}
