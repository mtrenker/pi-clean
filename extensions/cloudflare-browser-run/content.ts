/**
 * Cloudflare Browser Run - untrusted content shaping
 *
 * Sections 13 and 17 of DESIGN.md. Every byte of page-derived text is
 * third-party input, so it is sanitized, wrapped in an envelope naming its
 * source, and bounded before it reaches the model.
 *
 * What the envelope achieves and what it does not: it marks provenance and stops
 * a page from closing its own envelope to appear as harness text. It does not
 * stop a page from addressing the model. The controls that bound damage are the
 * capability boundaries (no page JavaScript, no secret fill, no upload or
 * download, navigation confinement) rather than this wrapper.
 */

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export const UNTRUSTED_TAG = "untrusted-page-content";
const CLOSING_TAG = `</${UNTRUSTED_TAG}>`;

/** Defaults are tighter than Pi's 50KB and 2000 lines; see DESIGN.md section 17.1. */
export const READ_MAX_BYTES = 24_000;
export const READ_MAX_LINES = 800;
export const SNAPSHOT_MAX_BYTES = 12_000;
export const SNAPSHOT_MAX_LINES = 400;
export const ORIENTATION_MAX_BYTES = 1_500;
export const ORIENTATION_MAX_LINES = 40;
export const CRAWL_PAGE_MAX_BYTES = 16_000;
export const CRAWL_PAGE_MAX_LINES = 500;

/** CSI, OSC, and two-character escape sequences. */
const ANSI_PATTERN = /\x1B(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)?|[@-Z\\-_])/g;
/** C0 controls and DEL, keeping tab, newline, and carriage return. */
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Remove terminal control sequences from page text. A page that emits ANSI can
 * otherwise repaint or hide parts of the Pi transcript the operator is reading.
 */
export function sanitizeText(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** Neutralize any attempt by the page to close the envelope early. */
export function escapeEnvelope(text: string): string {
  return text.replace(new RegExp(`</\\s*${UNTRUSTED_TAG}`, "gi"), `<\\/${UNTRUSTED_TAG}`);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface EnvelopeMeta {
  source: string;
  tool: string;
}

/** Wrap sanitized page text so its provenance travels with it into the context. */
export function wrapUntrusted(text: string, meta: EnvelopeMeta): string {
  const body = escapeEnvelope(sanitizeText(text));
  const open = `<${UNTRUSTED_TAG} source="${escapeAttribute(meta.source)}" tool="${escapeAttribute(meta.tool)}">`;
  return `${open}\n${body}\n${CLOSING_TAG}`;
}

export interface BoundOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface BoundResult {
  content: string;
  truncated: boolean;
  outputBytes: number;
  totalBytes: number;
  outputLines: number;
  totalLines: number;
}

/**
 * Bound text with Pi's truncation utilities, with one addition: a document whose
 * first line already exceeds the byte limit (minified HTML rendered to one long
 * Markdown line) makes `truncateHead` return nothing, so fall back to a byte
 * slice rather than handing the model an empty result.
 */
export function boundText(text: string, options: BoundOptions = {}): BoundResult {
  const maxBytes = Math.min(options.maxBytes ?? READ_MAX_BYTES, DEFAULT_MAX_BYTES);
  const maxLines = Math.min(options.maxLines ?? READ_MAX_LINES, DEFAULT_MAX_LINES);
  const truncation = truncateHead(text, { maxBytes, maxLines });

  if (truncation.firstLineExceedsLimit) {
    const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
    return {
      content: sliced,
      truncated: true,
      outputBytes: Buffer.byteLength(sliced, "utf8"),
      totalBytes: truncation.totalBytes,
      outputLines: 1,
      totalLines: truncation.totalLines,
    };
  }

  return {
    content: truncation.content,
    truncated: truncation.truncated,
    outputBytes: truncation.outputBytes,
    totalBytes: truncation.totalBytes,
    outputLines: truncation.outputLines,
    totalLines: truncation.totalLines,
  };
}

/**
 * The truncation notice, in Pi's house style. `spillPath` is present only for
 * unauthenticated content; profile-backed page text is never written to disk, so
 * its notice offers a narrower request instead (DESIGN.md section 17.1).
 */
export function truncationNotice(
  result: BoundResult,
  options: { spillPath?: string; narrowerHint?: string } = {},
): string {
  if (!result.truncated) return "";
  const parts = [
    `[Output truncated: ${result.outputLines} of ${result.totalLines} lines`,
    ` (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).`,
  ];
  if (options.spillPath) parts.push(` Full output saved to: ${options.spillPath}]`);
  else if (options.narrowerHint) parts.push(` ${options.narrowerHint}]`);
  else parts.push("]");
  return parts.join("");
}

/**
 * Write untruncated public page text to a temporary file so the model can read
 * the rest with the built-in read tool. Only ever called for content that did not
 * come from an authenticated context.
 */
export async function writeSpillFile(text: string, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-browser-run-"));
  const file = join(dir, `${label}.md`);
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
