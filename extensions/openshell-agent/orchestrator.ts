import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { readLocalCodexCredentials } from "./codex-auth.ts";
import { OpenShellClient } from "./cli.ts";
import { assertProviderIsolation, canonicalHash, dynamicFingerprint, resolveIdentity } from "./identity.ts";
import { WorkspaceRegistry } from "./registry.ts";
import { parseWorkerResult } from "./result.ts";
import type {
  OpenShellAgentDetails,
  OpenShellJobInput,
  OpenShellProfile,
  PolicyProposal,
  PreflightReport,
  WorkspaceRecord,
} from "./types.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(extensionDir, "worker-runtime.mjs");
const workerUtilsPath = join(extensionDir, "worker-utils.mjs");
const browserExtensionPath = join(extensionDir, "worker-browser.ts");

export interface RunCallbacks {
  confirmRecreate(record: WorkspaceRecord, nextSandboxName: string): Promise<boolean>;
  reviewProposal(proposal: PolicyProposal): Promise<{ action: "approve" } | { action: "reject"; reason: string }>;
  progress(message: string): void;
}

export interface OrchestratorOptions {
  cli?: OpenShellClient;
  registry?: WorkspaceRegistry;
  proposalPollMs?: number;
}

export class OpenShellAgentOrchestrator {
  readonly cli: OpenShellClient;
  readonly registry: WorkspaceRegistry;
  private readonly proposalPollMs: number;
  private readonly active = new Set<string>();

  constructor(options: OrchestratorOptions = {}) {
    this.cli = options.cli ?? new OpenShellClient();
    this.registry = options.registry ?? new WorkspaceRegistry();
    this.proposalPollMs = options.proposalPollMs ?? 1000;
  }

  async run(profile: OpenShellProfile, input: OpenShellJobInput, signal: AbortSignal | undefined, callbacks: RunCallbacks): Promise<OpenShellAgentDetails> {
    validateInput(profile, input);
    callbacks.progress("Preflighting OpenShell CLI, gateway, Providers v2, Policy Advisor, and isolated inference…");
    const preflight = await this.cli.preflight(profile.inferenceApi, profile.codexSubscription);
    if (profile.codexSubscription) {
      callbacks.progress("Synchronizing the current host Codex login into the gateway provider without exposing token values…");
      const credentials = await readLocalCodexCredentials();
      await this.cli.syncCodexProvider(profile.codexSubscription.provider, credentials);
    }
    await this.cli.validateProviders(profile);
    const identity = await resolveIdentity(profile, input);
    const desiredDynamic = await dynamicFingerprint(profile);
    const records = await this.registry.list();
    assertProviderIsolation(records, input.trustDomain, profile.providers, identity.logicalKey);
    if (this.active.has(identity.logicalKey)) throw new AgentFailure("sandbox_busy", "This workspace already has an active job");
    this.active.add(identity.logicalKey);

    let record = records.find((entry) => entry.logicalKey === identity.logicalKey);
    let reused = false;
    try {
      if (record && record.staticFingerprint !== identity.staticFingerprint) {
        const confirmed = await callbacks.confirmRecreate(record, identity.sandboxName);
        if (!confirmed) throw new AgentFailure("static_profile_drift", "Static profile drift requires explicit sandbox recreation");
        callbacks.progress(`Recreating ${record.sandboxName}; persistent sandbox files and browser state will be deleted…`);
        await this.cli.deleteSandbox(record.sandboxName);
        await this.registry.remove(record.logicalKey);
        record = undefined;
      }

      if (record) {
        const sandbox = (await this.cli.listSandboxes()).find((entry) => entry.name === record!.sandboxName && entry.phase.toLowerCase() === "ready");
        if (!sandbox) {
          await this.registry.remove(record.logicalKey);
          record = undefined;
        } else {
          reused = true;
          if (record.dynamicFingerprint !== desiredDynamic) {
            callbacks.progress("Applying compatible network/provider profile changes atomically…");
            await this.cli.applyDynamicProfile(record.sandboxName, profile);
            record = { ...record, dynamicFingerprint: desiredDynamic, providers: [...profile.providers], updatedAt: new Date().toISOString() };
            await this.registry.put(record);
          }
        }
      }

      if (!record) {
        const matching = (await this.cli.listSandboxes()).find((entry) =>
          entry.name === identity.sandboxName && entry.phase.toLowerCase() === "ready" &&
          entry.labels?.["pi.openshell.workspace"] === identity.workspaceId,
        );
        const sandbox = matching
          ? { id: matching.id, name: matching.name }
          : await this.cli.createSandbox(profile, identity.sandboxName, {
              "pi.openshell.agent": "true",
              "pi.openshell.workspace": identity.workspaceId,
              "pi.openshell.profile": canonicalHash(profile.name).slice(0, 16),
              "pi.openshell.trust": canonicalHash(input.trustDomain).slice(0, 16),
            }, signal);
        reused = Boolean(matching);
        if (matching) {
          callbacks.progress(`Adopting matching Ready sandbox ${matching.name} and reconciling its dynamic profile…`);
          await this.cli.applyDynamicProfile(matching.name, profile);
        } else {
          callbacks.progress(`Created isolated sandbox ${sandbox.name}…`);
        }
        const browserControlSecret = profile.browser ? randomBytes(32).toString("base64url") : undefined;
        if (browserControlSecret) await this.cli.initializeBrowserControl(sandbox.name, browserControlSecret);
        const now = new Date().toISOString();
        record = {
          logicalKey: identity.logicalKey,
          workspaceId: identity.workspaceId,
          profile: profile.name,
          trustDomain: input.trustDomain,
          sandboxName: sandbox.name,
          sandboxId: sandbox.id,
          staticFingerprint: identity.staticFingerprint,
          dynamicFingerprint: desiredDynamic,
          providers: [...profile.providers],
          inference: { provider: preflight.inferenceProvider, model: preflight.inferenceModel, mode: profile.codexSubscription ? "codex-subscription" : "gateway" },
          repository: input.repository,
          browserProfile: input.browserProfile,
          browser: profile.browser,
          browserControlSecret,
          createdAt: now,
          updatedAt: now,
        };
        await this.registry.put(record);
      }

      if (profile.browser && !record.browserControlSecret) {
        throw new AgentFailure("browser_control_missing", "This legacy browser workspace lacks a host-only takeover capability. Recreate it explicitly before use.");
      }
      const inference = { provider: preflight.inferenceProvider, model: preflight.inferenceModel, mode: profile.codexSubscription ? "codex-subscription" as const : "gateway" as const };
      if (JSON.stringify(record.inference) !== JSON.stringify(inference)) {
        record = { ...record, inference, updatedAt: new Date().toISOString() };
        await this.registry.put(record);
      }
      callbacks.progress(`${reused ? "Reusing" : "Preparing"} Ready sandbox ${record.sandboxName}…`);
      await this.installRuntime(record.sandboxName, Boolean(profile.browser));
      const jobId = randomUUID();
      await this.writeRequest(record.sandboxName, jobId, profile, input, identity.repositoryKey, preflight);
      callbacks.progress(`Running job ${jobId.slice(0, 8)} inside OpenShell…`);
      const execution = this.cli.exec(record.sandboxName, ["node", "/sandbox/.openshell-agent/worker-runtime.mjs", jobId], {
        signal,
        workdir: "/sandbox",
        timeout: 0,
      });
      const execResult = await this.monitorExecution(record.sandboxName, execution, callbacks);
      if (execResult.aborted || signal?.aborted) {
        return metadata(record, jobId, reused, { status: "cancelled", answer: "", artifacts: [], errorCode: "cancelled" });
      }

      const resultRead = await this.cli.exec(record.sandboxName, ["cat", `/sandbox/jobs/${jobId}/result.json`], { timeout: 15 });
      if (resultRead.code !== 0) throw new AgentFailure("missing_result", "The sandbox worker did not produce a structured result; full logs remain sandbox-local");
      let worker;
      try {
        worker = parseWorkerResult(resultRead.stdout);
      } catch {
        throw new AgentFailure("malformed_result", "The sandbox worker result failed closed; full logs remain sandbox-local");
      }
      callbacks.progress(`Job ${jobId.slice(0, 8)} ${worker.status}; persistent workspace retained.`);
      return metadata(record, jobId, reused, worker);
    } finally {
      this.active.delete(identity.logicalKey);
    }
  }

  private async installRuntime(sandboxName: string, browser: boolean): Promise<void> {
    const [runtime, workerUtils, browserExtension] = await Promise.all([
      readFile(runtimePath, "utf8"),
      readFile(workerUtilsPath, "utf8"),
      browser ? readFile(browserExtensionPath, "utf8") : Promise.resolve(undefined),
    ]);
    await this.cli.installFile(sandboxName, "/sandbox/.openshell-agent/worker-runtime.mjs", runtime, "700");
    await this.cli.installFile(sandboxName, "/sandbox/.openshell-agent/worker-utils.mjs", workerUtils, "600");
    if (browserExtension) await this.cli.installFile(sandboxName, "/sandbox/.openshell-agent/worker-browser.ts", browserExtension, "600");
  }

  private async writeRequest(
    sandboxName: string,
    jobId: string,
    profile: OpenShellProfile,
    input: OpenShellJobInput,
    repositoryKey: string | undefined,
    preflight: PreflightReport,
  ): Promise<void> {
    const request = JSON.stringify({
      task: input.task,
      inference: { api: preflight.inferenceApi, model: preflight.inferenceModel, mode: profile.codexSubscription ? "codex-subscription" : "gateway" },
      workerTools: profile.workerTools,
      repository: input.repository ? {
        url: input.repository.url,
        baseBranch: input.repository.baseBranch ?? profile.repository?.defaultBaseBranch ?? "main",
        key: repositoryKey,
      } : undefined,
      browser: Boolean(profile.browser),
    });
    const path = `/sandbox/jobs/${jobId}/request.json`;
    const result = await this.cli.exec(sandboxName, ["sh", "-c", `umask 077; mkdir -p /sandbox/jobs/${jobId}; cat > ${path}`], { input: request, timeout: 15 });
    if (result.code !== 0) throw new AgentFailure("request_transfer_failed", "Could not transfer the non-secret job request over stdin");
  }

  private async monitorExecution(sandboxName: string, execution: ReturnType<OpenShellClient["exec"]>, callbacks: RunCallbacks) {
    let complete = false;
    let final: Awaited<typeof execution> | undefined;
    execution.then((result) => { complete = true; final = result; }, () => { complete = true; });
    const reviewed = new Set<string>();
    let warnedAboutPolling = false;
    while (!complete) {
      await delay(this.proposalPollMs);
      if (complete) break;
      let proposals: PolicyProposal[];
      try {
        proposals = await this.cli.pendingRules(sandboxName);
        warnedAboutPolling = false;
      } catch {
        if (!warnedAboutPolling) callbacks.progress("Policy proposal polling is temporarily unavailable; the worker remains sandboxed and waiting.");
        warnedAboutPolling = true;
        continue;
      }
      for (const proposal of proposals) {
        if (reviewed.has(proposal.id)) continue;
        reviewed.add(proposal.id);
        const decision = await callbacks.reviewProposal(proposal);
        if (decision.action === "approve") await this.cli.approveRule(sandboxName, proposal.id);
        else await this.cli.rejectRule(sandboxName, proposal.id, decision.reason);
      }
    }
    if (!final) throw new AgentFailure("worker_exec_failed", "The sandbox exec transport failed; no host fallback was attempted");
    return final;
  }
}

export class AgentFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function validateInput(profile: OpenShellProfile, input: OpenShellJobInput): void {
  if (!input.task.trim()) throw new AgentFailure("invalid_task", "task is required");
  if (Buffer.byteLength(input.task, "utf8") > 256 * 1024) throw new AgentFailure("invalid_task", "task exceeds the 256 KiB request limit");
  if (profile.repository?.required && !input.repository) throw new AgentFailure("repository_required", `Profile ${profile.name} requires repository.url`);
  if (profile.reuse === "browser-profile" && !input.browserProfile) throw new AgentFailure("browser_profile_required", `Profile ${profile.name} requires browserProfile`);
  if (input.browserProfile && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.browserProfile)) throw new AgentFailure("invalid_browser_profile", "browserProfile has invalid characters");
  if (input.repository?.baseBranch && (!/^[a-zA-Z0-9._/-]+$/.test(input.repository.baseBranch) || input.repository.baseBranch.includes(".."))) {
    throw new AgentFailure("invalid_base_branch", "repository.baseBranch is invalid");
  }
}

function metadata(record: WorkspaceRecord, jobId: string, reused: boolean, worker: { status: "complete" | "failed" | "cancelled"; answer: string; branch?: string; commit?: string; artifacts?: string[]; errorCode?: string }): OpenShellAgentDetails {
  return {
    ...worker,
    sandboxId: record.sandboxId,
    sandboxName: record.sandboxName,
    workspaceId: record.workspaceId,
    jobId,
    reused,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
