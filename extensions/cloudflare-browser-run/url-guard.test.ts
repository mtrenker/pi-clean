/**
 * URL guard tests - DESIGN.md acceptance criteria AC-U1 through AC-U7.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRunError } from "./errors.ts";
import {
  assertOriginAllowed,
  classifyAddress,
  normalizeTarget,
  validateTarget,
  type ResolvedAddress,
} from "./url-guard.ts";

function rejection(input: string): string {
  try {
    normalizeTarget(input);
  } catch (error) {
    assert.ok(error instanceof BrowserRunError, `expected BrowserRunError for ${input}`);
    assert.equal(error.errorClass, "target_rejected");
    return error.detail;
  }
  return assert.fail(`expected ${input} to be rejected`);
}

test("AC-U1 only http and https are navigable schemes", () => {
  for (const input of [
    "file:///etc/passwd",
    "data:text/html,<h1>x</h1>",
    "javascript:alert(1)",
    "about:config",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "ftp://example.com/file",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
  ]) {
    assert.match(rejection(input), /scheme .* is not supported|is not an absolute URL/);
  }
  assert.equal(normalizeTarget("https://example.com/docs").protocol, "https:");
  assert.equal(normalizeTarget("http://example.com/docs").protocol, "http:");
});

test("AC-U2 credential-bearing URLs are rejected", () => {
  assert.match(rejection("https://user:pass@example.com/"), /credentials in its userinfo/);
  assert.match(rejection("https://user@example.com/"), /credentials in its userinfo/);
});

test("AC-U3 literal addresses in prohibited ranges are rejected", () => {
  const cases: Array<[string, RegExp]> = [
    ["http://127.0.0.1/", /loopback/],
    ["http://[::1]/", /loopback/],
    ["http://10.0.0.1/", /private 10\./],
    ["http://172.16.0.1/", /private 172\./],
    ["http://172.31.255.254/", /private 172\./],
    ["http://192.168.1.1/", /private 192\./],
    ["http://100.64.0.1/", /carrier-grade NAT/],
    ["http://169.254.169.254/", /link-local/],
    ["http://[fe80::1]/", /link-local/],
    ["http://[fc00::1]/", /unique-local/],
    ["http://0.0.0.0/", /unspecified or reserved/],
    ["http://255.255.255.255/", /reserved 240/],
    ["http://240.0.0.1/", /reserved 240/],
    ["http://224.0.0.1/", /multicast/],
  ];
  for (const [input, expected] of cases) {
    assert.match(rejection(input), expected, input);
  }
  // 172.32.0.0 is outside the private block and must pass structural checks.
  assert.equal(normalizeTarget("http://172.32.0.1/").hostname, "172.32.0.1");
});

test("AC-U4 obfuscated address forms are normalized before classification", () => {
  for (const input of [
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0177.0.0.1/",
    "http://127.0.0.1./",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:10.0.0.1]/",
    "http://[64:ff9b::127.0.0.1]/",
  ]) {
    assert.match(rejection(input), /prohibited range/, input);
  }
});

test("AC-U6 reserved suffixes and dotless hostnames are rejected", () => {
  for (const input of [
    "http://localhost/",
    "http://api.localhost/",
    "http://printer.local/",
    "http://db.internal/",
    "http://router.home.arpa/",
    "http://thing.test/",
    "http://intranet/",
  ]) {
    assert.match(rejection(input), /reserved suffix|has no dot/, input);
  }
});

test("AC-U7 an ordinary public URL passes and comes back normalized", async () => {
  const lookup = async (): Promise<ResolvedAddress[]> => [{ address: "93.184.216.34", family: 4 }];
  const url = await validateTarget("  @https://WWW.Example.COM/Docs?q=1#frag  ", { lookup });
  assert.equal(url.origin, "https://www.example.com");
  assert.equal(url.pathname, "/Docs");
  assert.equal(url.search, "?q=1");
});

test("AC-U5 every resolved address is checked, not only the first", async () => {
  const mixed = async (): Promise<ResolvedAddress[]> => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(
    () => validateTarget("https://rebind.example.com/", { lookup: mixed }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "target_rejected" &&
      /resolves to an address in a prohibited range/.test(error.detail),
  );

  const publicOnly = async (): Promise<ResolvedAddress[]> => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];
  const ok = await validateTarget("https://example.com/", { lookup: publicOnly });
  assert.equal(ok.hostname, "example.com");
});

test("DNS failure is a navigation failure, not a rejection", async () => {
  const failing = async (): Promise<ResolvedAddress[]> => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(
    () => validateTarget("https://missing.example.com/", { lookup: failing }),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "navigation_failed",
  );

  const empty = async (): Promise<ResolvedAddress[]> => [];
  await assert.rejects(
    () => validateTarget("https://empty.example.com/", { lookup: empty }),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "navigation_failed",
  );
});

test("literal IPs skip DNS entirely", async () => {
  let called = false;
  const lookup = async (): Promise<ResolvedAddress[]> => {
    called = true;
    return [];
  };
  await validateTarget("https://93.184.216.34/", { lookup });
  assert.equal(called, false);
});

test("origin allowlists compare exact origins", () => {
  const url = normalizeTarget("https://www.example.com/jobs");
  assert.doesNotThrow(() => assertOriginAllowed(url, ["https://www.example.com"]));
  assert.throws(
    () => assertOriginAllowed(url, ["https://example.com"]),
    /outside the allowed origins/,
  );
  assert.throws(() => assertOriginAllowed(url, ["http://www.example.com"]), /outside the allowed/);
  // An empty allowlist means unconfined, which is the default for anonymous contexts.
  assert.doesNotThrow(() => assertOriginAllowed(url, []));
});

test("classifyAddress reports null for plausible public addresses", () => {
  assert.equal(classifyAddress("93.184.216.34"), null);
  assert.equal(classifyAddress("2606:2800:220:1:248:1893:25c8:1946"), null);
  assert.equal(classifyAddress("not-an-ip"), "unparsable address");
});

test("empty and relative inputs are rejected", () => {
  assert.match(rejection("   "), /empty URL/);
  assert.match(rejection("/docs/index.html"), /is not an absolute URL/);
  assert.match(rejection("example.com"), /is not an absolute URL/);
});
