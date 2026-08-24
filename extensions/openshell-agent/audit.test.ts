import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditDirFor, JobLedger, listAudits, readAudit, redactUrl, redactValue } from "./audit.ts";
import { DEFAULT_BUDGET, issueMandate, taskHash } from "./mandate.ts";

const SECRET = "host-only-browser-control-secret-value";

function ledgerFor(agentDir: string, workspaceId = "workspace-1"): JobLedger {
  const issuedAt = new Date();
  const mandate = issueMandate(SECRET, {
    jobId: "job-1",
    workspaceId,
    browserWorkspaceKey: "a".repeat(64),
    controllerEpoch: "epoch-1",
    taskHash: taskHash("refresh the headline"),
    sites: ["linkedin"],
    origins: ["www.linkedin.com"],
    actionClasses: ["read", "edit-profile", "submit-profile"],
    budget: { ...DEFAULT_BUDGET },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 30 * 60_000).toISOString(),
  });
  return JobLedger.fromMandate(mandate, { trustDomain: "personal", browserProfile: "personal-browser" }, agentDir);
}

test("the trusted report is built from controller-observed facts, not the worker narrative", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "openshell-audit-"));
  const ledger = ledgerFor(agentDir);
  await ledger.append({ action: "navigate", decision: "allow", site: "linkedin", origin: "www.linkedin.com", surface: "linkedin.profile", url: "https://www.linkedin.com/in/martin" });
  await ledger.append({
    action: "submit",
    decision: "allow",
    actionClass: "submit-profile",
    site: "linkedin",
    surface: "linkedin.profile",
    url: "https://www.linkedin.com/in/martin",
    changes: [{ field: "Headline", before: "CTO", after: "Fractional CTO" }],
  });
  await ledger.append({
    action: "publish",
    decision: "allow",
    actionClass: "publish-post",
    site: "linkedin",
    surface: "linkedin.feed-compose",
    url: "https://www.linkedin.com/feed/update/urn:li:activity:1?trk=noise",
    permalink: "https://www.linkedin.com/feed/update/urn:li:activity:1",
    changes: [{ field: "Post text", before: "", after: "Shipping a new slice." }],
  });
  await ledger.append({ action: "act.fill", decision: "deny", surface: "linkedin.hard-deny", code: "hard_deny_surface" });
  await ledger.append({ action: "identity", decision: "anomaly", code: "identity_established", note: "login completed during takeover" });

  const report = ledger.report({ actions: 5, edits: 2, submits: 1, publishes: 1, uploads: 0, denials: 1, diffMismatches: 0 }, { status: "complete" });
  assert.match(report, /Trusted professional-socials review report/);
  assert.match(report, /`Headline`: "CTO" -> "Fractional CTO"/);
  assert.match(report, /submits committed: 1/);
  assert.match(report, /publications committed: 1/);
  assert.match(report, /feed\/update\/urn:li:activity:1/);
  assert.match(report, /denied `act\.fill` on linkedin\.hard-deny: hard_deny_surface/);
  assert.match(report, /anomaly on unknown: identity_established/);
  assert.match(report, /actions 5 · edits 2 · submits 1 · publishes 1 · uploads 0/);
  assert.equal(report.includes("trk=noise"), false, "tracking and token query parameters are dropped");

  const entries = await readAudit("workspace-1", "job-1", agentDir);
  assert.equal(entries.length, 5);
  assert.equal(entries[2].permalink, "https://www.linkedin.com/feed/update/urn:li:activity:1");
  assert.deepEqual(await listAudits("workspace-1", agentDir), ["job-1"]);
  assert.equal((await stat(ledger.path)).mode & 0o777, 0o600);
});

test("audit ledgers are scoped per workspace so another trust domain cannot read them", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "openshell-audit-"));
  await ledgerFor(agentDir, "personal-workspace").append({ action: "navigate", decision: "allow" });
  assert.notEqual(auditDirFor("personal-workspace", agentDir), auditDirFor("client-a-workspace", agentDir));
  assert.deepEqual(await listAudits("client-a-workspace", agentDir), []);
  await assert.rejects(readAudit("client-a-workspace", "job-1", agentDir));
});

test("recorded values are bounded and secret-shaped material is masked", () => {
  assert.equal(redactValue("one time code 483920"), "one time code [redacted]");
  assert.equal(redactValue("token AbCdEf0123456789AbCdEf0123456789"), "token [redacted]");
  assert.equal(redactValue("Fractional CTO"), "Fractional CTO");
  assert.equal(redactValue("very long profile summary ".repeat(40)).length, 241);
  assert.equal(redactValue("value\u0000\u001B[31mred"), "valuered");
  assert.equal(redactUrl("https://www.linkedin.com/in/martin?token=super-secret-value#fragment"), "https://www.linkedin.com/in/martin");
  assert.equal(redactUrl("not a url at all"), "not a url at all");
});

test("a ledger that cannot be persisted still reports, with an explicit warning", async () => {
  const blocked = join(await mkdtemp(join(tmpdir(), "openshell-audit-")), "not-a-directory");
  await writeFile(blocked, "");
  const ledger = ledgerFor(blocked);
  await ledger.append({ action: "navigate", decision: "allow" });
  const report = ledger.report({ actions: 1, edits: 0, submits: 0, publishes: 0, uploads: 0, denials: 0, diffMismatches: 0 }, { status: "failed", revocation: "circuit_breaker_denials" });
  assert.match(report, /Ledger persistence warning/);
  assert.match(report, /mandate revoked: circuit_breaker_denials/);
});
