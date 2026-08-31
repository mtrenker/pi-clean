/**
 * Cloudflare Browser Run - accessibility snapshots, refs, and orientation
 *
 * Section 8.3 of DESIGN.md. The design anticipated minting refs by hand and
 * resolving them through role locators. Checking the pinned playwright-core
 * (1.62.1) showed `page.ariaSnapshot({ mode: "ai" })` already emits stable
 * `[ref=eN]` markers and ships an `aria-ref=` selector engine, so refs come from
 * Playwright rather than from us. The contract the design specified is unchanged:
 * refs come from a snapshot, they are resolved at action time, and a stale ref
 * fails loudly instead of acting on whatever now sits in that position.
 *
 * Refs are validated against a strict pattern before they reach a selector
 * string, so a model-supplied value cannot inject selector syntax.
 */

import { BrowserRunError } from "./errors.ts";

export const REF_PATTERN = /^e\d+$/;

const REF_LINE = /\[ref=(e\d+)\]/;

/** Validate a model-supplied ref before it is interpolated into a selector. */
export function assertRef(ref: string): string {
  const trimmed = ref.trim();
  if (!REF_PATTERN.test(trimmed)) {
    throw new BrowserRunError(
      "invalid_request",
      `"${ref}" is not a snapshot ref. Refs look like e12 and come from browser_snapshot.`,
    );
  }
  return trimmed;
}

/** Playwright's own selector engine for snapshot refs. */
export function refSelector(ref: string): string {
  return `aria-ref=${assertRef(ref)}`;
}

/** Every ref present in a snapshot, in document order. */
export function extractRefs(snapshot: string): string[] {
  const refs: string[] = [];
  for (const line of snapshot.split("\n")) {
    const match = line.match(REF_LINE);
    if (match?.[1]) refs.push(match[1]);
  }
  return refs;
}

/** Snapshot lines that carry a ref, which are the ones a model can act on. */
export function interactiveLines(snapshot: string): string[] {
  return snapshot.split("\n").filter((line) => REF_LINE.test(line));
}

export interface OrientationOptions {
  /** Center the excerpt on this ref when it is still present. */
  aroundRef?: string;
  /** Maximum interactive lines to include. */
  limit?: number;
}

/**
 * A short excerpt of the interactive elements, centered on the acted-on node when
 * one is known. This is what an acting tool returns instead of a full snapshot,
 * so a long interaction sequence does not spend the context window on repeated
 * page dumps.
 */
export function orientationExcerpt(snapshot: string, options: OrientationOptions = {}): string {
  const limit = options.limit ?? 12;
  const lines = interactiveLines(snapshot);
  if (lines.length === 0) return "";
  if (lines.length <= limit) return lines.join("\n");

  const anchor = options.aroundRef
    ? lines.findIndex((line) => line.includes(`[ref=${options.aroundRef}]`))
    : -1;
  if (anchor < 0) return lines.slice(0, limit).join("\n");

  const half = Math.floor(limit / 2);
  const start = Math.max(0, Math.min(anchor - half, lines.length - limit));
  return lines.slice(start, start + limit).join("\n");
}

export interface PageOrientation {
  url: string;
  title: string;
  navigated: boolean;
  excerpt: string;
  refCount: number;
}

/** Render orientation as the compact block an acting tool appends to its result. */
export function formatOrientation(orientation: PageOrientation): string {
  const header = [
    `url: ${orientation.url}`,
    `title: ${orientation.title || "(untitled)"}`,
    orientation.navigated ? "navigated: yes" : "navigated: no",
    `interactive elements: ${orientation.refCount}`,
  ].join("\n");
  return orientation.excerpt ? `${header}\n\n${orientation.excerpt}` : header;
}
