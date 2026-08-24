#!/usr/bin/env node
// Opt-in live validation on an operator-owned professional-social account.
//
//   OPENSHELL_PROFESSIONAL_SOCIALS_LIVE=1 \
//   PS_LIVE_TRUST_DOMAIN=personal PS_LIVE_BROWSER_PROFILE=personal-browser \
//   PS_LIVE_SITE=linkedin PS_LIVE_PROFILE_URL=https://www.linkedin.com/in/<you> \
//   PS_LIVE_FIELD="Headline" PS_LIVE_VALUE="<temporary value>" PS_LIVE_ORIGINAL="<current value>" \
//   npm run test:openshell-agent:live
//
// It runs two mandated jobs against the operator's own account: one that sets a
// single designated low-risk field to a temporary value, and one that puts the
// original value back. It then checks the trusted host report, scans every host
// artifact for credential canaries, and verifies that the second job reused the
// same persistent browser workspace and its existing login.
//
// The run is only meaningful with a browser workspace that is already logged in
// (use `/openshell takeover` once). Site terms of service remain the operator's
// responsibility.
import { readFile } from "node:fs/promises";

if (process.env.OPENSHELL_PROFESSIONAL_SOCIALS_LIVE !== "1") {
  console.log("SKIP: set OPENSHELL_PROFESSIONAL_SOCIALS_LIVE=1 plus the PS_LIVE_* variables for the live account check");
  process.exit(0);
}

const required = ["PS_LIVE_TRUST_DOMAIN", "PS_LIVE_BROWSER_PROFILE", "PS_LIVE_SITE", "PS_LIVE_PROFILE_URL", "PS_LIVE_FIELD", "PS_LIVE_VALUE", "PS_LIVE_ORIGINAL"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required variables: ${missing.join(", ")}`);
  process.exit(2);
}

const [{ OpenShellAgentOrchestrator }, { BUILTIN_PROFILES }, { browserWorkspaceKey }] = await Promise.all([
  import("./orchestrator.ts"),
  import("./profile.ts"),
  import("./identity.ts"),
]);

const orchestrator = new OpenShellAgentOrchestrator({ proposalPollMs: 500 });
const profile = BUILTIN_PROFILES["professional-socials"];
const trustDomain = process.env.PS_LIVE_TRUST_DOMAIN;
const browserProfile = process.env.PS_LIVE_BROWSER_PROFILE;
const key = browserWorkspaceKey(trustDomain, browserProfile);
const before = await orchestrator.registry.findBrowserWorkspace(key);
if (!before) {
  console.error("No logged-in browser workspace exists yet. Run one authenticated-browser job and log in through /openshell takeover first.");
  process.exit(2);
}

const callbacks = {
  confirmRecreate: async () => false,
  confirmBrowserRecreate: async () => false,
  // The operator opted in by starting this script with the PS_LIVE_* scope.
  authorizeMandate: async (request) => {
    process.stderr.write(`Authorizing: sites=${request.sites.map((site) => site.id).join(",")} classes=${request.actionClasses.join(",")} ttl=${request.ttlMinutes}m\n`);
    return true;
  },
  reviewProposal: async () => ({ action: "reject", reason: "The live check needs no policy expansion." }),
  progress: (message) => process.stderr.write(`${message}\n`),
};

const job = (value) => ({
  task: [
    `Open ${process.env.PS_LIVE_PROFILE_URL}.`,
    `Set the single field "${process.env.PS_LIVE_FIELD}" to exactly: ${value}`,
    "Change nothing else, submit that one edit, and report the confirmed result.",
  ].join(" "),
  profile: profile.name,
  trustDomain,
  browserProfile,
  professionalSocials: {
    sites: [process.env.PS_LIVE_SITE],
    allow: ["edit-profile"],
    budget: { edits: 6, submits: 2, publishes: 0, uploads: 0, actions: 120 },
    ttlMinutes: 20,
  },
});

const results = [];
try {
  results.push(await orchestrator.run(profile, job(process.env.PS_LIVE_VALUE), undefined, callbacks));
  results.push(await orchestrator.run(profile, job(process.env.PS_LIVE_ORIGINAL), undefined, callbacks));
} catch (error) {
  console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}

const after = await orchestrator.registry.findBrowserWorkspace(key);
const canaries = [before.controlSecret, ...results.map((result) => result.professionalSocials?.mandateId ?? "")].filter(Boolean);
const findings = [];

if (!after || after.sandboxName !== before.sandboxName) findings.push("the persistent browser workspace was not reused");
if (after && after.controlSecret !== before.controlSecret) findings.push("the browser control secret changed unexpectedly");
for (const [index, result] of results.entries()) {
  const label = index === 0 ? "change" : "revert";
  if (result.status !== "complete") findings.push(`${label} job did not complete: ${result.errorCode ?? result.status}`);
  if (!result.report?.includes("submits committed: 1")) findings.push(`${label} job report does not show exactly one committed submit`);
  if (result.professionalSocials?.revocation) findings.push(`${label} job mandate was revoked: ${result.professionalSocials.revocation}`);
  if (result.professionalSocials?.denials) process.stderr.write(`${label} job recorded ${result.professionalSocials.denials} denials; inspect the ledger\n`);
  const ledger = await readFile(result.professionalSocials.auditPath, "utf8").catch(() => "");
  for (const canary of canaries) {
    if (ledger.includes(canary) || (result.report ?? "").includes(canary)) findings.push(`${label} job leaked host-only control material into an audit artifact`);
  }
  if (/password|one-time|otp|cookie|li_at|session=/i.test(ledger)) findings.push(`${label} job ledger contains credential-shaped material`);
}
if (!results[0].report?.includes(process.env.PS_LIVE_VALUE)) findings.push("the trusted report does not show the requested new value");
if (!results[1].report?.includes(process.env.PS_LIVE_ORIGINAL)) findings.push("the trusted report does not show the reverted value");

console.log(JSON.stringify({
  status: findings.length === 0 ? "pass" : "fail",
  persistentReuse: Boolean(after && after.sandboxName === before.sandboxName),
  browserSandbox: before.sandboxName,
  reports: results.map((result) => result.professionalSocials?.auditPath),
  findings,
}, null, 2));
process.exit(findings.length === 0 ? 0 : 1);
