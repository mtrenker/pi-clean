import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeBridgeAction,
  describeAction,
  isPunitive,
  PROFESSIONAL_SOCIALS_BRIDGE_PATHS,
  SAFE_BRIDGE_PATHS,
  type BridgeState,
} from "./browser-bridge.ts";
import { DEFAULT_BUDGET, issueMandate, MandateSession, taskHash, type Mandate } from "./mandate.ts";
import { loadSiteRules } from "./site-rules.ts";

const rules = loadSiteRules();
const SECRET = "host-only-browser-control-secret-value";

function session(overrides: Partial<Mandate> = {}): MandateSession {
  const issuedAt = new Date();
  const mandate = issueMandate(SECRET, {
    jobId: "job-1",
    workspaceId: "workspace-1",
    browserWorkspaceKey: "a".repeat(64),
    controllerEpoch: "epoch-1",
    taskHash: taskHash("update the profile"),
    sites: ["linkedin"],
    origins: ["www.linkedin.com", "linkedin.com"],
    actionClasses: ["read", "edit-profile", "submit-profile"],
    budget: { ...DEFAULT_BUDGET },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 30 * 60_000).toISOString(),
  });
  return new MandateSession({ ...mandate, ...overrides });
}

const onProfile: BridgeState = { lastUrl: "https://www.linkedin.com/in/martin" };

test("the safe bridge surface is unchanged and disjoint from the autonomous one", () => {
  assert.deepEqual([...SAFE_BRIDGE_PATHS], ["/navigate", "/snapshot", "/click", "/type", "/press"]);
  for (const path of PROFESSIONAL_SOCIALS_BRIDGE_PATHS) {
    assert.equal(SAFE_BRIDGE_PATHS.includes(path), false, path);
    assert.match(path, /^\/ps\//);
  }
});

test("malformed worker requests are rejected before any authority is consulted", () => {
  const cases: Array<[string, unknown, string]> = [
    ["/ps/navigate", { url: 42 }, "invalid_url"],
    ["/ps/act", { op: "evaluate", ref: "e1-1" }, "invalid_op"],
    ["/ps/act", { op: "fill", ref: "#password" }, "invalid_ref"],
    ["/ps/act", { op: "fill", ref: "e1-1", text: "x".repeat(9000) }, "invalid_text"],
    ["/ps/upload", { ref: "e1-1", artifact: "../../etc/passwd" }, "invalid_artifact"],
    ["/ps/submit", { ref: "e1-1", checkpointId: "nope", intent: "submit-profile", expected: [] }, "invalid_checkpoint"],
    ["/ps/submit", { ref: "e1-1", checkpointId: "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12), intent: "delete-account", expected: [{ ref: "e1-2", before: "a", after: "b" }] }, "invalid_intent"],
    ["/evaluate", {}, "path_not_allowed"],
  ];
  for (const [path, body, code] of cases) {
    assert.deepEqual(describeAction({ path, body }), { error: code }, `${path} ${JSON.stringify(body)}`);
  }
});

test("one authorization covers reads, edits, submits, and publishes inside its scope", () => {
  const active = session();
  const checkpointId = "11111111-2222-4333-8444-555555555555";
  const allowed = [
    { path: "/ps/navigate", body: { url: "https://www.linkedin.com/in/martin" } },
    { path: "/ps/snapshot", body: {} },
    { path: "/ps/checkpoint", body: { refs: ["e1-4"] } },
    { path: "/ps/act", body: { op: "fill", ref: "e1-4", text: "Fractional CTO" } },
    { path: "/ps/submit", body: { ref: "e1-9", checkpointId, intent: "submit-profile", expected: [{ ref: "e1-4", before: "CTO", after: "Fractional CTO" }] } },
  ];
  for (const request of allowed) {
    const decision = authorizeBridgeAction(rules, active, onProfile, request);
    assert.equal(decision.allowed, true, `${request.path}: ${decision.code}`);
    active.charge(decision.budget ?? ["actions"]);
  }
  assert.equal(active.use.submits, 1);
  assert.equal(active.use.edits, 1);
  assert.equal(active.use.denials, 0);
});

test("origin, class, and surface confinement hold at the host gate", () => {
  const active = session();
  assert.equal(authorizeBridgeAction(rules, active, onProfile, { path: "/ps/navigate", body: { url: "https://www.xing.com/profile/martin" } }).code, "origin_not_authorized");
  assert.equal(authorizeBridgeAction(rules, active, onProfile, { path: "/ps/navigate", body: { url: "http://www.linkedin.com/in/martin" } }).code, "insecure_navigation");
  assert.equal(authorizeBridgeAction(rules, active, onProfile, { path: "/ps/navigate", body: { url: "https://www.linkedin.com/psettings/account" } }).code, "hard_deny_surface");
  assert.equal(authorizeBridgeAction(rules, active, { lastUrl: "https://example.com/page" }, { path: "/ps/act", body: { op: "fill", ref: "e1-1", text: "x" } }).code, "surface_class_denied");
  assert.equal(
    authorizeBridgeAction(rules, active, { lastUrl: "https://www.linkedin.com/feed/" }, {
      path: "/ps/submit",
      body: { ref: "e1-2", checkpointId: "11111111-2222-4333-8444-555555555555", intent: "publish-post", expected: [{ ref: "e1-1", before: "", after: "hello" }] },
    }).code,
    "class_not_granted",
    "publishing needs its own granted class",
  );
});

test("a redirect to an unlisted origin leaves the run read-only instead of denying reads", () => {
  const active = session();
  const redirected: BridgeState = { lastUrl: "https://consent.example.com/notice" };
  assert.equal(authorizeBridgeAction(rules, active, redirected, { path: "/ps/snapshot", body: {} }).allowed, true);
  assert.equal(authorizeBridgeAction(rules, active, redirected, { path: "/ps/act", body: { op: "click", ref: "e1-1" } }).allowed, true);
  assert.equal(authorizeBridgeAction(rules, active, redirected, { path: "/ps/act", body: { op: "fill", ref: "e1-1", text: "x" } }).allowed, false);
});

test("budgets and the circuit breaker end an autonomous run without widening anything", () => {
  const active = session();
  active.mandate.budget.submits = 1;
  const submit = {
    path: "/ps/submit",
    body: { ref: "e1-9", checkpointId: "11111111-2222-4333-8444-555555555555", intent: "submit-profile", expected: [{ ref: "e1-4", before: "a", after: "b" }] },
  };
  const first = authorizeBridgeAction(rules, active, onProfile, submit);
  assert.equal(first.allowed, true);
  active.charge(first.budget!);
  assert.equal(authorizeBridgeAction(rules, active, onProfile, submit).code, "budget_exhausted_submits");

  const breaking = session();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const decision = authorizeBridgeAction(rules, breaking, onProfile, { path: "/ps/navigate", body: { url: "https://www.xing.com/profile/x" } });
    assert.equal(decision.allowed, false);
    breaking.recordDenial(decision.code!);
  }
  assert.equal(breaking.revoked, true);
  assert.match(authorizeBridgeAction(rules, breaking, onProfile, { path: "/ps/snapshot", body: {} }).code!, /^mandate_revoked:/);
});

test("only authorization refusals feed the circuit breaker", () => {
  for (const code of ["hard_deny_surface", "origin_not_authorized", "diff_mismatch", "budget_exhausted_submits"]) {
    assert.equal(isPunitive(code), true, code);
  }
  for (const code of ["invalid_ref", "stale_ref", "automation_paused", "manual_takeover_required", "no_current_page", "bridge_transport_failed", undefined]) {
    assert.equal(isPunitive(code), false, String(code));
  }
});

test("reads before the first navigation are allowed while mutations still need a page", () => {
  const active = session();
  assert.equal(authorizeBridgeAction(rules, active, {}, { path: "/ps/snapshot", body: {} }).allowed, true);
  assert.equal(authorizeBridgeAction(rules, active, {}, { path: "/ps/act", body: { op: "fill", ref: "e1-1", text: "x" } }).code, "no_current_page");
});

test("an expired mandate revokes itself at the host gate", () => {
  const expired = session();
  expired.mandate.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(authorizeBridgeAction(rules, expired, onProfile, { path: "/ps/snapshot", body: {} }).code, "mandate_expired");
  assert.equal(expired.revoked, true);
});
