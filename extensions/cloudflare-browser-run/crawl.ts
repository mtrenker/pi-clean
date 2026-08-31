/**
 * Cloudflare Browser Run - asynchronous crawls
 *
 * Section 16 of DESIGN.md.
 *
 * Cloudflare's own defaults are wrong for this use: `limit` 10 but `depth`
 * 100000, `render` true, and `crawlPurposes` including `ai-train`. This module
 * applies the extension's defaults instead and reports every clamp it makes, so
 * a bounded crawl never looks like the one the model asked for when it was not.
 *
 * `crawlPurposes` is not a tool parameter. It comes from configuration only, so
 * the model cannot widen a declared purpose to get around a site's refusal, and
 * a Content Signals rejection is never retried with a narrower purpose.
 */

import { type CrawlSettings } from "./config.ts";
import { type Credentials } from "./credentials.ts";
import { crawlUrl } from "./endpoints.ts";
import { BrowserRunError, isBrowserRunError } from "./errors.ts";
import { type CloudflareClient } from "./http.ts";
import { type CrawlStatus } from "./registry.ts";

export interface CrawlStartInput {
  url: string;
  limit?: number;
  depth?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  render?: boolean;
}

export interface AppliedCrawl {
  body: Record<string, unknown>;
  /** Human-readable notes about every value that was clamped or refused. */
  clamps: string[];
}

const PATTERN_SHAPE = /^[A-Za-z0-9._~:/?#[\]@!$&'()+,;=%*-]{1,512}$/;

function assertPatterns(patterns: string[] | undefined, field: string): string[] | undefined {
  if (!patterns) return undefined;
  for (const pattern of patterns) {
    if (!PATTERN_SHAPE.test(pattern)) {
      throw new BrowserRunError(
        "invalid_request",
        `${field} entry "${pattern}" is not a URL wildcard pattern. Use * and ** rather than a regular expression.`,
      );
    }
  }
  return patterns;
}

/**
 * Build the request body from the extension's defaults, clamping anything the
 * model asked for that exceeds a configured bound.
 */
export function buildCrawlBody(input: CrawlStartInput, settings: CrawlSettings): AppliedCrawl {
  const clamps: string[] = [];

  let limit = input.limit ?? settings.defaultLimit;
  if (limit > settings.maxLimit) {
    clamps.push(`limit ${limit} clamped to ${settings.maxLimit}`);
    limit = settings.maxLimit;
  }
  if (limit < 1) limit = 1;

  let depth = input.depth ?? settings.defaultDepth;
  if (depth > settings.defaultDepth) {
    clamps.push(`depth ${depth} clamped to ${settings.defaultDepth}`);
    depth = settings.defaultDepth;
  }
  if (depth < 0) depth = 0;

  let render = input.render ?? false;
  if (render && !settings.allowRenderedCrawl) {
    clamps.push(
      "render was refused: rendered crawls are metered, so they need allowRenderedCrawl in the configuration",
    );
    render = false;
  }

  const body: Record<string, unknown> = {
    url: input.url,
    formats: ["markdown"],
    limit,
    depth,
    render,
    crawlPurposes: [...settings.crawlPurposes],
    options: {
      includeExternalLinks: false,
      includeSubdomains: false,
      ...(input.includePatterns
        ? { includePatterns: assertPatterns(input.includePatterns, "include_patterns") }
        : {}),
      ...(input.excludePatterns
        ? { excludePatterns: assertPatterns(input.excludePatterns, "exclude_patterns") }
        : {}),
    },
  };
  return { body, clamps };
}

export interface CrawlPageRecord {
  url: string;
  status: string;
  markdown?: string;
  metadata?: { status?: number; title?: string; url?: string };
}

export interface CrawlReadResult {
  status: CrawlStatus | undefined;
  browserSecondsUsed: number | null;
  cursor: string | null;
  records: CrawlPageRecord[];
  total: number | null;
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Parse a crawl read tolerantly.
 *
 * The documented record fields are `url`, `status`, `markdown`, `html`, and
 * `metadata`, but the envelope around them is not pinned by the published docs,
 * so the container key is accepted under several names. DESIGN.md section 2.4
 * records this as a check for the first live run.
 */
export function parseCrawlRead(raw: unknown): CrawlReadResult {
  const record = (raw ?? {}) as Record<string, unknown>;
  const rawRecords = firstArray(record, ["results", "records", "urls", "pages", "data"]);

  const records: CrawlPageRecord[] = rawRecords
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const metadata = (entry["metadata"] ?? {}) as Record<string, unknown>;
      const page: CrawlPageRecord = {
        url: (entry["url"] as string) ?? (metadata["url"] as string) ?? "",
        status: (entry["status"] as string) ?? "unknown",
      };
      if (typeof entry["markdown"] === "string") page.markdown = entry["markdown"];
      if (Object.keys(metadata).length > 0) {
        page.metadata = {
          ...(typeof metadata["status"] === "number" ? { status: metadata["status"] } : {}),
          ...(typeof metadata["title"] === "string" ? { title: metadata["title"] } : {}),
          ...(typeof metadata["url"] === "string" ? { url: metadata["url"] } : {}),
        };
      }
      return page;
    });

  return {
    status: firstString(record, ["status", "jobStatus", "state"]) as CrawlStatus | undefined,
    browserSecondsUsed: firstNumber(record, ["browserSecondsUsed", "browser_seconds_used"]) ?? null,
    cursor: firstString(record, ["cursor", "nextCursor"]) ?? null,
    records,
    total: firstNumber(record, ["total", "count", "pagesSeen"]) ?? null,
  };
}

export async function startCrawl(
  client: CloudflareClient,
  credentials: Credentials,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const url = credentials.accountId.use((id) => crawlUrl(id));
  let response;
  try {
    response = await client.request<unknown>({
      method: "POST",
      url,
      token: credentials.token,
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw refineCrawlError(error, body["crawlPurposes"] as string[] | undefined);
  }

  const result = response.result as Record<string, unknown> | string;
  const jobId =
    typeof result === "string"
      ? result
      : firstString(result ?? {}, ["jobId", "job_id", "id", "jobID"]);
  if (!jobId) {
    throw new BrowserRunError("upstream_error", "the crawl endpoint returned no job id");
  }
  return jobId;
}

export interface CrawlReadQuery {
  cursor?: string;
  limit?: number;
  status?: string;
}

export async function readCrawl(
  client: CloudflareClient,
  credentials: Credentials,
  jobId: string,
  query: CrawlReadQuery = {},
  signal?: AbortSignal,
): Promise<CrawlReadResult> {
  const base = credentials.accountId.use((id) => crawlUrl(id, jobId));
  const search = new URLSearchParams();
  if (query.cursor) search.set("cursor", query.cursor);
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  if (query.status) search.set("status", query.status);
  const url = search.size > 0 ? `${base}?${search.toString()}` : base;

  const response = await client.request<unknown>({
    method: "GET",
    url,
    token: credentials.token,
    ...(signal ? { signal } : {}),
  });
  return parseCrawlRead(response.result);
}

export async function cancelCrawl(
  client: CloudflareClient,
  credentials: Credentials,
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = credentials.accountId.use((id) => crawlUrl(id, jobId));
  await client.request<unknown>({
    method: "DELETE",
    url,
    token: credentials.token,
    ...(signal ? { signal } : {}),
  });
}

/**
 * A 400 that names Content Signals is its own class, and it is never retried
 * with a narrower purpose. Auto-narrowing would turn a site's refusal into a
 * negotiation the site never agreed to have.
 */
export function refineCrawlError(error: unknown, purposes: string[] | undefined): unknown {
  if (!isBrowserRunError(error) || error.errorClass !== "invalid_request") return error;
  if (!/content[- ]?signal/i.test(error.detail)) return error;
  return new BrowserRunError(
    "content_signals_declined",
    `the site's Content Signals refuse the declared ${
      purposes && purposes.length > 0 ? `purpose ${purposes.join(", ")}` : "crawl purpose"
    }. This is not retried with a narrower purpose. Read the pages you need with browser_read instead.`,
    { cause: error },
  );
}
