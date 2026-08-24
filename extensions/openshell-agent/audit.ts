import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { BudgetUse, Mandate } from "./mandate.ts";

/**
 * Trusted host-side audit ledger.
 *
 * Every entry is written by the host bridge from controller-observed facts, so
 * the review report stays valid even when the untrusted worker narrative
 * disagrees with it. Ledgers live under the trust-domain-scoped workspace
 * directory; another trust domain resolves a different workspace id and cannot
 * read or write these records.
 */
export const MAX_LEDGER_VALUE = 240;

export interface LedgerFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface LedgerEntry {
  at: string;
  seq: number;
  action: string;
  decision: "allow" | "deny" | "anomaly";
  actionClass?: string;
  site?: string;
  origin?: string;
  surface?: string;
  url?: string;
  code?: string;
  note?: string;
  changes?: LedgerFieldChange[];
  permalink?: string;
}

export interface LedgerSummary {
  jobId: string;
  workspaceId: string;
  trustDomain: string;
  browserProfile: string;
  sites: string[];
  origins: string[];
  actionClasses: string[];
  mandateId: string;
  issuedAt: string;
  expiresAt: string;
}

export function auditRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "openshell-agent-audit");
}

export function auditDirFor(workspaceId: string, agentDir?: string): string {
  return join(auditRoot(agentDir), workspaceId);
}

export class JobLedger {
  readonly path: string;
  readonly summary: LedgerSummary;
  readonly entries: LedgerEntry[] = [];
  private seq = 0;
  private writeFailure?: string;

  constructor(summary: LedgerSummary, agentDir?: string) {
    this.summary = summary;
    this.path = join(auditDirFor(summary.workspaceId, agentDir), `${summary.jobId}.jsonl`);
  }

  static fromMandate(mandate: Mandate, context: { trustDomain: string; browserProfile: string }, agentDir?: string): JobLedger {
    return new JobLedger({
      jobId: mandate.jobId,
      workspaceId: mandate.workspaceId,
      trustDomain: context.trustDomain,
      browserProfile: context.browserProfile,
      sites: mandate.sites,
      origins: mandate.origins,
      actionClasses: mandate.actionClasses,
      mandateId: mandate.mandateId,
      issuedAt: mandate.issuedAt,
      expiresAt: mandate.expiresAt,
    }, agentDir);
  }

  async append(entry: Omit<LedgerEntry, "at" | "seq">): Promise<LedgerEntry> {
    this.seq += 1;
    const record: LedgerEntry = {
      at: new Date().toISOString(),
      seq: this.seq,
      ...entry,
      note: entry.note === undefined ? undefined : redactValue(entry.note),
      url: entry.url === undefined ? undefined : redactUrl(entry.url),
      permalink: entry.permalink === undefined ? undefined : redactUrl(entry.permalink),
      changes: entry.changes?.slice(0, 32).map((change) => ({
        field: redactValue(change.field),
        before: redactValue(change.before),
        after: redactValue(change.after),
      })),
    };
    this.entries.push(record);
    try {
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.writeFailure ??= error instanceof Error ? error.message : String(error);
    }
    return record;
  }

  report(use: BudgetUse, outcome: { status: string; revocation?: string }): string {
    return renderReport(this.summary, this.entries, use, outcome, this.writeFailure);
  }
}

export function renderReport(
  summary: LedgerSummary,
  entries: LedgerEntry[],
  use: BudgetUse,
  outcome: { status: string; revocation?: string },
  writeFailure?: string,
): string {
  const submits = entries.filter((entry) => entry.action === "submit" && entry.decision === "allow");
  const publishes = entries.filter((entry) => entry.action === "publish" && entry.decision === "allow");
  const denials = entries.filter((entry) => entry.decision === "deny");
  const anomalies = entries.filter((entry) => entry.decision === "anomaly");
  const changed = entries.filter((entry) => entry.decision === "allow" && entry.changes?.length);
  const lines: string[] = [
    "## Trusted professional-socials review report",
    "",
    "Host-authored from controller-observed actions. The worker narrative is separate and untrusted.",
    "",
    `- job: ${summary.jobId}`,
    `- workspace: ${summary.workspaceId} · trust domain: ${summary.trustDomain} · browser profile: ${summary.browserProfile}`,
    `- mandate: ${summary.mandateId} (issued ${summary.issuedAt}, expires ${summary.expiresAt})`,
    `- authorized sites: ${summary.sites.join(", ") || "none"}`,
    `- authorized action classes: ${summary.actionClasses.join(", ") || "none"}`,
    `- outcome: ${outcome.status}${outcome.revocation ? ` (mandate revoked: ${outcome.revocation})` : ""}`,
    "",
    "### Confirmed changes",
    "",
  ];
  if (changed.length === 0) lines.push("No field change was committed.", "");
  for (const entry of changed) {
    lines.push(`**${entry.action}** · ${entry.site ?? entry.origin ?? "unknown"} · ${entry.surface ?? "unknown surface"}`);
    for (const change of entry.changes ?? []) {
      lines.push(`- \`${change.field}\`: "${change.before}" -> "${change.after}"`);
    }
    if (entry.permalink) lines.push(`- confirmed link: ${entry.permalink}`);
    else if (entry.url) lines.push(`- confirmed at: ${entry.url}`);
    lines.push("");
  }
  lines.push(
    "### Submissions and publications",
    "",
    `- submits committed: ${submits.length}`,
    `- publications committed: ${publishes.length}`,
    ...publishes.map((entry) => `  - ${entry.permalink ?? entry.url ?? "no permalink observed"}`),
    "",
    "### Denials and anomalies",
    "",
  );
  if (denials.length === 0 && anomalies.length === 0) lines.push("None.");
  lines.push(
    ...denials.map((entry) => `- denied \`${entry.action}\` on ${entry.surface ?? entry.origin ?? "unknown"}: ${entry.code ?? "denied"}`),
    ...anomalies.map((entry) => `- anomaly on ${entry.surface ?? entry.origin ?? "unknown"}: ${entry.code ?? "anomaly"}${entry.note ? ` - ${entry.note}` : ""}`),
    "",
    "### Budget use",
    "",
    `- actions ${use.actions} · edits ${use.edits} · submits ${use.submits} · publishes ${use.publishes} · uploads ${use.uploads}`,
    `- denials ${use.denials} · declared-diff mismatches ${use.diffMismatches}`,
  );
  if (writeFailure) lines.push("", `> Ledger persistence warning: ${redactValue(writeFailure)}`);
  return lines.join("\n");
}

const OSC_SEQUENCE = /\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
const CSI_SEQUENCE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const HIGH_ENTROPY = /\b[A-Za-z0-9_+/=-]{24,}\b/g;
const DIGIT_RUN = /\b\d{6,}\b/g;

/** Bounds and masks any value before it reaches a durable host record. */
export function redactValue(value: string): string {
  const clean = String(value)
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(HIGH_ENTROPY, "[redacted]")
    .replace(DIGIT_RUN, "[redacted]");
  return clean.length > MAX_LEDGER_VALUE ? `${clean.slice(0, MAX_LEDGER_VALUE)}…` : clean;
}

/**
 * URLs keep their origin and path so a permalink stays usable, but the query
 * and fragment are dropped because they can carry one-time or recovery tokens.
 */
export function redactUrl(value: string): string {
  const clean = String(value).replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(CONTROL_CHARACTERS, "");
  try {
    const parsed = new URL(clean);
    const stripped = `${parsed.origin}${parsed.pathname}`;
    return stripped.length > MAX_LEDGER_VALUE ? `${stripped.slice(0, MAX_LEDGER_VALUE)}\u2026` : stripped;
  } catch {
    return redactValue(clean);
  }
}

export async function listAudits(workspaceId: string, agentDir?: string): Promise<string[]> {
  try {
    return (await readdir(auditDirFor(workspaceId, agentDir)))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -6))
      .sort();
  } catch {
    return [];
  }
}

export async function readAudit(workspaceId: string, jobId: string, agentDir?: string): Promise<LedgerEntry[]> {
  const raw = await readFile(join(auditDirFor(workspaceId, agentDir), `${jobId}.jsonl`), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
}
