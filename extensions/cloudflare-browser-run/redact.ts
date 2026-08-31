/**
 * Cloudflare Browser Run — outbound scrubbing
 *
 * Section 18 of DESIGN.md: every string leaving the extension passes through
 * `redact`, whether it goes to a tool result, a log line, or the TUI. This is the
 * last line of defense for an error string from fetch or playwright-core that
 * embeds the request URL, which both routinely do.
 *
 * Two mechanisms, deliberately no more:
 *
 *   1. Value redaction for secrets this process actually resolved. Exact string
 *      match, so it cannot corrupt unrelated content.
 *   2. Pattern redaction for carriers that are unambiguous by construction:
 *      `jwt=`, `Bearer `, an Authorization header echo, and the Cloudflare
 *      devtools websocket endpoint.
 *
 * There is deliberately no generic "looks like a hex blob" rule. Page markdown
 * routinely contains 32 and 40 character hex strings (checksums, commit ids), and
 * corrupting real content to chase a value we already redact by exact match would
 * trade a real cost for no gain.
 */

export const REDACTED = "[redacted]";

/**
 * Values shorter than this are never redacted by value.
 *
 * One floor for everything, credentials and restored profile material alike. A
 * higher floor for cookie values was tried and removed: it left an 8 to 15
 * character session token echoed by a page free to enter model context and the
 * session file, and leaking bearer-equivalent material is worse than replacing a
 * short string in page text with a visible placeholder.
 *
 * The floor itself is the honest limit. A site whose session token is shorter
 * than eight characters is outside what value redaction can protect, because
 * registering a value that short would replace it everywhere it occurs in every
 * page.
 */
const MIN_SECRET_LENGTH = 8;

const PATTERN_RULES: Array<{ pattern: RegExp; replace: string }> = [
  // Live View capability URLs carry the JWT in a query parameter.
  { pattern: /([?&]jwt=)[^&\s"'<>]+/gi, replace: `$1${REDACTED}` },
  // Authorization header echoes, in either header or bare-scheme form.
  { pattern: /\b(authorization\s*:\s*bearer\s+)\S+/gi, replace: `$1${REDACTED}` },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, replace: `Bearer ${REDACTED}` },
  // The CDP websocket endpoint identifies the account in its path.
  { pattern: /wss:\/\/api\.cloudflare\.com\/\S*/gi, replace: `wss://api.cloudflare.com/${REDACTED}` },
];

/**
 * Holds the secret values resolved during this process so they can be removed
 * from any outbound string by exact match. Instance-scoped rather than module
 * global so tests get a clean registry and so `session_shutdown` can drop it.
 */
export class SecretRegistry {
  readonly #values = new Set<string>();

  remember(value: string | undefined | null): void {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) return;
    this.#values.add(trimmed);
  }

  clear(): void {
    this.#values.clear();
  }

  get size(): number {
    return this.#values.size;
  }

  /** Longest first, so a token that contains a shorter secret is replaced whole. */
  values(): string[] {
    return [...this.#values].sort((a, b) => b.length - a.length);
  }

  toString(): string {
    return `SecretRegistry(${this.#values.size})`;
  }

  toJSON(): string {
    return REDACTED;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove known secret values and secret-carrying patterns from `text`. */
export function redact(text: string, registry?: SecretRegistry): string {
  if (!text) return text;
  let output = text;
  for (const value of registry?.values() ?? []) {
    output = output.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  }
  for (const rule of PATTERN_RULES) {
    output = output.replace(rule.pattern, rule.replace);
  }
  return output;
}

/** Recursively scrub the string leaves of a structure bound for the activity log. */
export function redactValue<T>(value: T, registry?: SecretRegistry): T {
  if (typeof value === "string") return redact(value, registry) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, registry)) as unknown as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(item, registry);
    }
    return output as unknown as T;
  }
  return value;
}
