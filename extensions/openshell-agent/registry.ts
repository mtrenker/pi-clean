import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { WorkspaceRecord } from "./types.ts";

interface RegistryFile {
  version: 1;
  workspaces: WorkspaceRecord[];
}

export class WorkspaceRegistry {
  readonly path: string;

  constructor(path = join(getAgentDir(), "openshell-agent-workspaces.json")) {
    this.path = path;
  }

  async list(): Promise<WorkspaceRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as RegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) throw new Error("unsupported registry format");
      return parsed.workspaces.map((record) => structuredClone(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Could not read OpenShell workspace registry: ${errorMessage(error)}`);
    }
  }

  async find(logicalKey: string): Promise<WorkspaceRecord | undefined> {
    return (await this.list()).find((record) => record.logicalKey === logicalKey);
  }

  async put(record: WorkspaceRecord): Promise<void> {
    const records = (await this.list()).filter((entry) => entry.logicalKey !== record.logicalKey);
    records.push(structuredClone(record));
    await this.save(records);
  }

  async remove(logicalKey: string): Promise<void> {
    await this.save((await this.list()).filter((record) => record.logicalKey !== logicalKey));
  }

  private async save(workspaces: WorkspaceRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, workspaces: workspaces.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)) }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.path);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
