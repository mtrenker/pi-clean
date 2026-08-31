/**
 * Activity log tests - DESIGN.md section 18.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createActivityLogger, logSafeTarget } from "./activity-log.ts";
import { SecretRegistry } from "./redact.ts";
import { FIXTURE_TOKEN } from "./test-support.ts";

async function scratch(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-log-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("URLs are reduced to origin and path, and to origin alone under a profile", () => {
  const url = "https://www.example.com/account/settings?token=abc123#section";
  assert.equal(logSafeTarget(url), "https://www.example.com/account/settings");
  assert.equal(logSafeTarget(url, { profileActive: true }), "https://www.example.com");
  assert.equal(logSafeTarget("not a url"), "(unparsable)");
});

test("events are appended as JSON lines with owner-only permissions", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "activity.jsonl");
  const logger = createActivityLogger({
    file,
    enabled: true,
    maxBytes: 1_000_000,
    keep: 3,
    now: () => 1_700_000_000_000,
  });

  await logger.log({ event: "quick_action", tool: "browser_read", bytes: 42 });
  await logger.log({ event: "health_check", command: "browser" });

  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(first["ts"], "2023-11-14T22:13:20.000Z");
  assert.equal(first["event"], "quick_action");
  assert.equal(first["bytes"], 42);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("secrets never reach the log even when a caller passes one through", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "activity.jsonl");
  const registry = new SecretRegistry();
  registry.remember(FIXTURE_TOKEN);
  const logger = createActivityLogger({ file, enabled: true, maxBytes: 1_000_000, keep: 3, registry });

  await logger.log({
    event: "quick_action",
    detail: `failed with Bearer ${FIXTURE_TOKEN}`,
    target: "https://live.browser.run/ui/inspector?jwt=eyJabc.def.ghi",
  });

  const written = await readFile(file, "utf8");
  assert.ok(!written.includes(FIXTURE_TOKEN));
  assert.ok(!written.includes("eyJabc.def.ghi"));
  assert.match(written, /jwt=\[redacted\]/);
});

test("the log rotates at the configured size and keeps the configured number of files", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "activity.jsonl");
  await writeFile(file, "x".repeat(500), "utf8");

  const logger = createActivityLogger({ file, enabled: true, maxBytes: 100, keep: 2 });
  await logger.log({ event: "one" });
  await writeFile(file, "y".repeat(500), "utf8");
  await logger.log({ event: "two" });
  await writeFile(file, "z".repeat(500), "utf8");
  await logger.log({ event: "three" });

  assert.match(await readFile(file, "utf8"), /"event":"three"/);
  assert.match(await readFile(`${file}.1`, "utf8"), /^z+$/m);
  assert.match(await readFile(`${file}.2`, "utf8"), /^y+$/m);
  await assert.rejects(() => readFile(`${file}.3`, "utf8"), /ENOENT/);
});

test("logging can be disabled and never writes", async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "activity.jsonl");
  const logger = createActivityLogger({ file, enabled: false, maxBytes: 100, keep: 1 });
  await logger.log({ event: "ignored" });
  await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
});

test("a write failure is swallowed rather than surfaced", async (t) => {
  const dir = await scratch(t);
  // A directory where the log file should be makes every append fail.
  const file = join(dir, "activity.jsonl");
  await mkdtemp(join(dir, "unused-"));
  const logger = createActivityLogger({ file: join(file, "nested"), enabled: true, maxBytes: 10, keep: 1 });
  await writeFile(file, "not a directory", "utf8");
  await logger.log({ event: "should not throw" });
});
