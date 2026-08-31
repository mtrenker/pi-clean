/**
 * Cloudflare Browser Run - durable crawl registry
 *
 * Section 16.1 and 16.4 of DESIGN.md. A crawl outlives the Pi session that
 * started it, so its metadata lives in files under the agent directory rather
 * than in session entries, which die with the session branch.
 *
 * One file per job, `crawls/<jobId>/record.json`, rather than one shared index.
 * The shared index was the original design and it was wrong in two ways that a
 * review made concrete:
 *
 *   - a transient read failure or a truncated file read as an empty registry,
 *     and the next write then erased every other job while the remote crawls
 *     kept running;
 *   - two Pi processes could read the same document and rename over each other,
 *     losing a whole job rather than merging per record.
 *
 * Per-job files remove both. Two processes never write the same file unless they
 * are updating the same job, and an unreadable record costs exactly that one job
 * rather than all of them. Every write goes through a temporary file and a
 * rename, so a crash cannot truncate a record.
 *
 * The record is deliberately non-secret: no account id, no token, no page
 * content, no cookies. `sessionRef` is a random local id so `/browser-crawls`
 * can group jobs by the Pi session that started them without exposing a
 * Cloudflare identifier.
 */

import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
  isMissingFile,
  writeFileAtomic,
  type CrawlPurpose,
  type StatePaths,
} from "./config.ts";
import { BrowserRunError } from "./errors.ts";

/** Cloudflare's documented job statuses, plus two that are local to this registry. */
export const CLOUDFLARE_CRAWL_STATUSES = [
  "running",
  "completed",
  "cancelled_due_to_timeout",
  "cancelled_due_to_limits",
  "cancelled_by_user",
  "errored",
] as const;

export const LOCAL_CRAWL_STATUSES = ["queued", "results_expired"] as const;

export type CrawlStatus =
  | (typeof CLOUDFLARE_CRAWL_STATUSES)[number]
  | (typeof LOCAL_CRAWL_STATUSES)[number];

export const TERMINAL_STATUSES: CrawlStatus[] = [
  "completed",
  "cancelled_due_to_timeout",
  "cancelled_due_to_limits",
  "cancelled_by_user",
  "errored",
  "results_expired",
];

export function isLocalStatus(status: CrawlStatus): boolean {
  return (LOCAL_CRAWL_STATUSES as readonly string[]).includes(status);
}

export interface CrawlRecord {
  jobId: string;
  startUrl: string;
  host: string;
  formats: string[];
  limit: number;
  depth: number;
  render: boolean;
  crawlPurposes: CrawlPurpose[];
  status: CrawlStatus;
  /** True while the status is one this registry set rather than one Cloudflare reported. */
  local: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  resultsExpireAt: string | null;
  pagesSeen: number;
  browserSecondsUsed: number | null;
  lastCursor: string | null;
  cwd: string;
  sessionRef: string;
}

/** Cloudflare keeps completed crawl results for 14 days. */
export const RESULT_RETENTION_DAYS = 14;

export class CrawlRegistry {
  readonly #paths: StatePaths;
  readonly #now: () => number;
  #unreadable: string[] = [];

  constructor(paths: StatePaths, now: () => number = () => Date.now()) {
    this.#paths = paths;
    this.#now = now;
  }

  /** Job ids come from Cloudflare, so they are validated before they reach a path. */
  #assertJobId(jobId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
      throw new BrowserRunError("invalid_request", `crawl job id "${jobId}" is not well formed`);
    }
    return jobId;
  }

  cacheDir(jobId: string): string {
    return join(this.#paths.crawlsDir, this.#assertJobId(jobId));
  }

  recordPath(jobId: string): string {
    return join(this.cacheDir(jobId), "record.json");
  }

  /** Job ids whose record file exists but could not be read on the last list(). */
  unreadableJobIds(): string[] {
    return [...this.#unreadable];
  }

  async #readRecord(jobId: string): Promise<CrawlRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(jobId), "utf8")) as CrawlRecord;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new BrowserRunError(
        "invalid_request",
        `the record for crawl ${jobId} could not be read or parsed. Inspect or remove ${this.recordPath(jobId)}.`,
        { cause: error },
      );
    }
  }

  async #writeRecord(record: CrawlRecord): Promise<void> {
    await mkdir(this.cacheDir(record.jobId), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.recordPath(record.jobId), `${JSON.stringify(record, null, 2)}\n`);
  }

  async add(record: CrawlRecord): Promise<void> {
    this.#assertJobId(record.jobId);
    await withFileMutationQueue(this.recordPath(record.jobId), () => this.#writeRecord(record));
  }

  async update(jobId: string, patch: Partial<CrawlRecord>): Promise<CrawlRecord> {
    return withFileMutationQueue(this.recordPath(jobId), async () => {
      const current = await this.#readRecord(jobId);
      if (!current) {
        throw new BrowserRunError(
          "job_not_found",
          `crawl job ${jobId} is not in the local registry. Use /browser-crawls list to see known jobs.`,
        );
      }
      const next: CrawlRecord = {
        ...current,
        ...patch,
        updatedAt: new Date(this.#now()).toISOString(),
      };
      await this.#writeRecord(next);
      return next;
    });
  }

  async get(jobId: string): Promise<CrawlRecord | undefined> {
    return this.#readRecord(jobId);
  }

  async require(jobId: string): Promise<CrawlRecord> {
    const record = await this.get(jobId);
    if (!record) {
      throw new BrowserRunError(
        "job_not_found",
        `crawl job ${jobId} is not in the local registry. Use /browser-crawls list to see known jobs.`,
      );
    }
    return record;
  }

  /**
   * One unreadable record is reported through `unreadableJobIds()` rather than
   * dropped silently or allowed to hide every other job.
   */
  async list(options: { cwd?: string } = {}): Promise<CrawlRecord[]> {
    await this.#migrateLegacyIndex();
    this.#unreadable = [];

    let entries: string[];
    try {
      entries = await readdir(this.#paths.crawlsDir);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw new BrowserRunError(
        "invalid_request",
        `the crawl registry directory could not be read: ${this.#paths.crawlsDir}`,
        { cause: error },
      );
    }

    const records: CrawlRecord[] = [];
    for (const entry of entries) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry)) continue;
      let record: CrawlRecord | undefined;
      try {
        record = await this.#readRecord(entry);
      } catch {
        this.#unreadable.push(entry);
        continue;
      }
      if (record) records.push(record);
    }

    const filtered = options.cwd ? records.filter((job) => job.cwd === options.cwd) : records;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Jobs started since a timestamp, for the per-day cost cap. */
  async countStartedSince(since: number): Promise<number> {
    const jobs = await this.list();
    return jobs.filter((job) => Date.parse(job.createdAt) >= since).length;
  }

  async forget(jobId: string): Promise<void> {
    await rm(this.cacheDir(jobId), { recursive: true, force: true });
  }

  /**
   * Mark aged-out jobs and drop their cached pages. Cheap enough to run at
   * session start: it reads one small file per job.
   */
  async sweep(retentionDays: number = RESULT_RETENTION_DAYS): Promise<string[]> {
    const cutoff = this.#now() - retentionDays * 86_400_000;
    const expired: string[] = [];
    for (const job of await this.list()) {
      if (job.status === "results_expired") continue;
      const completedAt = job.completedAt ? Date.parse(job.completedAt) : NaN;
      if (Number.isFinite(completedAt) && completedAt < cutoff) {
        await this.update(job.jobId, { status: "results_expired", local: true });
        for (const key of await this.cachedPageKeys(job.jobId)) {
          await rm(this.#cachePath(job.jobId, key), { force: true });
        }
        expired.push(job.jobId);
      }
    }
    return expired;
  }

  /**
   * One-shot move from the original shared index to per-job records. Harmless
   * when there is nothing to migrate, which is the normal case.
   */
  async #migrateLegacyIndex(): Promise<void> {
    const legacy = join(this.#paths.crawlsDir, "index.json");
    try {
      await stat(legacy);
    } catch {
      return;
    }
    try {
      const document = JSON.parse(await readFile(legacy, "utf8")) as {
        jobs?: Record<string, CrawlRecord>;
      };
      for (const record of Object.values(document.jobs ?? {})) {
        if (!record?.jobId) continue;
        if (await this.#readRecord(record.jobId).catch(() => undefined)) continue;
        await this.#writeRecord(record);
      }
    } catch {
      // A corrupt legacy index is moved aside rather than blocking every job.
    }
    await rename(legacy, `${legacy}.migrated`).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Result page cache
  // -------------------------------------------------------------------------

  #cachePath(jobId: string, key: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new BrowserRunError("invalid_request", `cache key "${key}" is not well formed`);
    }
    return join(this.cacheDir(jobId), `page-${key}.json`);
  }

  async readCachedPage<T>(jobId: string, key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.#cachePath(jobId, key), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async writeCachedPage(jobId: string, key: string, payload: unknown): Promise<string> {
    const path = this.#cachePath(jobId, key);
    await mkdir(this.cacheDir(jobId), { recursive: true, mode: 0o700 });
    await withFileMutationQueue(path, async () => {
      await writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
    });
    return path;
  }

  async cachedPageKeys(jobId: string): Promise<string[]> {
    try {
      const files = await readdir(this.cacheDir(jobId));
      return files
        .filter((file) => file.startsWith("page-") && file.endsWith(".json"))
        .map((file) => file.slice("page-".length, -".json".length))
        .sort();
    } catch {
      return [];
    }
  }
}
