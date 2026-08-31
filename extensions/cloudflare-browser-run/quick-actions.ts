/**
 * Cloudflare Browser Run - stateless Quick Action calls
 *
 * Only `/markdown` is used in this slice. The other Quick Actions add surface
 * without a demonstrated need (DESIGN.md section 20).
 *
 * This module deliberately does not expose the endpoint's `cookies`,
 * `authenticate`, or `setExtraHTTPHeaders` parameters. The only credentials the
 * model could put there are ones it must never hold; authenticated reading goes
 * through a profile-backed CDP session instead.
 */

import { type Credentials } from "./credentials.ts";
import { quickActionUrl } from "./endpoints.ts";
import { BrowserRunError } from "./errors.ts";
import { type CloudflareClient } from "./http.ts";

export const WAIT_UNTIL_VALUES = [
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2",
] as const;

export type WaitUntil = (typeof WAIT_UNTIL_VALUES)[number];

export interface MarkdownRequest {
  url: string;
  waitUntil?: WaitUntil;
  waitForSelector?: string;
  signal?: AbortSignal;
}

export interface MarkdownResult {
  markdown: string;
  browserMs?: number;
}

export function buildMarkdownBody(request: MarkdownRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { url: request.url };
  if (request.waitUntil) body["gotoOptions"] = { waitUntil: request.waitUntil };
  if (request.waitForSelector) body["waitForSelector"] = request.waitForSelector;
  return body;
}

export async function fetchMarkdown(
  client: CloudflareClient,
  credentials: Credentials,
  request: MarkdownRequest,
): Promise<MarkdownResult> {
  const url = credentials.accountId.use((id) => quickActionUrl(id, "markdown"));
  const response = await client.request<unknown>({
    method: "POST",
    url,
    token: credentials.token,
    body: buildMarkdownBody(request),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (typeof response.result !== "string") {
    throw new BrowserRunError("upstream_error", "the markdown endpoint returned no text");
  }
  const result: MarkdownResult = { markdown: response.result };
  if (response.browserMs !== undefined) result.browserMs = response.browserMs;
  return result;
}

/**
 * Health probe.
 *
 * Cloudflare's generic `/user/tokens/verify` returns 401 for a Browser Run token
 * that works, so the probe has to exercise a Browser Run capability. `/markdown`
 * accepts raw `html` instead of a `url`, which needs the same permission as a
 * real call without fetching anyone else's page.
 *
 * DESIGN.md section 2.4 records the open check: whether this form truly makes no
 * outbound request has not been verified against the live account.
 */
export async function probeCredentials(
  client: CloudflareClient,
  credentials: Credentials,
  signal?: AbortSignal,
): Promise<{ browserMs?: number }> {
  const url = credentials.accountId.use((id) => quickActionUrl(id, "markdown"));
  const response = await client.request<unknown>({
    method: "POST",
    url,
    token: credentials.token,
    body: { html: "<h1>pi</h1>" },
    ...(signal ? { signal } : {}),
  });
  return response.browserMs === undefined ? {} : { browserMs: response.browserMs };
}
