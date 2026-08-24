export interface ControllerMandate {
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
  budget: Record<string, number>;
  issuedAt: string;
  expiresAt: string;
  mac: string;
}

export interface GuardVerdict {
  ok: boolean;
  code?: string;
  reactivated?: boolean;
}

export function mandateKey(controlSecret: string): Buffer;
export function stableStringify(value: unknown): string;

export class MandateGuard {
  constructor(controlSecret: string | undefined, epoch: string);
  active?: ControllerMandate;
  revokedReason?: string;
  use: { actions: number; edits: number; submits: number; publishes: number; uploads: number; denials: number; diffMismatches: number };
  bindWorkspace(browserWorkspaceKey: string): void;
  activate(mandate: unknown): GuardVerdict;
  revoke(reason: string): void;
  verifyRequest(path: string, body: unknown, auth: unknown, expect?: { jobId?: string }): GuardVerdict;
  allowsOrigin(host: string): boolean;
  allowsClass(actionClass: string): boolean;
  checkBudget(dimensions: string[]): string | undefined;
  charge(dimensions: string[]): void;
  recordDenial(code: string): void;
  identityTag(origin: string, cookies: Array<{ name: string; value: string }>): string;
  recordIdentity(origin: string, tag: string): void;
  compareIdentity(origin: string, tag: string): { state: "unknown" | "stable" | "established" | "drift" };
}
