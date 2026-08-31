/**
 * Cloudflare Browser Run — endpoint construction
 *
 * The one place that builds Cloudflare URLs. Cloudflare's naming currently mixes
 * `/browser-rendering` and `/browser-run`; keeping construction here means a
 * correction is one constant rather than a search across modules.
 *
 * The account id appears in every path. It is registered as a secret value in
 * `SecretRegistry`, so `redact` removes it from any error or log line that
 * embeds a request URL.
 */

import { BrowserRunError } from "./errors.ts";

export const API_BASE = "https://api.cloudflare.com/client/v4";

/** Cloudflare's REST path segment for this product. Verified against the live API. */
export const SERVICE_SEGMENT = "browser-rendering";

export const QUICK_ACTIONS = [
  "content",
  "screenshot",
  "pdf",
  "markdown",
  "snapshot",
  "accessibilityTree",
  "scrape",
  "json",
  "links",
] as const;

export type QuickAction = (typeof QUICK_ACTIONS)[number];

function accountBase(accountId: string): string {
  const trimmed = accountId.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(trimmed)) {
    throw new BrowserRunError(
      "credentials_rejected",
      "the resolved account id is not in the expected format",
    );
  }
  return `${API_BASE}/accounts/${trimmed}/${SERVICE_SEGMENT}`;
}

export function quickActionUrl(accountId: string, action: QuickAction): string {
  if (!QUICK_ACTIONS.includes(action)) {
    throw new BrowserRunError("invalid_request", `unknown quick action ${action}`);
  }
  return `${accountBase(accountId)}/${action}`;
}

export function crawlUrl(accountId: string, jobId?: string): string {
  const base = `${accountBase(accountId)}/crawl`;
  if (jobId === undefined) return base;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new BrowserRunError("invalid_request", `crawl job id "${jobId}" is not well formed`);
  }
  return `${base}/${jobId}`;
}

/** The CDP websocket endpoint Playwright connects to. `keepAliveMs` is Cloudflare's idle extension. */
export function cdpWebSocketUrl(accountId: string, keepAliveMs: number): string {
  const base = accountBase(accountId).replace(/^https:/, "wss:");
  return `${base}/devtools/browser?keep_alive=${Math.floor(keepAliveMs)}`;
}

// Cloudflare documents DELETE /devtools/browser/{session_id} for releasing a
// session explicitly. It is not reachable from here: `chromium.connectOverCDP`
// opens the websocket directly and never surfaces the session id Cloudflare
// assigned, so there is nothing to put in that path. Closing the Playwright
// browser handle drops the websocket, and the idle timer does the rest. See
// DESIGN.md section 10.1.
