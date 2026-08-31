/**
 * Cloudflare Browser Run — error taxonomy
 *
 * Section 5.5 of DESIGN.md defines one class per recoverable failure. The class
 * is the first token of every thrown message so the model can pick a next action
 * instead of parsing prose, and so tests can assert on the class rather than on
 * wording.
 */

export const ERROR_CLASSES = [
  "not_configured",
  "credentials_unavailable",
  "credentials_rejected",
  "rate_limited",
  "quota_exhausted",
  "target_rejected",
  "navigation_failed",
  "session_expired",
  "busy_handoff",
  "busy_queue",
  "busy_closing",
  "no_session",
  "profile_missing",
  "profile_expired",
  "profile_unreadable",
  "content_signals_declined",
  "job_not_found",
  "results_expired",
  "upstream_error",
  "invalid_request",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * Every failure this extension raises. `message` is already scrubbed by the
 * caller when it can contain upstream text; `BrowserRunError` itself never
 * formats a secret because it only ever receives strings the caller built.
 */
export class BrowserRunError extends Error {
  readonly errorClass: ErrorClass;
  readonly detail: string;
  readonly retryable: boolean;

  constructor(errorClass: ErrorClass, detail: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(`${errorClass}: ${detail}`);
    this.name = "BrowserRunError";
    this.errorClass = errorClass;
    this.detail = detail;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isBrowserRunError(value: unknown): value is BrowserRunError {
  return value instanceof BrowserRunError;
}

/** Narrow an unknown thrown value to a message without leaking object internals. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
