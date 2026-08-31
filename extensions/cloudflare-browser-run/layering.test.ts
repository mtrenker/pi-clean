/**
 * Layer separation test - DESIGN.md section 4 and acceptance criterion AC-L1.
 *
 * Layer 0 is site agnostic. The only place a hostname may influence behaviour is
 * data the operator supplies: a profile's origin allowlist and a crawl's start
 * URL, plus the deny rules in url-guard.ts. Site recipes belong to a later skill
 * layer built on this tool contract.
 *
 * This is checked mechanically rather than by review discipline, because the
 * failure mode is gradual: one selector for one board, then another.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const DIRECTORY = import.meta.dirname;

/**
 * RFC 2606 reserved names, plus the two hosts this extension genuinely talks to.
 * Anything else in a URL literal means layer 0 learned about a real website.
 */
const ALLOWED_HOSTS = new Set([
  "api.cloudflare.com",
  "live.browser.run",
  "127.0.0.1",
  "example.com",
  "www.example.com",
  "docs.example.com",
  "example.org",
  "example.net",
  "tracker.example.net",
  "other.example.org",
  "rebind.example.com",
  "missing.example.com",
  "empty.example.com",
  // url-guard documents the shapes it rejects, so its own examples appear here.
  "localhost",
  "2130706433",
]);

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(DIRECTORY);
  return entries.filter((entry) => entry.endsWith(".ts")).sort();
}

test("no job-board hostname appears anywhere in the extension", async () => {
  for (const file of await sourceFiles()) {
    const text = await readFile(join(DIRECTORY, file), "utf8");
    assert.doesNotMatch(
      text,
      /\b(freelance|gulp)\.(de|com)\b/i,
      `${file} names a job board; site recipes belong to a later skill layer`,
    );
  }
});

test("URL literals in non-test source point only at reserved names or Cloudflare", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    if (file.endsWith(".test.ts") || file === "test-support.ts") continue;
    const text = await readFile(join(DIRECTORY, file), "utf8");
    for (const match of text.matchAll(/\bhttps?:\/\/([A-Za-z0-9._-]+)/g)) {
      const host = match[1] as string;
      if (!ALLOWED_HOSTS.has(host)) offenders.push(`${file}: ${host}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "layer 0 may only reference reserved documentation names and Cloudflare's own endpoints",
  );
});

test("no source file hard-codes a CSS selector for a site", async () => {
  for (const file of await sourceFiles()) {
    if (file.endsWith(".test.ts") || file === "test-support.ts") continue;
    const text = await readFile(join(DIRECTORY, file), "utf8");
    // The only selector this extension builds is Playwright's own ref engine.
    for (const match of text.matchAll(/locator\((["'`])(.*?)\1\)/g)) {
      assert.fail(`${file} builds a literal selector: ${match[0]}`);
    }
  }
});

test("AC-X6 no fixture is shaped like a real Cloudflare credential", async () => {
  // Cloudflare account ids are 32 lowercase hex characters and API tokens are 40
  // characters of [A-Za-z0-9_-]. A digest in prose is fine; the same shape on a
  // line that talks about a token, key, or account is what must never appear, so
  // a leaked test file cannot be mistaken for a leaked credential.
  const credentialWord = /\b(token|secret|api[_-]?key|account[_-]?id|password|bearer)\b/i;
  const accountShape = /\b[0-9a-f]{32}\b/;
  const tokenShape = /\b[A-Za-z0-9_-]{40}\b/;

  for (const file of await sourceFiles()) {
    const text = await readFile(join(DIRECTORY, file), "utf8");
    for (const line of text.split("\n")) {
      if (!credentialWord.test(line)) continue;
      // Character classes inside the guard's own regexes are not literals.
      if (line.includes("[0-9a-f]") || line.includes("A-Za-z0-9")) continue;
      assert.doesNotMatch(
        line,
        accountShape,
        `${file} has an account-id-shaped literal beside a credential word: ${line.trim()}`,
      );
      assert.doesNotMatch(
        line,
        tokenShape,
        `${file} has a token-shaped literal beside a credential word: ${line.trim()}`,
      );
    }
  }
});
