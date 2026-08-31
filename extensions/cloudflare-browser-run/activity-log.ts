/**
 * Cloudflare Browser Run - activity log
 *
 * Section 18 of DESIGN.md, following agent-guard's precedent of an
 * operator-inspectable JSONL log outside the repository.
 *
 * Logged: what happened, how long it took, which class of error, how many bytes.
 * Never logged: tokens, account id, Live View URLs, cookie names or values, local
 * storage, page text, screenshots, form values, or full URLs. A URL is reduced to
 * origin and path with query and fragment removed, and to origin alone when a
 * profile is active, because a path under an authenticated origin routinely
 * identifies a specific person or document.
 *
 * Logging failures are swallowed. A log that cannot be written must never break a
 * session.
 */

import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { redactValue, type SecretRegistry } from "./redact.ts";

export interface ActivityEvent {
  event: string;
  tool?: string;
  command?: string;
  errorClass?: string;
  durationMs?: number;
  httpStatus?: number;
  browserMs?: number;
  bytes?: number;
  truncated?: boolean;
  profile?: string;
  target?: string;
  sessionRef?: string;
  detail?: string;
}

export interface ActivityLogger {
  log(event: ActivityEvent): Promise<void>;
}

export interface ActivityLoggerOptions {
  file: string;
  enabled: boolean;
  maxBytes: number;
  keep: number;
  registry?: SecretRegistry;
  now?: () => number;
}

/**
 * Reduce a URL to what is safe to keep. With a profile active only the origin
 * survives; otherwise origin and path, never query or fragment.
 */
export function logSafeTarget(url: string, options: { profileActive?: boolean } = {}): string {
  try {
    const parsed = new URL(url);
    if (options.profileActive) return parsed.origin;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparsable)";
  }
}

async function rotate(file: string, keep: number): Promise<void> {
  if (keep <= 0) {
    await unlink(file).catch(() => undefined);
    return;
  }
  await unlink(`${file}.${keep}`).catch(() => undefined);
  for (let index = keep - 1; index >= 1; index -= 1) {
    await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => undefined);
  }
  await rename(file, `${file}.1`).catch(() => undefined);
}

export function createActivityLogger(options: ActivityLoggerOptions): ActivityLogger {
  const now = options.now ?? ((): number => Date.now());

  return {
    async log(event: ActivityEvent): Promise<void> {
      if (!options.enabled) return;
      try {
        await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
        const size = await stat(options.file).then(
          (stats) => stats.size,
          () => 0,
        );
        if (size >= options.maxBytes) await rotate(options.file, options.keep);

        const record = redactValue(
          { ts: new Date(now()).toISOString(), ...event },
          options.registry,
        );
        await appendFile(options.file, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch {
        // A log that cannot be written must never surface to the operator.
      }
    },
  };
}
