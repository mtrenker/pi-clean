import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { OpenShellJobInput, OpenShellProfile, StaticIdentity, WorkspaceRecord } from "./types.ts";

export async function resolveIdentity(profile: OpenShellProfile, input: OpenShellJobInput): Promise<StaticIdentity> {
  const repository = input.repository ? normalizeRepository(input.repository.url) : undefined;
  const repositoryKey = repository ? canonicalHash(repository) : undefined;
  const logicalMaterial = {
    profile: profile.name,
    trustDomain: input.trustDomain,
    repository: profile.reuse === "repository" ? repository : undefined,
    browserProfile: profile.reuse === "browser-profile" ? input.browserProfile : undefined,
    nonce: profile.reuse === "ephemeral" ? randomNonce() : undefined,
  };
  const logicalKey = canonicalHash(logicalMaterial);
  const workspaceId = logicalKey.slice(0, 20);
  const [imageSource, staticPolicy] = await Promise.all([
    imageSourceFingerprint(profile.image),
    policyStaticMaterial(profile.basePolicy),
  ]);
  const staticFingerprint = canonicalHash({
    image: profile.image,
    imageContract: profile.imageContract,
    imageSource,
    staticPolicy,
    cpu: profile.cpu,
    memory: profile.memory,
    filesystem: profile.filesystem,
    process: profile.process,
    trustDomain: input.trustDomain,
  });
  const sandboxName = `${slug(profile.name, 24)}-${workspaceId.slice(0, 10)}-${staticFingerprint.slice(0, 8)}`;
  return { logicalKey, workspaceId, staticFingerprint, sandboxName, repositoryKey };
}

export async function dynamicFingerprint(profile: OpenShellProfile): Promise<string> {
  let policy: string;
  try {
    policy = await readFile(profile.basePolicy, "utf8");
  } catch (error) {
    throw new Error(`Could not read base policy ${profile.basePolicy}: ${errorMessage(error)}`);
  }
  return canonicalHash({ policy, providers: [...profile.providers].sort(), codexSubscription: profile.codexSubscription, advisorMode: profile.advisorMode });
}

async function policyStaticMaterial(path: string): Promise<string> {
  let policy: string;
  try {
    policy = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read base policy ${path}: ${errorMessage(error)}`);
  }
  const sections = new Set(["version", "filesystem_policy", "landlock", "process"]);
  const lines = policy.replace(/\r\n/g, "\n").split("\n");
  const selected: string[] = [];
  let include = false;
  for (const line of lines) {
    const topLevel = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/)?.[1];
    if (topLevel) include = sections.has(topLevel);
    if (include && !/^\s*#/.test(line)) selected.push(line.trimEnd());
  }
  if (!selected.some((line) => line.startsWith("filesystem_policy:")) || !selected.some((line) => line.startsWith("process:"))) {
    throw new Error(`Base policy ${path} must declare filesystem_policy and process as static profile boundaries`);
  }
  return selected.join("\n");
}

export function assertProviderIsolation(records: WorkspaceRecord[], trustDomain: string, providers: string[], logicalKey: string): void {
  for (const record of records) {
    if (record.logicalKey === logicalKey || record.trustDomain === trustDomain) continue;
    const shared = record.providers.filter((provider) => providers.includes(provider));
    if (shared.length > 0) {
      throw new Error(
        `Provider ${shared.join(", ")} is already attached to trust domain ${record.trustDomain}. ` +
        "Use a distinct provider instance name for each trust domain.",
      );
    }
  }
}

export function normalizeRepository(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("-")) throw new Error("repository.url must be a non-empty Git URL");
  const scp = trimmed.match(/^(?:([^@]+)@)?([^:]+):(.+)$/);
  if (scp && !trimmed.includes("://")) {
    if (scp[1] && scp[1] !== "git") throw new Error("repository URLs must not contain embedded credentials");
    return `${scp[2].toLowerCase()}/${stripGit(scp[3])}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (!["https:", "ssh:", "git:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
    if (parsed.username && !(parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password)) {
      throw new Error("repository URLs must not contain embedded credentials");
    }
    return `${parsed.hostname.toLowerCase()}${stripGit(parsed.pathname)}`;
  } catch (error) {
    if (error instanceof Error && error.message.includes("credentials")) throw error;
    throw new Error("repository.url must use https, ssh, git, or SSH scp syntax without embedded credentials");
  }
}

function stripGit(value: string): string {
  return value.replace(/^\/+/, "/").replace(/\.git\/?$/, "").replace(/\/$/, "");
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

async function imageSourceFingerprint(image: string): Promise<string | undefined> {
  if (!image.startsWith("/") && !image.startsWith(".")) return undefined;
  const root = resolve(image);
  try {
    const info = await stat(root);
    if (info.isFile()) return createHash("sha256").update(await readFile(root)).digest("hex");
    const files = await walk(root);
    const hash = createHash("sha256");
    for (const path of files) {
      hash.update(path.slice(root.length));
      hash.update(await readFile(path));
    }
    return hash.digest("hex");
  } catch (error) {
    throw new Error(`Could not fingerprint image source ${image}: ${errorMessage(error)}`);
  }
}

async function walk(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

function slug(value: string, max: number): string {
  return basename(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, max) || "workspace";
}

function randomNonce(): string {
  return `${Date.now()}-${Math.random()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
