import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { stableStringify } from "./identity.ts";
import type { ActionClass } from "./site-rules.ts";

/**
 * Task-bound host mandate.
 *
 * The operator authorizes one bounded task; the trusted host then mints a
 * single mandate that binds the job, workspace, browser workspace, controller
 * process epoch, task hash, origins, action classes, budgets, and TTL. The
 * untrusted worker never receives, reads, or extends it: the mandate travels
 * only between the host bridge and the browser controller, which verifies it
 * with a key derived from the host-only browser control secret.
 */
export const MANDATE_VERSION = 1;
export const MANDATE_KEY_LABEL = "openshell-professional-socials-mandate-v1";
export const DEFAULT_TTL_MINUTES = 45;
export const MAX_TTL_MINUTES = 120;
export const MAX_REQUEST_SKEW_MS = 60_000;

export interface MandateBudget {
  actions: number;
  edits: number;
  submits: number;
  publishes: number;
  uploads: number;
}

export const DEFAULT_BUDGET: Readonly<MandateBudget> = Object.freeze({
  actions: 400,
  edits: 60,
  submits: 6,
  publishes: 2,
  uploads: 2,
});

export const MAX_BUDGET: Readonly<MandateBudget> = Object.freeze({
  actions: 1200,
  edits: 200,
  submits: 20,
  publishes: 5,
  uploads: 10,
});

export interface MandateBody {
  version: number;
  mandateId: string;
  jobId: string;
  workspaceId: string;
  browserWorkspaceKey: string;
  controllerEpoch: string;
  taskHash: string;
  sites: string[];
  origins: string[];
  actionClasses: string[];
  budget: MandateBudget;
  issuedAt: string;
  expiresAt: string;
}

export interface Mandate extends MandateBody {
  mac: string;
}

export interface MandateExpectation {
  jobId?: string;
  workspaceId?: string;
  browserWorkspaceKey?: string;
  controllerEpoch?: string;
  taskHash?: string;
  now?: number;
}

export function mandateKey(controlSecret: string): Buffer {
  return createHmac("sha256", controlSecret).update(MANDATE_KEY_LABEL).digest();
}

export function taskHash(task: string): string {
  return createHash("sha256").update(task.normalize("NFC")).digest("hex");
}

export function canonicalMandate(body: MandateBody): string {
  return stableStringify({
    version: body.version,
    mandateId: body.mandateId,
    jobId: body.jobId,
    workspaceId: body.workspaceId,
    browserWorkspaceKey: body.browserWorkspaceKey,
    controllerEpoch: body.controllerEpoch,
    taskHash: body.taskHash,
    sites: [...body.sites].sort(),
    origins: [...body.origins].sort(),
    actionClasses: [...body.actionClasses].sort(),
    budget: body.budget,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  });
}

export function issueMandate(controlSecret: string, body: Omit<MandateBody, "version" | "mandateId">): Mandate {
  const full: MandateBody = { ...body, version: MANDATE_VERSION, mandateId: randomUUID() };
  return { ...full, mac: createHmac("sha256", mandateKey(controlSecret)).update(canonicalMandate(full)).digest("hex") };
}

export function verifyMandate(controlSecret: string, mandate: Mandate, expect: MandateExpectation = {}): { ok: boolean; code?: string } {
  if (!mandate || typeof mandate !== "object") return { ok: false, code: "mandate_missing" };
  if (mandate.version !== MANDATE_VERSION) return { ok: false, code: "mandate_version" };
  if (typeof mandate.mac !== "string" || !/^[a-f0-9]{64}$/.test(mandate.mac)) return { ok: false, code: "mandate_forged" };
  const expected = createHmac("sha256", mandateKey(controlSecret)).update(canonicalMandate(mandate)).digest();
  const supplied = Buffer.from(mandate.mac, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { ok: false, code: "mandate_forged" };
  const now = expect.now ?? Date.now();
  const issuedAt = Date.parse(mandate.issuedAt);
  const expiresAt = Date.parse(mandate.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return { ok: false, code: "mandate_window" };
  if (expiresAt - issuedAt > MAX_TTL_MINUTES * 60_000) return { ok: false, code: "mandate_ttl_too_long" };
  if (now > expiresAt) return { ok: false, code: "mandate_expired" };
  if (expect.jobId !== undefined && expect.jobId !== mandate.jobId) return { ok: false, code: "mandate_cross_job" };
  if (expect.workspaceId !== undefined && expect.workspaceId !== mandate.workspaceId) return { ok: false, code: "mandate_cross_workspace" };
  if (expect.browserWorkspaceKey !== undefined && expect.browserWorkspaceKey !== mandate.browserWorkspaceKey) {
    return { ok: false, code: "mandate_cross_workspace" };
  }
  if (expect.controllerEpoch !== undefined && expect.controllerEpoch !== mandate.controllerEpoch) return { ok: false, code: "mandate_controller_restarted" };
  if (expect.taskHash !== undefined && expect.taskHash !== mandate.taskHash) return { ok: false, code: "mandate_task_mismatch" };
  if (!Array.isArray(mandate.origins) || mandate.origins.length === 0) return { ok: false, code: "mandate_origins" };
  if (!Array.isArray(mandate.actionClasses) || mandate.actionClasses.length === 0) return { ok: false, code: "mandate_classes" };
  return { ok: true };
}

/**
 * One-time control packet for the host-only browser control plane. The VNC
 * password is derived independently by host and controller from the shared
 * secret, so it is never transmitted.
 */
export function browserControlPacket(secret: string, action: string) {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const mac = createHmac("sha256", secret).update(`${action}:${timestamp}:${nonce}`).digest("hex");
  const vncPassword = createHmac("sha256", secret).update("vnc").digest("hex").slice(0, 8);
  return { packet: { timestamp, nonce, mac }, vncPassword };
}

export interface RequestAuth {
  mandateId: string;
  seq: number;
  nonce: string;
  timestamp: number;
  mac: string;
}

export function requestMac(controlSecret: string, input: { mandateId: string; seq: number; path: string; body: unknown; nonce: string; timestamp: number }): string {
  const digest = createHash("sha256").update(stableStringify(input.body ?? null)).digest("hex");
  return createHmac("sha256", mandateKey(controlSecret))
    .update(`request-v1:${input.mandateId}:${input.seq}:${input.path}:${digest}:${input.nonce}:${input.timestamp}`)
    .digest("hex");
}

export function signRequest(controlSecret: string, input: { mandateId: string; seq: number; path: string; body: unknown }): RequestAuth {
  const nonce = randomUUID();
  const timestamp = Date.now();
  return {
    mandateId: input.mandateId,
    seq: input.seq,
    nonce,
    timestamp,
    mac: requestMac(controlSecret, { ...input, nonce, timestamp }),
  };
}

export interface BudgetUse extends MandateBudget {
  denials: number;
  diffMismatches: number;
}

export const CIRCUIT_BREAKER = Object.freeze({
  maxDenials: 5,
  maxConsecutiveDenials: 3,
  maxDiffMismatches: 2,
});

/** Host-side budget and circuit-breaker accounting for one mandate. */
export class MandateSession {
  readonly mandate: Mandate;
  readonly use: BudgetUse = { actions: 0, edits: 0, submits: 0, publishes: 0, uploads: 0, denials: 0, diffMismatches: 0 };
  private consecutiveDenials = 0;
  private sequence = 0;
  private revokedReason?: string;

  constructor(mandate: Mandate) {
    this.mandate = mandate;
  }

  get revoked(): boolean {
    return this.revokedReason !== undefined;
  }

  get revocation(): string | undefined {
    return this.revokedReason;
  }

  nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  revoke(reason: string): void {
    this.revokedReason ??= reason;
  }

  /** Returns a denial code when the requested charge exceeds the mandate budget. */
  checkBudget(dimensions: Array<keyof MandateBudget>): string | undefined {
    for (const dimension of dimensions) {
      if (this.use[dimension] + 1 > this.mandate.budget[dimension]) return `budget_exhausted_${dimension}`;
    }
    return undefined;
  }

  charge(dimensions: Array<keyof MandateBudget>): void {
    for (const dimension of dimensions) this.use[dimension] += 1;
    this.consecutiveDenials = 0;
  }

  recordDenial(code: string): void {
    this.use.denials += 1;
    this.consecutiveDenials += 1;
    if (code === "diff_mismatch") this.use.diffMismatches += 1;
    if (this.use.diffMismatches >= CIRCUIT_BREAKER.maxDiffMismatches) this.revoke("circuit_breaker_diff_mismatch");
    else if (this.consecutiveDenials >= CIRCUIT_BREAKER.maxConsecutiveDenials) this.revoke("circuit_breaker_consecutive_denials");
    else if (this.use.denials >= CIRCUIT_BREAKER.maxDenials) this.revoke("circuit_breaker_denials");
  }
}

export function budgetDimensions(actionClass: ActionClass, kind: "read" | "edit" | "upload" | "submit" | "publish"): Array<keyof MandateBudget> {
  const dimensions: Array<keyof MandateBudget> = ["actions"];
  if (kind === "edit") dimensions.push("edits");
  if (kind === "upload") dimensions.push("uploads");
  if (kind === "submit") dimensions.push("submits");
  if (kind === "publish") dimensions.push("publishes");
  void actionClass;
  return dimensions;
}

export function clampBudget(requested: Partial<MandateBudget> | undefined): MandateBudget {
  const budget = { ...DEFAULT_BUDGET } as MandateBudget;
  for (const key of Object.keys(budget) as Array<keyof MandateBudget>) {
    const value = requested?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) throw new Error(`budget.${key} must be a non-negative integer`);
    budget[key] = Math.min(value, MAX_BUDGET[key]);
  }
  return budget;
}

export function clampTtlMinutes(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(requested) || requested < 1) throw new Error("ttlMinutes must be a positive integer");
  return Math.min(requested, MAX_TTL_MINUTES);
}
