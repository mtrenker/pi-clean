/**
 * Cloudflare Browser Run — network target validation
 *
 * Section 15 of DESIGN.md. An honest note about what this guard is for, because
 * the obvious reading is wrong: the browser runs on Cloudflare's network, not on
 * this machine and not on this LAN. From that browser `127.0.0.1` is a Cloudflare
 * container. So this is not protecting the operator's home network from the
 * agent. What it does do:
 *
 *   - keeps the model from aiming the browser at Cloudflare's own internal or
 *     metadata addresses;
 *   - keeps credential-bearing URLs out of durable tool arguments;
 *   - turns an accidental `http://localhost:3000` into a clear rejection instead
 *     of a confusing failure or an unexpected success;
 *   - applies uniformly to the one genuinely local component, the Live View
 *     redirector, which binds loopback and requires a nonce.
 *
 * Time-of-check to time-of-use cannot be closed here. We resolve DNS locally and
 * Cloudflare resolves again at fetch time. No amount of local resolution changes
 * that, because the fetch does not happen on this host.
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

import { BrowserRunError } from "./errors.ts";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ValidateTargetOptions {
  lookup?: LookupFn;
  /** When set, the target's origin must appear in this list. */
  allowedOrigins?: string[];
  /** Skip DNS resolution. Used only where the caller has already resolved. */
  skipDns?: boolean;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostname suffixes that never name a public host. */
const REJECTED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".test"];

function reject(detail: string): never {
  throw new BrowserRunError("target_rejected", detail);
}

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map((part) => Number.parseInt(part, 10));
}

/** Expand any IPv6 literal to its 16 bytes. Returns null when `address` is not IPv6. */
function ipv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  const [head, tail = ""] = address.split("::") as [string, string?];
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");

  // A trailing dotted-quad ("::ffff:127.0.0.1") occupies the final two groups.
  const expand = (groups: string[]): string[] => {
    const last = groups[groups.length - 1];
    if (last && last.includes(".")) {
      const octets = ipv4Octets(last);
      if (!octets) return groups;
      const high = ((octets[0] as number) << 8) | (octets[1] as number);
      const low = ((octets[2] as number) << 8) | (octets[3] as number);
      return [...groups.slice(0, -1), high.toString(16), low.toString(16)];
    }
    return groups;
  };

  const headExpanded = expand(headGroups);
  const tailExpanded = expand(tailGroups);
  const missing = 8 - headExpanded.length - tailExpanded.length;
  if (missing < 0) return null;
  const groups = [
    ...headExpanded,
    ...Array.from({ length: address.includes("::") ? missing : 0 }, () => "0"),
    ...tailExpanded,
  ];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group === "" ? "0" : group, 16);
    if (!Number.isFinite(value)) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function classifyIPv4(octets: number[]): string | null {
  const [a = 0, b = 0] = octets;
  if (a === 0) return "unspecified or reserved 0.0.0.0/8";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 127) return "loopback 127.0.0.0/8";
  if (a === 169 && b === 254) return "link-local 169.254.0.0/16";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
  if (a === 192 && b === 168) return "private 192.168.0.0/16";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64.0.0/10";
  if (a >= 224 && a <= 239) return "multicast 224.0.0.0/4";
  if (a >= 240) return "reserved 240.0.0.0/4";
  return null;
}

function classifyIPv6(bytes: number[]): string | null {
  const isZeroPrefix = (length: number): boolean => bytes.slice(0, length).every((byte) => byte === 0);

  if (bytes.every((byte) => byte === 0)) return "unspecified ::";
  if (isZeroPrefix(15) && bytes[15] === 1) return "loopback ::1";

  // IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 both embed an IPv4 address.
  const embedded = (): string | null => {
    const octets = bytes.slice(12);
    const inner = classifyIPv4(octets);
    return inner ? `${inner} via an embedded IPv4 address` : null;
  };
  if (isZeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embedded() ?? null;
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return embedded() ?? null;
  }

  const first = bytes[0] as number;
  const second = bytes[1] as number;
  if (first === 0xff) return "multicast ff00::/8";
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link-local fe80::/10";
  if ((first & 0xfe) === 0xfc) return "unique-local fc00::/7";
  return null;
}

/**
 * Return a rejection reason for a literal IP address, or null when it is a
 * plausible public address.
 */
export function classifyAddress(address: string): string | null {
  const octets = ipv4Octets(address);
  if (octets) return classifyIPv4(octets);
  const bytes = ipv6Bytes(address);
  if (bytes) return classifyIPv6(bytes);
  return "unparsable address";
}

/** Strip the brackets the WHATWG URL parser keeps around IPv6 hostnames. */
export function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Structural validation: scheme, credentials, and host shape. The WHATWG URL
 * parser has already normalized IPv4 shorthand (`http://2130706433/`), octal and
 * hex forms, trailing dots, and IDNA, so those arrive here in canonical form.
 */
export function normalizeTarget(input: string): URL {
  const trimmed = input.trim().replace(/^@/, "");
  if (trimmed === "") reject("an empty URL is not a navigable target");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    reject(`"${trimmed}" is not an absolute URL; include the scheme, for example https://`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    reject(`scheme ${url.protocol} is not supported; only http and https are accepted`);
  }
  if (url.username !== "" || url.password !== "") {
    reject("the URL carries credentials in its userinfo, which are not accepted");
  }

  const host = bareHostname(url);
  if (host === "") reject("the URL has no host");

  if (isIP(host) !== 0) {
    const reason = classifyAddress(host);
    if (reason) reject(`${host} is in a prohibited range (${reason})`);
    return url;
  }

  const lower = host.toLowerCase();
  for (const suffix of REJECTED_SUFFIXES) {
    if (lower === suffix.slice(1) || lower.endsWith(suffix)) {
      reject(`hostname ${host} uses the reserved suffix ${suffix}`);
    }
  }
  if (!lower.includes(".")) {
    reject(`hostname ${host} has no dot, so it names a local host rather than a public one`);
  }
  return url;
}

/** Assert that a target's origin appears in an allowlist, comparing exact origins. */
export function assertOriginAllowed(url: URL, allowedOrigins: string[]): void {
  if (allowedOrigins.length === 0) return;
  if (!allowedOrigins.includes(url.origin)) {
    reject(
      `origin ${url.origin} is outside the allowed origins for this context (${allowedOrigins.join(", ")})`,
    );
  }
}

/**
 * Full validation: structure, then DNS. Every resolved address is checked, not
 * only the first, so a round-robin record mixing a public and a private answer is
 * rejected.
 */
export async function validateTarget(
  input: string,
  options: ValidateTargetOptions = {},
): Promise<URL> {
  const url = normalizeTarget(input);
  if (options.allowedOrigins) assertOriginAllowed(url, options.allowedOrigins);

  const host = bareHostname(url);
  if (isIP(host) !== 0 || options.skipDns) return url;

  const lookup: LookupFn =
    options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    throw new BrowserRunError("navigation_failed", `${host} could not be resolved`, { cause: error });
  }
  if (addresses.length === 0) {
    throw new BrowserRunError("navigation_failed", `${host} resolved to no addresses`);
  }
  for (const entry of addresses) {
    const reason = classifyAddress(entry.address);
    if (reason) reject(`${host} resolves to an address in a prohibited range (${reason})`);
  }
  return url;
}
