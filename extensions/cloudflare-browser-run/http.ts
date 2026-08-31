/**
 * Cloudflare Browser Run — authenticated transport
 *
 * Section 5.5 and 10.3 of DESIGN.md: one error class per failure, a shared token
 * bucket so the stateless tools cannot burst past Cloudflare's per-second limits,
 * and bounded retries. Only 429 and 5xx retry. A 401 never retries, and a 400
 * never retries, because both mean the request itself was wrong.
 */

import { type Secret } from "./credentials.ts";
import { BrowserRunError, errorMessage, type ErrorClass } from "./errors.ts";
import { redact, type SecretRegistry } from "./redact.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpDeps {
  fetch: FetchFn;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  registry?: SecretRegistry;
}

export interface HttpOptions {
  /** Conservative default: well under the documented 30 rps paid limit. */
  requestsPerSecond?: number;
  maxRetries?: number;
}

export interface CloudflareResult<T> {
  result: T;
  /** Value of the `X-Browser-Ms-Used` response header, when present. */
  browserMs?: number;
}

export interface RequestSpec {
  method: "GET" | "POST" | "DELETE";
  url: string;
  token: Secret;
  body?: unknown;
  signal?: AbortSignal;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BrowserRunError("upstream_error", "request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BrowserRunError("upstream_error", "request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyStatus(status: number): { errorClass: ErrorClass; retryable: boolean } {
  if (status === 401 || status === 403) return { errorClass: "credentials_rejected", retryable: false };
  if (status === 404) return { errorClass: "job_not_found", retryable: false };
  if (status === 408) return { errorClass: "upstream_error", retryable: true };
  if (status === 429) return { errorClass: "rate_limited", retryable: true };
  if (status >= 500) return { errorClass: "upstream_error", retryable: true };
  return { errorClass: "invalid_request", retryable: false };
}

/** Pull a human-usable message out of Cloudflare's error envelope without echoing the whole body. */
export function summarizeErrorBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      errors?: Array<{ code?: number; message?: string }>;
      messages?: Array<{ message?: string }>;
    };
    const messages = [
      ...(parsed.errors ?? []).map((entry) => entry.message).filter(Boolean),
      ...(parsed.messages ?? []).map((entry) => entry.message).filter(Boolean),
    ];
    if (messages.length > 0) return messages.join("; ").slice(0, 400);
  } catch {
    // Not an envelope. Fall through to the raw prefix.
  }
  return trimmed.slice(0, 400);
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  const base = 500 * 2 ** attempt;
  return Math.min(base + Math.floor(Math.random() * 250), 30_000);
}

/**
 * Serializes outbound requests to a fixed rate. A token bucket rather than a
 * queue depth: the stateless tools are allowed to wait, unlike browser actions,
 * which reject deterministically instead (DESIGN.md section 10.3).
 */
class RateLimiter {
  #nextAvailableAt = 0;
  readonly #intervalMs: number;
  readonly #deps: HttpDeps;

  constructor(deps: HttpDeps, requestsPerSecond: number) {
    this.#deps = deps;
    this.#intervalMs = Math.ceil(1000 / Math.max(requestsPerSecond, 0.01));
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const now = this.#deps.now();
    const readyAt = Math.max(now, this.#nextAvailableAt);
    this.#nextAvailableAt = readyAt + this.#intervalMs;
    const wait = readyAt - now;
    if (wait > 0) await this.#deps.sleep(wait, signal);
  }
}

export class CloudflareClient {
  readonly #deps: HttpDeps;
  readonly #limiter: RateLimiter;
  readonly #maxRetries: number;
  #lastBrowserMs: number | undefined;

  constructor(deps: HttpDeps, options: HttpOptions = {}) {
    this.#deps = deps;
    this.#limiter = new RateLimiter(deps, options.requestsPerSecond ?? 2);
    this.#maxRetries = options.maxRetries ?? 2;
  }

  /** Browser milliseconds reported by the most recent response, for cost reporting. */
  get lastBrowserMs(): number | undefined {
    return this.#lastBrowserMs;
  }

  async request<T>(spec: RequestSpec): Promise<CloudflareResult<T>> {
    let attempt = 0;
    for (;;) {
      await this.#limiter.acquire(spec.signal);
      const response = await this.#send(spec);

      if (response.ok) return this.#readSuccess<T>(response);

      const { errorClass, retryable } = classifyStatus(response.status);
      const bodyText = await response.text().catch(() => "");
      const summary = redact(summarizeErrorBody(bodyText), this.#deps.registry);

      if (retryable && attempt < this.#maxRetries) {
        await this.#deps.sleep(retryAfterMs(response, attempt), spec.signal);
        attempt += 1;
        continue;
      }

      const detail =
        errorClass === "rate_limited"
          ? `Cloudflare rate limited this request after ${attempt} retries`
          : `Cloudflare returned ${response.status}${summary ? `: ${summary}` : ""}`;
      throw new BrowserRunError(errorClass, detail, { retryable });
    }
  }

  async #send(spec: RequestSpec): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (spec.body !== undefined) headers["content-type"] = "application/json";
    // The token is materialized only for the duration of the call.
    const init: RequestInit = spec.token.use((token) => ({
      method: spec.method,
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      signal: spec.signal,
    }));

    try {
      return await this.#deps.fetch(spec.url, init);
    } catch (error) {
      throw new BrowserRunError(
        "upstream_error",
        `the request to Cloudflare failed: ${redact(errorMessage(error), this.#deps.registry)}`,
        { cause: error, retryable: true },
      );
    }
  }

  async #readSuccess<T>(response: Response): Promise<CloudflareResult<T>> {
    const header = response.headers.get("x-browser-ms-used");
    const browserMs = header ? Number.parseFloat(header) : undefined;
    this.#lastBrowserMs = Number.isFinite(browserMs) ? browserMs : undefined;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BrowserRunError("upstream_error", "Cloudflare returned a non-JSON response", {
        cause: error,
      });
    }

    const envelope = parsed as { success?: boolean; result?: unknown };
    if (envelope && typeof envelope === "object" && "success" in envelope) {
      if (envelope.success === false) {
        const summary = redact(summarizeErrorBody(text), this.#deps.registry);
        throw new BrowserRunError(
          "upstream_error",
          `Cloudflare reported failure${summary ? `: ${summary}` : ""}`,
        );
      }
      const result: CloudflareResult<T> = { result: envelope.result as T };
      if (this.#lastBrowserMs !== undefined) result.browserMs = this.#lastBrowserMs;
      return result;
    }

    const result: CloudflareResult<T> = { result: parsed as T };
    if (this.#lastBrowserMs !== undefined) result.browserMs = this.#lastBrowserMs;
    return result;
  }
}
