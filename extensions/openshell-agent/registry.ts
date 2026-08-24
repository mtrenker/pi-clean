import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { browserWorkspaceKey } from "./identity.ts";
import type { BrowserWorkspaceRecord, WorkspaceRecord } from "./types.ts";

export const REGISTRY_VERSION = 2;

interface RegistryFileV1 {
  version: 1;
  workspaces: WorkspaceRecord[];
}

interface RegistryFileV2 {
  version: 2;
  workspaces: WorkspaceRecord[];
  browserWorkspaces: BrowserWorkspaceRecord[];
}

export interface RegistryState {
  workspaces: WorkspaceRecord[];
  browserWorkspaces: BrowserWorkspaceRecord[];
}

export class WorkspaceRegistry {
  readonly path: string;

  constructor(path = join(getAgentDir(), "openshell-agent-workspaces.json")) {
    this.path = path;
  }

  async read(): Promise<RegistryState> {
    let parsed: RegistryFileV1 | RegistryFileV2;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as RegistryFileV1 | RegistryFileV2;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspaces: [], browserWorkspaces: [] };
      throw new Error(`Could not read OpenShell workspace registry: ${errorMessage(error)}`);
    }
    if (!parsed || !Array.isArray(parsed.workspaces)) throw new Error("Could not read OpenShell workspace registry: unsupported registry format");
    if (parsed.version === REGISTRY_VERSION) {
      return {
        workspaces: parsed.workspaces.map((record) => structuredClone(record)),
        browserWorkspaces: (parsed as RegistryFileV2).browserWorkspaces?.map((record) => structuredClone(record)) ?? [],
      };
    }
    if (parsed.version === 1) return migrateFromV1(parsed.workspaces.map((record) => structuredClone(record)));
    throw new Error("Could not read OpenShell workspace registry: unsupported registry format");
  }

  async list(): Promise<WorkspaceRecord[]> {
    return (await this.read()).workspaces;
  }

  async listBrowserWorkspaces(): Promise<BrowserWorkspaceRecord[]> {
    return (await this.read()).browserWorkspaces;
  }

  async find(logicalKey: string): Promise<WorkspaceRecord | undefined> {
    return (await this.list()).find((record) => record.logicalKey === logicalKey);
  }

  async findBrowserWorkspace(key: string): Promise<BrowserWorkspaceRecord | undefined> {
    return (await this.listBrowserWorkspaces()).find((record) => record.browserWorkspaceKey === key);
  }

  async put(record: WorkspaceRecord): Promise<void> {
    const state = await this.read();
    state.workspaces = state.workspaces.filter((entry) => entry.logicalKey !== record.logicalKey);
    state.workspaces.push(structuredClone(record));
    await this.save(state);
  }

  async putBrowserWorkspace(record: BrowserWorkspaceRecord): Promise<void> {
    const state = await this.read();
    state.browserWorkspaces = state.browserWorkspaces.filter((entry) => entry.browserWorkspaceKey !== record.browserWorkspaceKey);
    state.browserWorkspaces.push(structuredClone(record));
    await this.save(state);
  }

  async remove(logicalKey: string): Promise<void> {
    const state = await this.read();
    state.workspaces = state.workspaces.filter((record) => record.logicalKey !== logicalKey);
    await this.save(state);
  }

  async removeBrowserWorkspace(key: string): Promise<void> {
    const state = await this.read();
    state.browserWorkspaces = state.browserWorkspaces.filter((record) => record.browserWorkspaceKey !== key);
    state.workspaces = state.workspaces.map((record) => record.browserWorkspaceKey === key ? { ...record, browserWorkspaceKey: undefined } : record);
    await this.save(state);
  }

  /** Persists the migrated shape so a legacy file is upgraded exactly once. */
  async migrate(): Promise<RegistryState> {
    const state = await this.read();
    await this.save(state);
    return state;
  }

  private async save(state: RegistryState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const file: RegistryFileV2 = {
      version: REGISTRY_VERSION,
      workspaces: [...state.workspaces].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      browserWorkspaces: [...state.browserWorkspaces].sort((a, b) => a.browserWorkspaceKey.localeCompare(b.browserWorkspaceKey)),
    };
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path);
  }
}

/**
 * Adopts each legacy browser sandbox as a shared browser workspace without
 * widening anything: adoption happens only when exactly one legacy workspace
 * claims a `trustDomain + browserProfile` pair and it still carries its own
 * control secret. A contested pair keeps its legacy fields, is flagged, and
 * fails closed at run time so no login state is silently reassigned or lost.
 */
export function migrateFromV1(workspaces: WorkspaceRecord[]): RegistryState {
  const claims = new Map<string, WorkspaceRecord[]>();
  for (const record of workspaces) {
    if (!record.browser || !record.browserSandboxName || !record.browserControlSecret || !record.browserProfile) continue;
    const key = browserWorkspaceKey(record.trustDomain, record.browserProfile);
    claims.set(key, [...(claims.get(key) ?? []), record]);
  }
  const browserWorkspaces: BrowserWorkspaceRecord[] = [];
  const migrated = workspaces.map((record) => structuredClone(record));
  for (const [key, claimants] of claims) {
    const targets = migrated.filter((record) => claimants.some((claim) => claim.logicalKey === record.logicalKey));
    if (claimants.length > 1) {
      for (const record of targets) record.browserAdoptionConflict = true;
      continue;
    }
    const source = claimants[0];
    browserWorkspaces.push({
      browserWorkspaceKey: key,
      trustDomain: source.trustDomain,
      browserProfile: source.browserProfile!,
      sandboxName: source.browserSandboxName!,
      sandboxId: source.browserSandboxId ?? "",
      // A v1 record never stored the browser static fingerprint separately. The
      // empty value forces the first run to reconcile it explicitly instead of
      // assuming the legacy sandbox matches the current image and policy.
      staticFingerprint: "",
      controlSecret: source.browserControlSecret!,
      adoptedFrom: source.logicalKey,
      createdAt: source.createdAt,
      updatedAt: new Date().toISOString(),
    });
    for (const record of targets) {
      record.browserWorkspaceKey = key;
      delete record.browserSandboxName;
      delete record.browserSandboxId;
      delete record.browserControlSecret;
    }
  }
  return { workspaces: migrated, browserWorkspaces };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
