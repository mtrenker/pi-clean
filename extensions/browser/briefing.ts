// Briefing panel — mission briefing gate for interactive browser sessions
// Shows an approval page before navigating to new domains in interactive/paired mode

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BriefingMission {
  mission: string;
  url: string;
  agent: string;
  trustedDomains?: string[];
}

export type BriefingResult = "approved" | "rejected";

export type BrowserMode = "interactive" | "autonomous";

// ---------------------------------------------------------------------------
// Domain Trust — session store + persistent file
// ---------------------------------------------------------------------------

const sessionTrusted = new Set<string>();

const TRUST_DIR = join(homedir(), ".pi", "browser");
const TRUST_FILE = join(TRUST_DIR, "trusted-domains.txt");

/**
 * Check whether a pattern (possibly with leading `*.`) matches a domain.
 * `*.github.com` matches `api.github.com` and `github.com` itself.
 * Plain `github.com` matches only `github.com`.
 */
function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2); // e.g. "github.com"
    return domain === suffix || domain.endsWith("." + suffix);
  }
  return domain === pattern;
}

/**
 * Read and parse the persistent trusted-domains file.
 * Returns an array of domain patterns (comments / blanks stripped).
 */
async function readTrustedDomainsFile(): Promise<string[]> {
  try {
    const content = await readFile(TRUST_FILE, "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Returns `true` when `domain` is already trusted — either in the current
 * session set or in the persistent `~/.pi/browser/trusted-domains.txt`.
 */
export async function isDomainTrusted(domain: string): Promise<boolean> {
  // 1. Check session trust set (fast path)
  for (const pattern of sessionTrusted) {
    if (domainMatchesPattern(domain, pattern)) return true;
  }

  // 2. Check persistent file
  const persistent = await readTrustedDomainsFile();
  for (const pattern of persistent) {
    if (domainMatchesPattern(domain, pattern)) return true;
  }

  return false;
}

/**
 * Trust a domain for the rest of this session. When `persistent` is `true`,
 * also append it to `~/.pi/browser/trusted-domains.txt`.
 */
export async function trustDomain(
  domain: string,
  persistent = false,
): Promise<void> {
  sessionTrusted.add(domain);

  if (persistent) {
    await mkdir(TRUST_DIR, { recursive: true });
    await appendFile(TRUST_FILE, domain + "\n", "utf-8");
  }
}

/**
 * Returns `true` when the briefing gate should be displayed for `domain`.
 * Briefing is skipped in autonomous mode or when the domain is already trusted.
 */
export async function shouldShowBriefing(
  mode: BrowserMode,
  domain: string,
): Promise<boolean> {
  if (mode === "autonomous") return false;
  return !(await isDomainTrusted(domain));
}

/** Return a snapshot of the current session-trusted domains. */
export function getSessionTrustedDomains(): string[] {
  return [...sessionTrusted];
}

// ---------------------------------------------------------------------------
// Briefing page — render & wait for user decision
// ---------------------------------------------------------------------------

/**
 * Show the mission briefing gate on `page` and wait for the user to approve
 * or reject. Returns `"approved"` or `"rejected"`.
 *
 * If the user checks "Always trust this domain" and approves, the domain
 * will be persisted to `~/.pi/browser/trusted-domains.txt`.
 */
export async function showBriefing(
  page: { setContent: (html: string, options?: unknown) => Promise<void>; waitForFunction: (fn: string | (() => unknown)) => Promise<{ jsonValue: () => Promise<unknown> }> },
  mission: BriefingMission,
): Promise<BriefingResult> {
  const templatePath = new URL("briefing.html", import.meta.url).pathname;
  let html = await readFile(templatePath, "utf-8");

  const domain = new URL(mission.url).hostname;
  const trustedList = mission.trustedDomains ?? getSessionTrustedDomains();

  // Replace template placeholders
  html = html
    .replace("{{mission}}", escapeHtml(mission.mission))
    .replace("{{url}}", escapeHtml(mission.url))
    .replace("{{domain}}", escapeHtml(domain))
    .replace("{{agent}}", escapeHtml(mission.agent))
    .replace("{{timestamp}}", new Date().toISOString())
    .replace(
      "{{trustedDomains}}",
      trustedList.length > 0
        ? trustedList.map((d) => `<li>${escapeHtml(d)}</li>`).join("")
        : "<li class='empty'>No domains trusted yet</li>",
    );

  await page.setContent(html, { waitUntil: "domcontentloaded" });

  // Wait for the user to click Approve or Reject
  const handle = await page.waitForFunction(
    "window.__piBriefingResult",
  );
  const raw = (await handle.jsonValue()) as { result: BriefingResult; persistTrust: boolean };

  if (raw.result === "approved") {
    // Trust this domain in session; persist if checkbox was checked
    await trustDomain(domain, raw.persistTrust);
  }

  return raw.result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
