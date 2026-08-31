/**
 * Cloudflare Browser Run - the only module that imports playwright-core
 *
 * The import is dynamic and happens on the first connect, so a Pi session that
 * never opens a browser does not pay for loading Playwright. Everything else in
 * the extension works against the structural interfaces in session.ts, which
 * keeps the session logic testable without a browser.
 *
 * playwright-core lives in `dependencies` rather than `devDependencies` because
 * Pi package installs run `npm install --omit=dev`.
 */

import type { BrowserLike } from "./session.ts";

export interface ConnectOptions {
  endpoint: string;
  token: string;
  slowMo?: number;
  timeoutMs?: number;
}

export async function connectOverCdp(options: ConnectOptions): Promise<BrowserLike> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(options.endpoint, {
    headers: { Authorization: `Bearer ${options.token}` },
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  return browser as unknown as BrowserLike;
}
