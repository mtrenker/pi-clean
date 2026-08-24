import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Controller-side mandate verification. The browser controller derives the
// mandate key from its own host-initialized control secret and re-checks every
// binding the host already checked, so a forged, expired, replayed, cross-job,
// cross-workspace, or pre-restart mandate is refused inside the sandbox too.
const MANDATE_VERSION = 1;
const MANDATE_KEY_LABEL = "openshell-professional-socials-mandate-v1";
const MAX_TTL_MS = 120 * 60_000;
const MAX_REQUEST_SKEW_MS = 60_000;
const CIRCUIT_BREAKER = { maxDenials: 5, maxConsecutiveDenials: 3, maxDiffMismatches: 2 };

export function mandateKey(controlSecret) {
  return createHmac("sha256", controlSecret).update(MANDATE_KEY_LABEL).digest();
}

export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function canonicalMandate(body) {
  return stableStringify({
    version: body.version,
    mandateId: body.mandateId,
    jobId: body.jobId,
    workspaceId: body.workspaceId,
    browserWorkspaceKey: body.browserWorkspaceKey,
    controllerEpoch: body.controllerEpoch,
    taskHash: body.taskHash,
    sites: Array.isArray(body.sites) ? [...body.sites].sort() : body.sites,
    origins: Array.isArray(body.origins) ? [...body.origins].sort() : body.origins,
    actionClasses: Array.isArray(body.actionClasses) ? [...body.actionClasses].sort() : body.actionClasses,
    budget: body.budget,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  });
}

function equalMac(hex, expected) {
  if (typeof hex !== "string" || !/^[a-f0-9]{64}$/.test(hex)) return false;
  const supplied = Buffer.from(hex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class MandateGuard {
  constructor(controlSecret, epoch) {
    this.controlSecret = controlSecret;
    this.epoch = epoch;
    this.boundWorkspaceKey = undefined;
    this.active = undefined;
    this.retired = new Set();
    this.usedNonces = new Set();
    this.lastSeq = 0;
    this.use = { actions: 0, edits: 0, submits: 0, publishes: 0, uploads: 0, denials: 0, diffMismatches: 0 };
    this.consecutiveDenials = 0;
    this.revokedReason = undefined;
    this.identity = new Map();
  }

  bindWorkspace(browserWorkspaceKey) {
    this.boundWorkspaceKey = browserWorkspaceKey;
  }

  activate(mandate) {
    if (!this.controlSecret) return { ok: false, code: "control_uninitialized" };
    if (!mandate || typeof mandate !== "object") return { ok: false, code: "mandate_missing" };
    if (mandate.version !== MANDATE_VERSION) return { ok: false, code: "mandate_version" };
    if (!equalMac(mandate.mac, createHmac("sha256", mandateKey(this.controlSecret)).update(canonicalMandate(mandate)).digest())) {
      return { ok: false, code: "mandate_forged" };
    }
    if (typeof mandate.mandateId !== "string" || !/^[a-f0-9-]{36}$/.test(mandate.mandateId)) return { ok: false, code: "mandate_missing" };
    if (this.retired.has(mandate.mandateId)) return { ok: false, code: "mandate_replayed" };
    if (this.active && this.active.mandateId !== mandate.mandateId) return { ok: false, code: "mandate_already_active" };
    if (mandate.controllerEpoch !== this.epoch) return { ok: false, code: "mandate_controller_restarted" };
    if (this.boundWorkspaceKey && mandate.browserWorkspaceKey !== this.boundWorkspaceKey) return { ok: false, code: "mandate_cross_workspace" };
    const issuedAt = Date.parse(mandate.issuedAt);
    const expiresAt = Date.parse(mandate.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
      return { ok: false, code: "mandate_window" };
    }
    if (Date.now() > expiresAt) return { ok: false, code: "mandate_expired" };
    if (!Array.isArray(mandate.origins) || mandate.origins.length === 0) return { ok: false, code: "mandate_origins" };
    if (!Array.isArray(mandate.actionClasses) || mandate.actionClasses.length === 0) return { ok: false, code: "mandate_classes" };
    if (this.active && this.active.mandateId === mandate.mandateId) return { ok: true, reactivated: true };
    this.boundWorkspaceKey ??= mandate.browserWorkspaceKey;
    this.active = mandate;
    this.lastSeq = 0;
    this.usedNonces = new Set();
    this.revokedReason = undefined;
    // Budgets, breaker state, and observed identity belong to one task mandate.
    // A later job in the same persistent browser starts from zero; replay
    // protection (`retired`) deliberately survives for the process lifetime.
    this.use = { actions: 0, edits: 0, submits: 0, publishes: 0, uploads: 0, denials: 0, diffMismatches: 0 };
    this.consecutiveDenials = 0;
    this.identity = new Map();
    return { ok: true };
  }

  revoke(reason) {
    if (this.active) this.retired.add(this.active.mandateId);
    this.active = undefined;
    this.revokedReason = reason;
    this.lastSeq = 0;
    this.usedNonces = new Set();
  }

  /** Verifies mandate state plus the per-request authorization packet. */
  verifyRequest(path, body, auth, expect = {}) {
    if (!this.active) return { ok: false, code: this.revokedReason ? `mandate_revoked:${this.revokedReason}` : "mandate_missing" };
    if (Date.now() > Date.parse(this.active.expiresAt)) {
      this.revoke("expired");
      return { ok: false, code: "mandate_expired" };
    }
    if (this.active.controllerEpoch !== this.epoch) return { ok: false, code: "mandate_controller_restarted" };
    if (!auth || typeof auth !== "object") return { ok: false, code: "request_unauthorized" };
    if (auth.mandateId !== this.active.mandateId) return { ok: false, code: "mandate_cross_job" };
    if (expect.jobId !== undefined && expect.jobId !== this.active.jobId) return { ok: false, code: "mandate_cross_job" };
    if (!Number.isInteger(auth.seq) || auth.seq <= this.lastSeq) return { ok: false, code: "mandate_replayed" };
    if (typeof auth.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(auth.nonce) || this.usedNonces.has(auth.nonce)) {
      return { ok: false, code: "mandate_replayed" };
    }
    if (typeof auth.timestamp !== "number" || Math.abs(Date.now() - auth.timestamp) > MAX_REQUEST_SKEW_MS) {
      return { ok: false, code: "request_stale" };
    }
    const digest = createHash("sha256").update(stableStringify(body ?? null)).digest("hex");
    const expected = createHmac("sha256", mandateKey(this.controlSecret))
      .update(`request-v1:${auth.mandateId}:${auth.seq}:${path}:${digest}:${auth.nonce}:${auth.timestamp}`)
      .digest();
    if (!equalMac(auth.mac, expected)) return { ok: false, code: "request_unauthorized" };
    this.lastSeq = auth.seq;
    this.usedNonces.add(auth.nonce);
    if (this.usedNonces.size > 5000) this.usedNonces = new Set([auth.nonce]);
    return { ok: true };
  }

  allowsOrigin(host) {
    return Boolean(this.active?.origins.includes(String(host).toLowerCase()));
  }

  allowsClass(actionClass) {
    return Boolean(this.active?.actionClasses.includes(actionClass));
  }

  checkBudget(dimensions) {
    for (const dimension of dimensions) {
      if (this.use[dimension] + 1 > (this.active?.budget?.[dimension] ?? 0)) return `budget_exhausted_${dimension}`;
    }
    return undefined;
  }

  charge(dimensions) {
    for (const dimension of dimensions) this.use[dimension] += 1;
    this.consecutiveDenials = 0;
  }

  recordDenial(code) {
    this.use.denials += 1;
    this.consecutiveDenials += 1;
    if (code === "diff_mismatch") this.use.diffMismatches += 1;
    if (this.use.diffMismatches >= CIRCUIT_BREAKER.maxDiffMismatches) this.revoke("circuit_breaker_diff_mismatch");
    else if (this.consecutiveDenials >= CIRCUIT_BREAKER.maxConsecutiveDenials) this.revoke("circuit_breaker_consecutive_denials");
    else if (this.use.denials >= CIRCUIT_BREAKER.maxDenials) this.revoke("circuit_breaker_denials");
  }

  /**
   * Opaque, keyed, truncated session tag per origin. Cookie values never leave
   * the controller; only this tag is comparable across a takeover boundary.
   */
  identityTag(origin, cookies) {
    const material = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .sort()
      .join("\n");
    if (!material) return "empty";
    return createHmac("sha256", mandateKey(this.controlSecret)).update(`identity:${origin}:${material}`).digest("hex").slice(0, 12);
  }

  recordIdentity(origin, tag) {
    this.identity.set(origin, tag);
  }

  /** empty -> established is adoption; established -> different is drift. */
  compareIdentity(origin, tag) {
    const previous = this.identity.get(origin);
    if (previous === undefined) return { state: "unknown" };
    if (previous === tag) return { state: "stable" };
    if (previous === "empty") return { state: "established" };
    return { state: "drift" };
  }
}
