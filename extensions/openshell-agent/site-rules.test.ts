import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as controller from "./image/site-rules.mjs";
import { BROWSER_CHROMIUM_BINARY } from "./profile.ts";
import {
  authorizeSurface,
  classifyUrl,
  isCommitControl,
  isSensitiveField,
  loadSiteRules,
  networkHostsFor,
  originsFor,
  permalinkFor,
  siteIds,
} from "./site-rules.ts";

const root = dirname(fileURLToPath(import.meta.url));
const rules = loadSiteRules();

const CASES: Array<{ url: string; dialogName?: string; actionClass: string; expect: "allow" | "deny"; note: string }> = [
  { url: "https://www.linkedin.com/in/martin", actionClass: "read", expect: "allow", note: "own profile is readable" },
  { url: "https://www.linkedin.com/in/martin", dialogName: "Edit intro", actionClass: "edit-profile", expect: "allow", note: "edit dialog is authorized" },
  { url: "https://www.linkedin.com/in/martin", dialogName: "Delete this section", actionClass: "edit-profile", expect: "deny", note: "hard-deny dialog wins" },
  { url: "https://www.linkedin.com/in/martin", dialogName: "Change password", actionClass: "edit-profile", expect: "deny", note: "credential dialog is refused" },
  { url: "https://www.linkedin.com/in/martin", actionClass: "edit-profile", expect: "deny", note: "inline edits need the site's dialog" },
  { url: "https://www.linkedin.com/psettings/account", actionClass: "read", expect: "deny", note: "account settings are a hard deny" },
  { url: "https://www.linkedin.com/jobs/view/123", actionClass: "read", expect: "deny", note: "job applications are out of scope" },
  { url: "https://www.linkedin.com/messaging/thread", actionClass: "read", expect: "deny", note: "messaging is out of scope" },
  { url: "https://www.linkedin.com/feed/", dialogName: "Create a post", actionClass: "publish-post", expect: "allow", note: "composer publishes" },
  { url: "https://www.linkedin.com/feed/", dialogName: "Create a post", actionClass: "submit-profile", expect: "deny", note: "class not offered by the surface" },
  { url: "https://www.linkedin.com/checkout/premium", actionClass: "read", expect: "deny", note: "billing is a hard deny" },
  { url: "https://www.xing.com/profile/Martin_Trenker", actionClass: "edit-profile", expect: "allow", note: "Xing profile pages allow inline edits" },
  { url: "https://www.xing.com/settings/privacy", actionClass: "read", expect: "deny", note: "settings are denied" },
  { url: "https://www.freelance.de/myfreelance/profil", actionClass: "submit-profile", expect: "allow", note: "freelance.de profile submit" },
  { url: "https://www.freelance.de/login", actionClass: "read", expect: "deny", note: "login is human-only" },
  { url: "https://www.freelancermap.de/my/profil", actionClass: "edit-profile", expect: "allow", note: "freelancermap profile" },
  { url: "https://www.gulp.de/gulp2/g/mygulp/profil", actionClass: "edit-profile", expect: "allow", note: "GULP profile" },
  { url: "https://www.malt.de/profile/martin", actionClass: "submit-profile", expect: "allow", note: "Malt profile submit" },
  { url: "https://www.malt.de/dashboard", actionClass: "edit-profile", expect: "deny", note: "dashboard is read-only" },
  { url: "https://example.com/anything", actionClass: "read", expect: "allow", note: "unlisted origin is readable" },
  { url: "https://example.com/anything", actionClass: "edit-profile", expect: "deny", note: "unlisted origin never mutates" },
  { url: "https://www.linkedin.com/unmapped/section", actionClass: "edit-profile", expect: "deny", note: "unmapped path stays read-only" },
  { url: "http://www.linkedin.com/in/martin", actionClass: "read", expect: "allow", note: "scheme is enforced by the caller, not the rulebook" },
];

test("the rulebook classifies every documented surface consistently", () => {
  for (const item of CASES) {
    const classification = classifyUrl(rules, item.url);
    const verdict = authorizeSurface(rules, classification, item.actionClass, { dialogName: item.dialogName });
    assert.equal(verdict.allowed, item.expect === "allow", `${item.note}: ${item.url} ${item.actionClass}`);
  }
});

test("the browser controller reaches identical verdicts from its own rulebook copy", async () => {
  const [hostCopy, imageCopy] = await Promise.all([
    readFile(join(root, "site-rules.json"), "utf8"),
    readFile(join(root, "image", "site-rules.json"), "utf8"),
  ]);
  assert.equal(hostCopy, imageCopy, "the image must carry the same repository-owned rulebook");
  for (const item of CASES) {
    const host = classifyUrl(rules, item.url);
    const sandbox = controller.classifyUrl(item.url);
    assert.deepEqual(sandbox, host, item.url);
    assert.deepEqual(
      controller.authorizeSurface(sandbox, item.actionClass, { dialogName: item.dialogName }),
      authorizeSurface(rules, host, item.actionClass, { dialogName: item.dialogName }),
      item.note,
    );
  }
});

test("global hard denies win over any site rule and redact the surface", () => {
  for (const url of [
    "https://www.linkedin.com/in/martin/delete",
    "https://www.xing.com/profile/martin/security",
    "https://www.malt.de/profile/martin/payment",
    "https://www.gulp.de/mygulp/profil/oauth/authorize",
    "https://www.freelancermap.de/my/profil/terms",
  ]) {
    const classification = classifyUrl(rules, url);
    assert.equal(classification.hardDeny, true, url);
    assert.equal(classification.redact, true, url);
    assert.deepEqual(classification.classes, []);
    assert.equal(authorizeSurface(rules, classification, "read").code, "hard_deny_surface");
  }
});

test("sensitive fields are recognized regardless of the surface", () => {
  assert.equal(isSensitiveField(rules, { type: "password" }), true);
  assert.equal(isSensitiveField(rules, { type: "hidden" }), true);
  assert.equal(isSensitiveField(rules, { type: "text", autocomplete: "one-time-code" }), true);
  assert.equal(isSensitiveField(rules, { type: "text", autocomplete: "cc-number" }), true);
  assert.equal(isSensitiveField(rules, { type: "text", name: "iban" }), true);
  assert.equal(isSensitiveField(rules, { type: "text", label: "Verification code" }), true);
  assert.equal(isSensitiveField(rules, { type: "text", name: "headline", label: "Headline" }), false);
  for (const field of [{ type: "password" }, { type: "text", autocomplete: "one-time-code" }, { type: "text", name: "iban" }]) {
    assert.equal(controller.isSensitiveField(field), true);
  }
});

test("commit controls are recognized in both languages so clicks cannot bypass declared diffs", () => {
  for (const label of ["Save", "Speichern", "Publish", "Veröffentlichen", "Absenden", "Post", "Update", "Fertig"]) {
    assert.equal(isCommitControl(rules, label), true, label);
    assert.equal(controller.isCommitControl(label), true, label);
  }
  assert.equal(isCommitControl(rules, "Add media"), false);
  assert.equal(isCommitControl(rules, ""), false);
  // Matching is anchored: opening a composer must stay clickable while the
  // control that actually commits it still needs a declared diff.
  assert.equal(isCommitControl(rules, "Start a post"), false);
  assert.equal(controller.isCommitControl("Start a post"), false);
  assert.equal(isCommitControl(rules, "Post"), true);
});

test("permalinks are recorded only from rule-declared shapes", () => {
  const feed = classifyUrl(rules, "https://www.linkedin.com/feed/");
  assert.equal(
    permalinkFor(feed, "https://www.linkedin.com/feed/update/urn:li:activity:1?trk=noise"),
    "https://www.linkedin.com/feed/update/urn:li:activity:1",
  );
  assert.equal(permalinkFor(feed, "https://www.linkedin.com/in/martin"), undefined);
});

const BROWSER_SERVICE_POLICIES = ["authenticated-browser-service.policy.yaml", "professional-socials-service.policy.yaml"];

interface DeclaredNetworkPolicy {
  key: string;
  hosts: string[];
  ports: string[];
  binaries: string[];
}

/**
 * Minimal reader for the `network_policies` block of a base policy. The tests
 * deliberately read the shipped YAML instead of a rendered object: OpenShell
 * consumes these files verbatim, so a grant that is invisible here is a grant
 * that never reaches the sandbox.
 */
function declaredNetworkPolicies(policy: string): DeclaredNetworkPolicy[] {
  const start = policy.indexOf("network_policies:");
  if (start < 0) return [];
  const declared: DeclaredNetworkPolicy[] = [];
  let current: DeclaredNetworkPolicy | undefined;
  for (const line of policy.slice(start).split("\n").slice(1)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (/^\S/.test(line)) break;
    const key = line.match(/^ {2}([A-Za-z0-9_]+):\s*$/)?.[1];
    if (key) {
      current = { key, hosts: [], ports: [], binaries: [] };
      declared.push(current);
      continue;
    }
    const host = line.match(/^\s+- host: (\S+)$/)?.[1];
    if (host) current?.hosts.push(host);
    const port = line.match(/^\s+port: (\S+)$/)?.[1];
    if (port) current?.ports.push(port);
    const binary = line.match(/^\s+- path: (\S+)$/)?.[1];
    if (binary) current?.binaries.push(binary);
  }
  return declared;
}

/** Static profile boundary: the part OpenShell cannot change without recreating the sandbox. */
function staticSection(policy: string): string {
  return policy
    .slice(0, policy.indexOf("network_policies:"))
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trimEnd())
    .filter((line) => line !== "")
    .join("\n");
}

test("mandate origins and the browser network policy stay bound to the rulebook", async () => {
  assert.deepEqual(siteIds(rules), ["linkedin", "xing", "freelance-de", "freelancermap", "gulp", "malt"]);
  assert.deepEqual(originsFor(rules, ["linkedin"]), ["linkedin.com", "www.linkedin.com"]);
  const expectedHosts = networkHostsFor(rules, siteIds(rules));
  assert.ok(expectedHosts.includes("www.linkedin.com") && expectedHosts.includes("static.licdn.com"));
  for (const file of BROWSER_SERVICE_POLICIES) {
    const policy = await readFile(join(root, "profiles", file), "utf8");
    assert.equal(/^\s+- host: \S*\*/m.test(policy), false, `${file} must never carry a wildcard host`);
    const declared = declaredNetworkPolicies(policy);
    assert.equal(declared.length, 1, `${file} must declare exactly one browser network policy`);
    assert.deepEqual([...declared[0].hosts].sort(), expectedHosts, `${file} must allow exactly the rulebook hosts`);
    assert.deepEqual([...new Set(declared[0].ports)], ["443"], `${file} must reach the rulebook hosts over 443 only`);
  }
});

test("every browser network endpoint is bound to the pinned Chromium binary", async () => {
  assert.equal(BROWSER_CHROMIUM_BINARY, "/opt/openshell-browser/browsers/chromium-1228/chrome-linux64/chrome");
  for (const file of BROWSER_SERVICE_POLICIES) {
    const policy = await readFile(join(root, "profiles", file), "utf8");
    const [declared] = declaredNetworkPolicies(policy);
    // OpenShell v0.0.86 enforces require_binary_identity: an endpoint without
    // exactly this binary is denied for Chromium even when the host is listed.
    assert.deepEqual(declared.binaries, [BROWSER_CHROMIUM_BINARY], `${file} must bind its endpoints to the pinned Chromium executable`);
  }
});

test("no base policy grants network endpoints without a binary identity", async () => {
  const files = (await readdir(join(root, "profiles"))).filter((file) => file.endsWith(".policy.yaml")).sort();
  assert.ok(files.length >= BROWSER_SERVICE_POLICIES.length + 1);
  for (const file of files) {
    const policy = await readFile(join(root, "profiles", file), "utf8");
    for (const declared of declaredNetworkPolicies(policy)) {
      assert.ok(declared.hosts.length > 0, `${file}: ${declared.key} declares a network policy without any endpoint`);
      assert.ok(declared.binaries.length > 0, `${file}: ${declared.key} grants egress to every process instead of one binary`);
    }
  }
});

test("safe and autonomous browser service policies differ only in their network section", async () => {
  const [safePolicy, socialsPolicy] = await Promise.all(
    BROWSER_SERVICE_POLICIES.map((file) => readFile(join(root, "profiles", file), "utf8")),
  );
  assert.equal(
    staticSection(safePolicy),
    staticSection(socialsPolicy),
    "a mode switch must be a dynamic network change, never a sandbox recreation",
  );
  const [safe] = declaredNetworkPolicies(safePolicy);
  const [socials] = declaredNetworkPolicies(socialsPolicy);
  // Safe login and autonomous maintenance need the same site assets; the modes
  // are separated by the mandate and the rulebook, not by a wider allowlist.
  assert.deepEqual(safe.hosts, socials.hosts);
  assert.deepEqual(safe.binaries, socials.binaries);
  assert.notEqual(safe.key, socials.key, "each mode keeps its own named policy so denial logs stay attributable");
});
