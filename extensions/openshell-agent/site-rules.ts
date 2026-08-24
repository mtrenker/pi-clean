import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository-owned professional-socials rulebook.
 *
 * The identical JSON document is baked into the browser image, so the trusted
 * host bridge and the in-sandbox browser controller classify every action
 * independently from the same durable source instead of one supplying rules to
 * the other. The worker never sees, supplies, or extends the rulebook.
 */
export const ACTION_CLASSES = ["read", "edit-profile", "submit-profile", "publish-post"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export interface SiteSurface {
  id: string;
  label: string;
  pathPatterns: string[];
  classes: string[];
  allowInlineEdit?: boolean;
  dialogPatterns?: string[];
  enterKeys?: boolean;
}

export interface SiteRule {
  id: string;
  label: string;
  origins: string[];
  networkHosts: string[];
  identityCookies: string[];
  hardDenyPathPatterns: string[];
  permalinkPatterns: string[];
  surfaces: SiteSurface[];
}

export interface SiteRules {
  version: number;
  globalHardDeny: {
    reason: string;
    pathPatterns: string[];
    textPatterns: string[];
    fieldPatterns: string[];
    sensitiveAutocomplete: string[];
  };
  commitTextPatterns: string[];
  sites: SiteRule[];
}

export interface Classification {
  host: string;
  siteId?: string;
  siteLabel?: string;
  surfaceId: string;
  classes: string[];
  hardDeny: boolean;
  redact: boolean;
  reason?: string;
  allowInlineEdit: boolean;
  dialogPatterns: string[];
  enterKeys: boolean;
  permalinkPatterns: string[];
}

export interface FieldDescriptor {
  type?: string;
  name?: string;
  autocomplete?: string;
  label?: string;
}

const rulesPath = join(dirname(fileURLToPath(import.meta.url)), "site-rules.json");
let cached: SiteRules | undefined;

export function loadSiteRules(): SiteRules {
  cached ??= JSON.parse(readFileSync(rulesPath, "utf8")) as SiteRules;
  return cached;
}

/** Hostnames the browser network policy must reach for the requested sites. */
export function networkHostsFor(rules: SiteRules, siteIds: string[]): string[] {
  const hosts = new Set<string>();
  for (const site of rules.sites) {
    if (!siteIds.includes(site.id)) continue;
    for (const host of site.networkHosts) hosts.add(host.toLowerCase());
  }
  return [...hosts].sort();
}

export function originsFor(rules: SiteRules, siteIds: string[]): string[] {
  const origins = new Set<string>();
  for (const site of rules.sites) {
    if (!siteIds.includes(site.id)) continue;
    for (const origin of site.origins) origins.add(origin.toLowerCase());
  }
  return [...origins].sort();
}

/** Controls whose accessible name commits a form must go through a declared diff. */
export function isCommitControl(rules: SiteRules, text: string): boolean {
  const value = text.trim().toLowerCase();
  return value.length > 0 && matchesAny(rules.commitTextPatterns, value);
}

export function siteIds(rules: SiteRules): string[] {
  return rules.sites.map((site) => site.id);
}

/**
 * URL-level classification. A global hard deny always wins over a site rule,
 * an unmapped path inside a known site is read-only, and an unlisted origin is
 * read-only with no site identity at all.
 */
export function classifyUrl(rules: SiteRules, url: string): Classification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return denied("", "invalid-url", "the URL could not be parsed");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!["https:", "http:"].includes(parsed.protocol)) return denied(host, "unsupported-scheme", "only HTTP(S) pages are classified");
  const target = `${parsed.pathname}${parsed.search}`.toLowerCase();
  const site = rules.sites.find((entry) => entry.origins.some((origin) => origin.toLowerCase() === host));

  if (matchesAny(rules.globalHardDeny.pathPatterns, target)) {
    return denied(host, site ? `${site.id}.hard-deny` : "hard-deny", rules.globalHardDeny.reason, site);
  }
  if (site && matchesAny(site.hardDenyPathPatterns, target)) {
    return denied(host, `${site.id}.hard-deny`, `${site.label} keeps this surface outside the professional-socials scope`, site);
  }
  if (!site) {
    return {
      host, surfaceId: "unlisted", classes: ["read"], hardDeny: false, redact: false,
      reason: "unlisted origin stays read-only", allowInlineEdit: false, dialogPatterns: [], enterKeys: false, permalinkPatterns: [],
    };
  }
  const surface = site.surfaces.find((entry) => matchesAny(entry.pathPatterns, target));
  if (!surface) {
    return {
      host, siteId: site.id, siteLabel: site.label, surfaceId: `${site.id}.unmapped`, classes: ["read"],
      hardDeny: false, redact: false, reason: "no rule maps this path, so it stays read-only",
      allowInlineEdit: false, dialogPatterns: [], enterKeys: false, permalinkPatterns: site.permalinkPatterns,
    };
  }
  return {
    host, siteId: site.id, siteLabel: site.label, surfaceId: surface.id, classes: [...surface.classes],
    hardDeny: false, redact: false, allowInlineEdit: surface.allowInlineEdit === true,
    dialogPatterns: surface.dialogPatterns ?? [], enterKeys: surface.enterKeys === true,
    permalinkPatterns: site.permalinkPatterns,
  };
}

export interface SurfaceContext {
  dialogName?: string;
  headingText?: string;
}

export interface SurfaceVerdict {
  allowed: boolean;
  code?: string;
}

/**
 * DOM-refined authorization. The controller adds this layer on top of the
 * URL-level classification the host bridge already enforced.
 */
export function authorizeSurface(
  rules: SiteRules,
  classification: Classification,
  actionClass: string,
  context: SurfaceContext = {},
): SurfaceVerdict {
  if (classification.hardDeny) return { allowed: false, code: "hard_deny_surface" };
  if (!classification.classes.includes(actionClass)) return { allowed: false, code: "surface_class_denied" };
  const dialogName = (context.dialogName ?? "").trim().toLowerCase();
  const heading = (context.headingText ?? "").trim().toLowerCase();
  if (dialogName && matchesAny(rules.globalHardDeny.textPatterns, dialogName)) return { allowed: false, code: "hard_deny_dialog" };
  if (actionClass === "read") return { allowed: true };
  if (heading && matchesAny(rules.globalHardDeny.textPatterns, heading)) return { allowed: false, code: "hard_deny_heading" };
  if (dialogName) {
    if (!matchesAny(classification.dialogPatterns, dialogName)) return { allowed: false, code: "dialog_not_authorized" };
    return { allowed: true };
  }
  if (!classification.allowInlineEdit) return { allowed: false, code: "inline_edit_denied" };
  return { allowed: true };
}

export function isSensitiveField(rules: SiteRules, field: FieldDescriptor): boolean {
  const type = (field.type ?? "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const autocomplete = (field.autocomplete ?? "").toLowerCase();
  if (rules.globalHardDeny.sensitiveAutocomplete.some((entry) => autocomplete.includes(entry))) return true;
  const descriptor = `${field.name ?? ""} ${field.label ?? ""}`.trim().toLowerCase();
  return descriptor.length > 0 && matchesAny(rules.globalHardDeny.fieldPatterns, descriptor);
}

export function permalinkFor(classification: Classification, url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const target = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return matchesAny(classification.permalinkPatterns, target) ? `${parsed.origin}${parsed.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

export function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matchPattern(pattern, value));
}

/** `*` matches any run of characters, including `/`. Matching is anchored. */
export function matchPattern(pattern: string, value: string): boolean {
  const expression = pattern.toLowerCase().split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${expression}$`, "s").test(value.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function denied(host: string, surfaceId: string, reason: string, site?: SiteRule): Classification {
  return {
    host, siteId: site?.id, siteLabel: site?.label, surfaceId, classes: [], hardDeny: true, redact: true, reason,
    allowInlineEdit: false, dialogPatterns: [], enterKeys: false, permalinkPatterns: [],
  };
}
