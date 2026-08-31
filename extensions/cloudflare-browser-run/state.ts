/**
 * Cloudflare Browser Run - state model and the durable tool-result shape
 *
 * Section 5 and 8.1 of DESIGN.md.
 *
 * `BrowserDetails` is what every tool returns in `details`. Two constraints
 * shape it. First, Pi persists `details` to the session JSONL on disk, so it is
 * durable even though it never reaches the model: no secret, no capability URL,
 * and no page text may appear here. Second, `session_start` reconstructs
 * in-memory state by walking these records on the current branch, so the shape
 * has to carry enough orientation to be replayable.
 *
 * Query strings and fragments are stripped from page references because they
 * routinely carry session tokens, one-time links, and search terms containing
 * personal data.
 */

export type BrowserState =
  | "idle"
  | "connecting"
  | "active"
  | "handoff"
  | "expired"
  | "closing"
  | "failed";

export interface PageRef {
  origin: string;
  path: string;
  title?: string;
}

export interface BrowserDetails {
  state: BrowserState;
  profile: string | null;
  tab: { index: number; count: number } | null;
  page: PageRef | null;
  truncated: boolean;
  bytes: number;
  errorClass?: string;
}

/** Reduce a URL to the durable, non-identifying parts. */
export function pageRef(url: URL | string, title?: string): PageRef {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const ref: PageRef = { origin: parsed.origin, path: parsed.pathname };
  if (title !== undefined && title !== "") ref.title = title;
  return ref;
}

export interface DetailsInput {
  state?: BrowserState;
  profile?: string | null;
  tab?: { index: number; count: number } | null;
  page?: PageRef | null;
  truncated?: boolean;
  bytes?: number;
  errorClass?: string;
}

export function buildDetails(input: DetailsInput = {}): BrowserDetails {
  const details: BrowserDetails = {
    state: input.state ?? "idle",
    profile: input.profile ?? null,
    tab: input.tab ?? null,
    page: input.page ?? null,
    truncated: input.truncated ?? false,
    bytes: input.bytes ?? 0,
  };
  if (input.errorClass) details.errorClass = input.errorClass;
  return details;
}
