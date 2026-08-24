import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Controller-side copy of the repository-owned professional-socials rulebook.
// It is loaded from the image, never from the host or the worker, so surface
// classification is enforced independently of the trusted host bridge.
const rules = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "site-rules.json"), "utf8"));

export function siteRules() {
  return rules;
}

export function classifyUrl(url) {
  let parsed;
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

export function authorizeSurface(classification, actionClass, context = {}) {
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

export function isCommitControl(text) {
  const value = String(text ?? "").trim().toLowerCase();
  return value.length > 0 && matchesAny(rules.commitTextPatterns, value);
}

export function isSensitiveField(field) {
  const type = (field.type ?? "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const autocomplete = (field.autocomplete ?? "").toLowerCase();
  if (rules.globalHardDeny.sensitiveAutocomplete.some((entry) => autocomplete.includes(entry))) return true;
  const descriptor = `${field.name ?? ""} ${field.label ?? ""}`.trim().toLowerCase();
  return descriptor.length > 0 && matchesAny(rules.globalHardDeny.fieldPatterns, descriptor);
}

export function permalinkFor(classification, url) {
  try {
    const parsed = new URL(url);
    const target = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return matchesAny(classification.permalinkPatterns, target) ? `${parsed.origin}${parsed.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

export function matchesAny(patterns, value) {
  return patterns.some((pattern) => matchPattern(pattern, value));
}

export function matchPattern(pattern, value) {
  const expression = pattern.toLowerCase().split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${expression}$`, "s").test(value.toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function denied(host, surfaceId, reason, site) {
  return {
    host, siteId: site?.id, siteLabel: site?.label, surfaceId, classes: [], hardDeny: true, redact: true, reason,
    allowInlineEdit: false, dialogPatterns: [], enterKeys: false, permalinkPatterns: [],
  };
}
