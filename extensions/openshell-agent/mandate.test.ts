import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MandateGuard } from "./image/mandate.mjs";
import {
  CIRCUIT_BREAKER,
  MandateSession,
  clampBudget,
  clampTtlMinutes,
  DEFAULT_BUDGET,
  issueMandate,
  signRequest,
  taskHash,
  verifyMandate,
  type Mandate,
} from "./mandate.ts";

const SECRET = "host-only-browser-control-secret-value";
const EPOCH = "9f1c0f5a-0000-4000-8000-000000000001";

function mandate(overrides: Partial<Parameters<typeof issueMandate>[1]> = {}, secret = SECRET): Mandate {
  const issuedAt = new Date();
  return issueMandate(secret, {
    jobId: "job-1",
    workspaceId: "workspace-1",
    browserWorkspaceKey: "a".repeat(64),
    controllerEpoch: EPOCH,
    taskHash: taskHash("refresh the headline"),
    sites: ["linkedin"],
    origins: ["www.linkedin.com"],
    actionClasses: ["read", "edit-profile", "submit-profile"],
    budget: { ...DEFAULT_BUDGET },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 30 * 60_000).toISOString(),
    ...overrides,
  });
}

test("a mandate verifies only against its own binding, task, workspace, job, and epoch", () => {
  const issued = mandate();
  assert.deepEqual(verifyMandate(SECRET, issued, {
    jobId: "job-1", workspaceId: "workspace-1", browserWorkspaceKey: "a".repeat(64),
    controllerEpoch: EPOCH, taskHash: taskHash("refresh the headline"),
  }), { ok: true });
  assert.equal(verifyMandate(SECRET, issued, { jobId: "job-2" }).code, "mandate_cross_job");
  assert.equal(verifyMandate(SECRET, issued, { workspaceId: "workspace-2" }).code, "mandate_cross_workspace");
  assert.equal(verifyMandate(SECRET, issued, { browserWorkspaceKey: "b".repeat(64) }).code, "mandate_cross_workspace");
  assert.equal(verifyMandate(SECRET, issued, { controllerEpoch: "other-epoch" }).code, "mandate_controller_restarted");
  assert.equal(verifyMandate(SECRET, issued, { taskHash: taskHash("post something else") }).code, "mandate_task_mismatch");
  assert.equal(verifyMandate("another-workspace-secret-value-000000", issued).code, "mandate_forged");
});

test("a tampered scope or budget breaks the mandate MAC", () => {
  const issued = mandate();
  for (const forged of [
    { ...issued, origins: [...issued.origins, "example.com"] },
    { ...issued, actionClasses: [...issued.actionClasses, "publish-post"] },
    { ...issued, budget: { ...issued.budget, submits: 99 } },
    { ...issued, expiresAt: new Date(Date.now() + 10 * 60 * 60_000).toISOString() },
  ]) {
    assert.equal(verifyMandate(SECRET, forged).ok, false);
  }
});

test("expiry and an over-long TTL fail closed", () => {
  const past = new Date(Date.now() - 60 * 60_000);
  const expired = mandate({ issuedAt: past.toISOString(), expiresAt: new Date(past.getTime() + 60_000).toISOString() });
  assert.equal(verifyMandate(SECRET, expired).code, "mandate_expired");
  const long = mandate({ expiresAt: new Date(Date.now() + 10 * 60 * 60_000).toISOString() });
  assert.equal(verifyMandate(SECRET, { ...long, mac: long.mac }).ok, false);
  assert.equal(clampTtlMinutes(10_000), 120);
  assert.equal(clampTtlMinutes(undefined), 45);
  assert.throws(() => clampTtlMinutes(0), /positive integer/);
});

test("requested budgets can only narrow, never widen", () => {
  assert.deepEqual(clampBudget({ submits: 1, publishes: 0 }), { ...DEFAULT_BUDGET, submits: 1, publishes: 0 });
  assert.deepEqual(clampBudget({ submits: 10_000 }).submits, 20);
  assert.throws(() => clampBudget({ edits: -1 }), /non-negative/);
});

test("the controller guard refuses forged, replayed, restarted, and cross-workspace mandates", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  guard.bindWorkspace("a".repeat(64));
  assert.equal(guard.activate({ ...mandate(), mac: "0".repeat(64) }).code, "mandate_forged");
  assert.equal(guard.activate(mandate({ controllerEpoch: "restarted-epoch" })).code, "mandate_controller_restarted");
  assert.equal(guard.activate(mandate({ browserWorkspaceKey: "b".repeat(64) })).code, "mandate_cross_workspace");
  const first = mandate();
  assert.equal(guard.activate(first).ok, true);
  assert.equal(guard.activate(mandate({ jobId: "job-2" })).code, "mandate_already_active");
  guard.revoke("job_finished");
  assert.equal(guard.activate(first).code, "mandate_replayed");
});

test("a worker cannot mint a mandate: the key never leaves the host and controller", () => {
  const workerAttempt = { ...mandate(), mandateId: randomUUID(), mac: "f".repeat(64) };
  const guard = new MandateGuard(SECRET, EPOCH);
  assert.equal(guard.activate(workerAttempt).code, "mandate_forged");
  const uninitialized = new MandateGuard(undefined, EPOCH);
  assert.equal(uninitialized.activate(mandate()).code, "control_uninitialized");
});

test("per-request packets are single use, ordered, and bound to the exact body", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  const issued = mandate();
  guard.activate(issued);
  const body = { url: "https://www.linkedin.com/in/example" };
  const auth = signRequest(SECRET, { mandateId: issued.mandateId, seq: 1, path: "/ps/navigate", body });
  assert.equal(guard.verifyRequest("/ps/navigate", body, auth).ok, true);
  assert.equal(guard.verifyRequest("/ps/navigate", body, auth).code, "mandate_replayed");
  const second = signRequest(SECRET, { mandateId: issued.mandateId, seq: 2, path: "/ps/navigate", body });
  assert.equal(guard.verifyRequest("/ps/navigate", { url: "https://www.linkedin.com/psettings" }, second).code, "request_unauthorized");
  assert.equal(guard.verifyRequest("/ps/act", body, second).code, "request_unauthorized");
  const stale = signRequest(SECRET, { mandateId: issued.mandateId, seq: 3, path: "/ps/navigate", body });
  assert.equal(guard.verifyRequest("/ps/navigate", body, { ...stale, timestamp: Date.now() - 120_000 }).code, "request_stale");
});

test("controller budgets and the circuit breaker stop a runaway mandate", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  guard.activate(mandate({ budget: { ...DEFAULT_BUDGET, submits: 1 } }));
  assert.equal(guard.checkBudget(["submits"]), undefined);
  guard.charge(["submits"]);
  assert.equal(guard.checkBudget(["submits"]), "budget_exhausted_submits");
  for (let attempt = 0; attempt < CIRCUIT_BREAKER.maxDiffMismatches; attempt += 1) guard.recordDenial("diff_mismatch");
  assert.equal(guard.revokedReason, "circuit_breaker_diff_mismatch");
  assert.equal(guard.verifyRequest("/ps/act", {}, {}).code, "mandate_revoked:circuit_breaker_diff_mismatch");
});

test("host sessions trip the breaker on consecutive denials and refuse to widen budgets", () => {
  const session = new MandateSession(mandate({ budget: { ...DEFAULT_BUDGET, edits: 1 } }));
  assert.equal(session.checkBudget(["edits"]), undefined);
  session.charge(["edits", "actions"]);
  assert.equal(session.checkBudget(["edits"]), "budget_exhausted_edits");
  for (let attempt = 0; attempt < CIRCUIT_BREAKER.maxConsecutiveDenials; attempt += 1) session.recordDenial("origin_not_authorized");
  assert.equal(session.revoked, true);
  assert.equal(session.revocation, "circuit_breaker_consecutive_denials");
});

test("identity tags are opaque, keyed, and distinguish login from account drift", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  guard.activate(mandate());
  const empty = guard.identityTag("www.linkedin.com", []);
  const account = guard.identityTag("www.linkedin.com", [{ name: "li_at", value: "session-value-one" }]);
  const other = guard.identityTag("www.linkedin.com", [{ name: "li_at", value: "session-value-two" }]);
  assert.equal(empty, "empty");
  assert.notEqual(account, other);
  assert.equal(account.includes("session-value-one"), false);
  guard.recordIdentity("www.linkedin.com", empty);
  assert.equal(guard.compareIdentity("www.linkedin.com", account).state, "established");
  guard.recordIdentity("www.linkedin.com", account);
  assert.equal(guard.compareIdentity("www.linkedin.com", account).state, "stable");
  assert.equal(guard.compareIdentity("www.linkedin.com", other).state, "drift");
});

test("identity drift after a takeover revokes the mandate while a fresh login does not", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  guard.activate(mandate());
  const origin = "www.linkedin.com";
  guard.recordIdentity(origin, guard.identityTag(origin, []));

  // The operator logs in during takeover: adoption, not drift.
  const account = guard.identityTag(origin, [{ name: "li_at", value: "session-one" }]);
  assert.equal(guard.compareIdentity(origin, account).state, "established");
  guard.recordIdentity(origin, account);
  assert.equal(guard.revokedReason, undefined);

  // A different account behind the same workspace is drift and must stop the run.
  const other = guard.identityTag(origin, [{ name: "li_at", value: "session-two" }]);
  if (guard.compareIdentity(origin, other).state === "drift") guard.revoke("identity_drift");
  assert.equal(guard.revokedReason, "identity_drift");
  assert.equal(guard.verifyRequest("/ps/act", {}, {}).code, "mandate_revoked:identity_drift");
});

test("a second task mandate starts from a clean budget and breaker", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  guard.activate(mandate());
  guard.charge(["actions", "submits"]);
  guard.recordDenial("hard_deny_surface");
  guard.revoke("job_finished");
  guard.activate(mandate({ jobId: "job-2" }));
  assert.deepEqual(guard.use, { actions: 0, edits: 0, submits: 0, publishes: 0, uploads: 0, denials: 0, diffMismatches: 0 });
});

test("host and controller derive the same mandate authority from one secret", () => {
  const guard = new MandateGuard(SECRET, EPOCH);
  const issued = mandate();
  assert.equal(guard.activate(issued).ok, true);
  assert.equal(guard.allowsOrigin("www.linkedin.com"), true);
  assert.equal(guard.allowsOrigin("www.xing.com"), false);
  assert.equal(guard.allowsClass("submit-profile"), true);
  assert.equal(guard.allowsClass("publish-post"), false);
});
