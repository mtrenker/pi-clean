/**
 * Cloudflare Browser Run - durable crawl registry
 *
 * Section 16.1 and 16.4 of DESIGN.md. A crawl outlives the Pi session that
 * started it, so its metadata lives in a global file rather than in session
 * entries, which die with the session branch.
 *
 * The record is deliberately non-secret: no account id, no token, no page
 * content, no cookies. `sessionRef` is a random local id so `/browser-crawls`
 * can group jobs by the Pi session that started them without exposing a
 * Cloudflare identifier.
 *
 * Concurrency, stated honestly: `withFileMutationQueue` serializes within one Pi
 * process. Two Pi processes writing the index at the same instant can still
 * interleave, so every write re-reads the file, applies its change to one record,
 * and keeps every other record from disk. That turns a whole-file clobber into a
 * per-record last-writer-wins, which is what status metadata can live with.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { type CrawlPurpose, type StatePaths } from "./config.ts";
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

interface RegistryDocument {
  version: number;
  jobs: Record<string, CrawlRecord>;
}

const REGISTRY_VERSION = 1;
/** Cloudflare keeps completed crawl results for 14 days. */
export const RESULT_RETENTION_DAYS = 14;

export class CrawlRegistry {
  readonly #paths: StatePaths;
  readonly #now: () => number;

  constructor(paths: StatePaths, now: () => number = () => Date.now()) {
    this.#paths = paths;
    this.#now = now;
  }

  get indexPath(): string {
    return join(this.#paths.crawlsDir, "index.json");
  }

  cacheDir(jobId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
      throw new BrowserRunError("invalid_request", `crawl job id "${jobId}" is not well formed`);
    }
    return join(this.#paths.crawlsDir, jobId);
  }

  async #read(): Promise<RegistryDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as RegistryDocument;
      if (!parsed || typeof parsed !== "object" || typeof parsed.jobs !== "object") {
        return { version: REGISTRY_VERSION, jobs: {} };
      }
      return { version: parsed.version ?? REGISTRY_VERSION, jobs: parsed.jobs ?? {} };
    } catch {
      return { version: REGISTRY_VERSION, jobs: {} };
    }
  }

  async #write(document: RegistryDocument): Promise<void> {
    await mkdir(this.#paths.crawlsDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.indexPath);
  }

  /** Read, apply to one record, write. Every other record comes from disk. */
  async #mutate(
    jobId: string,
    apply: (current: CrawlRecord | undefined) => CrawlRecord | undefined,
  ): Promise<CrawlRecord | undefined> {
    return withFileMutationQueue(this.indexPath, async () => {
      const document = await this.#read();
      const next = apply(document.jobs[jobId]);
      if (next) document.jobs[jobId] = next;
      else delete document.jobs[jobId];
      await this.#write(document);
      return next;
    });
  }

  async add(record: CrawlRecord): Promise<void> {
    await this.#mutate(record.jobId, () => record);
  }

  async update(jobId: string, patch: Partial<CrawlRecord>): Promise<CrawlRecord> {
    const updated = await this.#mutate(jobId, (current) => {
      if (!current) return undefined;
      return { ...current, ...patch, updatedAt: new Date(this.#now()).toISOString() };
    });
    if (!updated) {
      throw new BrowserRunError(
        "job_not_found",
        `crawl job ${jobId} is not in the local registry. Use /browser-crawls list to see known jobs.`,
      );
    }
    return updated;
  }

  async get(jobId: string): Promise<CrawlRecord | undefined> {
    return (await this.#read()).jobs[jobId];
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

  async list(options: { cwd?: string } = {}): Promise<CrawlRecord[]> {
    const jobs = Object.values((await this.#read()).jobs);
    const filtered = options.cwd ? jobs.filter((job) => job.cwd === options.cwd) : jobs;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Jobs started since a timestamp, for the per-day cost cap. */
  async countStartedSince(since: number): Promise<number> {
    const jobs = await this.list();
    return jobs.filter((job) => Date.parse(job.createdAt) >= since).length;
  }

  async forget(jobId: string): Promise<void> {
    await this.#mutate(jobId, () => undefined);
    await rm(this.cacheDir(jobId), { recursive: true, force: true });
  }

  /**
   * Mark aged-out jobs and drop their cached pages. Cheap enough to run at
   * session start: it reads one index file and stats nothing else.
   */
  async sweep(retentionDays: number = RESULT_RETENTION_DAYS): Promise<string[]> {
    const cutoff = this.#now() - retentionDays * 86_400_000;
    const expired: string[] = [];
    for (const job of await this.list()) {
      if (job.status === "results_expired") continue;
      const completedAt = job.completedAt ? Date.parse(job.completedAt) : NaN;
      if (Number.isFinite(completedAt) && completedAt < cutoff) {
        await this.update(job.jobId, { status: "results_expired", local: true });
        await rm(this.cacheDir(job.jobId), { recursive: true, force: true });
        expired.push(job.jobId);
      }
    }
    return expired;
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
      await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
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
