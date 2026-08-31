/**
 * Crawl registry tests - DESIGN.md acceptance criteria AC-R1 to AC-R6, AC-R10.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureStateDir, statePaths } from "./config.ts";
import { BrowserRunError } from "./errors.ts";
import {
  CrawlRegistry,
  isLocalStatus,
  validateLegacyRecord,
  RESULT_RETENTION_DAYS,
  TERMINAL_STATUSES,
  type CrawlRecord,
} from "./registry.ts";
import { FIXTURE_ACCOUNT_ID, FIXTURE_TOKEN } from "./test-support.ts";

const NOW = Date.UTC(2026, 5, 1);

function record(overrides: Partial<CrawlRecord> = {}): CrawlRecord {
  return {
    jobId: "job-1",
    startUrl: "https://docs.example.com/",
    host: "docs.example.com",
    formats: ["markdown"],
    limit: 25,
    depth: 2,
    render: false,
    crawlPurposes: ["ai-input"],
    status: "queued",
    local: true,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    completedAt: null,
    resultsExpireAt: null,
    pagesSeen: 0,
    browserSecondsUsed: null,
    lastCursor: null,
    cwd: "/repo/one",
    sessionRef: "session-a",
    ...overrides,
  };
}

async function makeRegistry(
  t: { after: (fn: () => Promise<void>) => void },
  now = NOW,
): Promise<{ registry: CrawlRegistry; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-registry-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const paths = statePaths(dir);
  await ensureStateDir(paths);
  return { registry: new CrawlRegistry(paths, () => now), dir };
}

test("AC-R1 a registered job holds no account id, token, or page content", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record());

  const raw = await readFile(registry.recordPath("job-1"), "utf8");
  assert.ok(!raw.includes(FIXTURE_ACCOUNT_ID));
  assert.ok(!raw.includes(FIXTURE_TOKEN));
  assert.ok(!raw.includes("cookie"));
  assert.equal((await stat(registry.recordPath("job-1"))).mode & 0o777, 0o600);

  const stored = await registry.require("job-1");
  assert.equal(stored.startUrl, "https://docs.example.com/");
  assert.equal(stored.sessionRef, "session-a");
});

test("AC-R2 the registry survives a restart", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  await registry.add(record());

  // A fresh instance over the same directory, as a later Pi process would build.
  const reopened = new CrawlRegistry(statePaths(dir), () => NOW);
  const jobs = await reopened.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, "job-1");
});

test("a concurrent process writing another job cannot clobber this one", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  await registry.add(record({ jobId: "job-1" }));
  await registry.add(record({ jobId: "job-2", cwd: "/repo/two" }));

  // Another Pi process holding its own view of the registry. With one file per
  // job there is no shared document for the two of them to race over.
  const other = new CrawlRegistry(statePaths(dir), () => NOW + 1000);
  await other.update("job-2", { status: "running", local: false });

  const updated = await registry.update("job-1", { status: "running", local: false, pagesSeen: 7 });
  assert.equal(updated.pagesSeen, 7);
  assert.equal((await registry.require("job-2")).status, "running", "the other record survived");
  assert.equal((await registry.list()).length, 2);
});

test("a job added by another process after this one read is still discoverable", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  await registry.add(record({ jobId: "job-1" }));
  assert.equal((await registry.list()).length, 1);

  // The original shared-index design lost this record: both processes read the
  // same document and the second rename won.
  const other = new CrawlRegistry(statePaths(dir), () => NOW + 1000);
  await other.add(record({ jobId: "job-2" }));
  await registry.add(record({ jobId: "job-3" }));

  assert.deepEqual(
    (await registry.list()).map((job) => job.jobId).sort(),
    ["job-1", "job-2", "job-3"],
  );
});

test("updating an unknown job reports job_not_found", async (t) => {
  const { registry } = await makeRegistry(t);
  await assert.rejects(
    () => registry.update("missing", { pagesSeen: 1 }),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "job_not_found",
  );
  await assert.rejects(
    () => registry.require("missing"),
    (error: unknown) =>
      error instanceof BrowserRunError && /use \/browser-crawls list/i.test(error.detail),
  );
});

test("listing scopes to a working directory by default", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record({ jobId: "job-1", cwd: "/repo/one" }));
  await registry.add(record({ jobId: "job-2", cwd: "/repo/two" }));

  assert.equal((await registry.list({ cwd: "/repo/one" })).length, 1);
  assert.equal((await registry.list()).length, 2);
});

test("AC-R10 the daily counter only counts recent jobs", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record({ jobId: "old", createdAt: new Date(NOW - 3 * 86_400_000).toISOString() }));
  await registry.add(record({ jobId: "fresh" }));

  assert.equal(await registry.countStartedSince(NOW - 86_400_000), 1);
  assert.equal(await registry.countStartedSince(NOW - 7 * 86_400_000), 2);
});

test("AC-R3 and AC-R4 cached pages are keyed, reread from disk, and never refetched", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record());

  assert.equal(await registry.readCachedPage("job-1", "aaaa"), undefined);
  const path = await registry.writeCachedPage("job-1", "aaaa", { records: [{ url: "u" }] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const cached = await registry.readCachedPage<{ records: Array<{ url: string }> }>("job-1", "aaaa");
  assert.equal(cached?.records[0]?.url, "u");

  await registry.writeCachedPage("job-1", "bbbb", { records: [] });
  assert.deepEqual(await registry.cachedPageKeys("job-1"), ["aaaa", "bbbb"]);

  assert.throws(() => registry.cacheDir("../escape"), /not well formed/);
  await assert.rejects(() => registry.writeCachedPage("job-1", "../escape", {}), /not well formed/);
});

test("AC-R5 the sweep ages out jobs past Cloudflare's retention and keeps younger ones", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(
    record({
      jobId: "old",
      status: "completed",
      local: false,
      completedAt: new Date(NOW - 15 * 86_400_000).toISOString(),
    }),
  );
  await registry.add(
    record({
      jobId: "recent",
      status: "completed",
      local: false,
      completedAt: new Date(NOW - 13 * 86_400_000).toISOString(),
    }),
  );
  await registry.writeCachedPage("old", "aaaa", { records: [] });
  await registry.writeCachedPage("recent", "aaaa", { records: [] });

  const expired = await registry.sweep(RESULT_RETENTION_DAYS);
  assert.deepEqual(expired, ["old"]);
  assert.equal((await registry.require("old")).status, "results_expired");
  assert.equal((await registry.require("recent")).status, "completed");
  assert.deepEqual(await registry.cachedPageKeys("old"), []);
  assert.deepEqual(await registry.cachedPageKeys("recent"), ["aaaa"]);

  // A second sweep is a no-op rather than a repeated report.
  assert.deepEqual(await registry.sweep(RESULT_RETENTION_DAYS), []);
});

test("AC-R6 forgetting a job removes its record and its cache", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record());
  await registry.writeCachedPage("job-1", "aaaa", { records: [] });

  await registry.forget("job-1");
  assert.equal(await registry.get("job-1"), undefined);
  assert.deepEqual(await registry.cachedPageKeys("job-1"), []);

  // Forgetting twice is safe.
  await registry.forget("job-1");
});

test("one corrupt record costs one job, not the whole registry", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record({ jobId: "good" }));
  await registry.add(record({ jobId: "broken" }));
  await writeFile(registry.recordPath("broken"), "{ not json", "utf8");

  const jobs = await registry.list();
  assert.deepEqual(jobs.map((job) => job.jobId), ["good"]);
  assert.deepEqual(registry.unreadableJobIds(), ["broken"]);

  // Reading the broken job directly reports it rather than answering "no job".
  await assert.rejects(
    () => registry.require("broken"),
    (error: unknown) =>
      error instanceof BrowserRunError && /could not be read or parsed/.test(error.detail),
  );
  // And the good job is untouched by the failure.
  assert.equal((await registry.require("good")).jobId, "good");
});

test("a legacy shared index is migrated to per-job records once", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  const legacy = join(statePaths(dir).crawlsDir, "index.json");
  await writeFile(
    legacy,
    JSON.stringify({ version: 1, jobs: { "job-old": record({ jobId: "job-old" }) } }),
    "utf8",
  );

  assert.deepEqual((await registry.list()).map((job) => job.jobId), ["job-old"]);
  await assert.rejects(() => readFile(legacy, "utf8"), /ENOENT/);
  assert.match(await readFile(`${legacy}.migrated`, "utf8"), /job-old/);
});

test("local and Cloudflare statuses stay distinguishable", () => {
  assert.equal(isLocalStatus("queued"), true);
  assert.equal(isLocalStatus("results_expired"), true);
  assert.equal(isLocalStatus("completed"), false);
  assert.equal(isLocalStatus("running"), false);
  assert.ok(TERMINAL_STATUSES.includes("cancelled_by_user"));
  assert.ok(!TERMINAL_STATUSES.includes("running"));
});

test("the daily cost count fails closed when a record cannot be read", async (t) => {
  const { registry } = await makeRegistry(t);
  await registry.add(record({ jobId: "good" }));
  await registry.add(record({ jobId: "broken" }));
  await writeFile(registry.recordPath("broken"), "{ not json", "utf8");

  // Counting only the readable jobs would make an unreadable file a way past the
  // per-day cap.
  await assert.rejects(
    () => registry.countStartedSince(NOW - 86_400_000),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      /cannot be trusted/.test(error.detail) &&
      /broken/.test(error.detail),
  );

  await rm(registry.recordPath("broken"), { force: true });
  assert.equal(await registry.countStartedSince(NOW - 86_400_000), 1);
});

test("a legacy index that cannot be migrated is left in place and reported", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  const legacy = join(statePaths(dir).crawlsDir, "index.json");
  await writeFile(legacy, "{ not json", "utf8");

  assert.deepEqual(await registry.list(), []);
  assert.match(registry.legacyMigrationError() ?? "", /left in place/);

  // Renaming a failed migration would take the only copy of those jobs out of
  // the path this class reads.
  assert.equal(await readFile(legacy, "utf8"), "{ not json");
  await assert.rejects(() => readFile(`${legacy}.migrated`, "utf8"), /ENOENT/);
});

test("a successful migration clears the reported error", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  const legacy = join(statePaths(dir).crawlsDir, "index.json");
  await writeFile(
    legacy,
    JSON.stringify({ version: 1, jobs: { "job-old": record({ jobId: "job-old" }) } }),
    "utf8",
  );

  assert.deepEqual((await registry.list()).map((job) => job.jobId), ["job-old"]);
  assert.equal(registry.legacyMigrationError(), undefined);
  await assert.rejects(() => readFile(legacy, "utf8"), /ENOENT/);
});

test("a legacy index that cannot be inspected is reported, not read as absent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-registry-denied-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const paths = statePaths(dir);

  // A regular file where the crawls directory belongs makes stat() on the index
  // fail with ENOTDIR: a real non-ENOENT metadata failure, no patching needed.
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.crawlsDir, "not a directory", "utf8");

  const registry = new CrawlRegistry(paths, () => NOW);
  await assert.rejects(() => registry.list());
  assert.match(registry.legacyMigrationError() ?? "", /could not be inspected/);
  assert.match(registry.legacyMigrationError() ?? "", /unaccounted for/);

  // And that state blocks a new crawl rather than silently counting zero.
  await assert.rejects(
    () => registry.countStartedSince(NOW - 86_400_000),
    (error: unknown) => error instanceof BrowserRunError,
  );
});

test("a structurally malformed legacy job blocks the whole migration", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  const legacy = join(statePaths(dir).crawlsDir, "index.json");
  await writeFile(
    legacy,
    JSON.stringify({
      version: 1,
      jobs: {
        "job-good": record({ jobId: "job-good" }),
        // Syntactically valid JSON, semantically unusable: no id to key a record on.
        "job-bad": { startUrl: "https://docs.example.com/", status: "running" },
      },
    }),
    "utf8",
  );

  assert.deepEqual(await registry.list(), [], "nothing is migrated when one entry is unusable");
  assert.match(registry.legacyMigrationError() ?? "", /1 unusable job\(s\)/);
  assert.match(registry.legacyMigrationError() ?? "", /no well-formed jobId/);

  // The only copy stays where this class can still read it.
  assert.match(await readFile(legacy, "utf8"), /job-good/);
  await assert.rejects(() => readFile(`${legacy}.migrated`, "utf8"), /ENOENT/);
});

test("each field the registry depends on is validated before migration", () => {
  const base = record({ jobId: "job-1" });
  assert.deepEqual(validateLegacyRecord(base, "job-1"), base);

  const cases: Array<[unknown, RegExp]> = [
    [null, /is not an object/],
    ["a string", /is not an object/],
    [[base], /is not an object/],
    [{ ...base, jobId: undefined }, /no well-formed jobId/],
    [{ ...base, jobId: "../escape" }, /no well-formed jobId/],
    [{ ...base, createdAt: "not a date" }, /no parseable createdAt/],
    [{ ...base, status: "invented" }, /unknown status/],
    [{ ...base, cwd: 7 }, /no cwd/],
    [{ ...base, pagesSeen: "many" }, /no numeric pagesSeen/],
  ];
  for (const [value, expected] of cases) {
    const result = validateLegacyRecord(value, "job-1");
    assert.equal(typeof result, "string", JSON.stringify(value));
    assert.match(result as string, expected);
  }
});

test("the daily count refuses while a legacy index is unmigrated", async (t) => {
  const { registry, dir } = await makeRegistry(t);
  await registry.add(record({ jobId: "visible" }));
  const legacy = join(statePaths(dir).crawlsDir, "index.json");
  await writeFile(legacy, "{ not json", "utf8");

  // Jobs hidden inside an unmigrated index carry real spend, so counting only
  // the visible ones would let them past the cap.
  await assert.rejects(
    () => registry.countStartedSince(NOW - 86_400_000),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      /cannot be trusted/.test(error.detail) &&
      /left in place/.test(error.detail),
  );

  await rm(legacy, { force: true });
  assert.equal(await registry.countStartedSince(NOW - 86_400_000), 1);
});
