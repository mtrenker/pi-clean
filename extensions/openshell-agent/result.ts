import type { WorkerResult } from "./types.ts";

export const MAX_ANSWER_BYTES = 32 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}$/;

export function parseWorkerResult(raw: string): WorkerResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_RESULT_BYTES) throw new Error("worker result exceeded the bounded result limit");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("worker result was not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worker result must be an object");
  const result = value as Record<string, unknown>;
  if (!["complete", "failed", "cancelled"].includes(String(result.status))) throw new Error("worker result has an invalid status");
  if (typeof result.answer !== "string") throw new Error("worker result is missing an answer");
  if (Buffer.byteLength(result.answer, "utf8") > MAX_ANSWER_BYTES) throw new Error("worker answer exceeded the bounded answer limit");
  const answer = sanitizeUntrustedText(result.answer);
  const branch = optionalRef(result.branch, "branch");
  const commit = optionalRef(result.commit, "commit");
  const artifacts = result.artifacts === undefined ? undefined : parseArtifacts(result.artifacts);
  return { status: result.status as WorkerResult["status"], answer, branch, commit, artifacts };
}

export function sanitizeUntrustedText(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function optionalRef(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !SAFE_REF.test(value) || value.includes("..")) throw new Error(`worker result has an invalid ${name}`);
  return value;
}

function parseArtifacts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("worker result has invalid artifacts");
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.startsWith("/sandbox/") || entry.includes("..") || entry.length > 512) {
      throw new Error("worker artifacts must be bounded paths under /sandbox");
    }
    return entry;
  });
}
