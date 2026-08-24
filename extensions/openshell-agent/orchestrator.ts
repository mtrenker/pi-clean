import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { JobLedger } from "./audit.ts";
import {
  authorizeBridgeAction,
  isPunitive,
  MAX_PROFESSIONAL_SOCIALS_REQUEST_BYTES,
  MAX_SAFE_REQUEST_BYTES,
  PROFESSIONAL_SOCIALS_BRIDGE_PATHS,
  SAFE_BRIDGE_PATHS,
  type BridgeState,
} from "./browser-bridge.ts";
import { readLocalCodexCredentials } from "./codex-auth.ts";
import { OpenShellClient } from "./cli.ts";
import {
  assertProviderIsolation,
  browserStaticFingerprint,
  browserWorkspaceKey,
  canonicalHash,
  dynamicFingerprint,
  resolveIdentity,
} from "./identity.ts";
import {
  browserControlPacket,
  clampBudget,
  clampTtlMinutes,
  issueMandate,
  MandateSession,
  signRequest,
  taskHash,
  type Mandate,
  type MandateBudget,
} from "./mandate.ts";
import { WorkspaceRegistry } from "./registry.ts";
import { parseWorkerResult } from "./result.ts";
import { BUILTIN_PROFILES } from "./profile.ts";
import { classifyUrl, loadSiteRules, originsFor, siteIds, type SiteRules } from "./site-rules.ts";
import type {
  BrowserWorkspaceRecord,
  OpenShellAgentDetails,
  OpenShellJobInput,
  OpenShellProfile,
  PolicyProposal,
  PreflightReport,
  ProfessionalSocialsSummary,
  WorkspaceRecord,
} from "./types.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(extensionDir, "worker-runtime.mjs");
const workerUtilsPath = join(extensionDir, "worker-utils.mjs");
const browserExtensionPath = join(extensionDir, "worker-browser.ts");
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface MandateAuthorizationRequest {
  profile: string;
  trustDomain: string;
  browserProfile: string;
  task: string;
  sites: Array<{ id: string; label: string; origins: string[] }>;
  actionClasses: string[];
  budget: MandateBudget;
  ttlMinutes: number;
  browserSandboxName: string;
}

export interface RunCallbacks {
  confirmRecreate(record: WorkspaceRecord, nextSandboxName: string): Promise<boolean>;
  confirmBrowserRecreate?(record: BrowserWorkspaceRecord): Promise<boolean>;
  authorizeMandate?(request: MandateAuthorizationRequest): Promise<boolean>;
  reviewProposal(proposal: PolicyProposal): Promise<{ action: "approve" } | { action: "reject"; reason: string }>;
  progress(message: string): void;
}

export interface OrchestratorOptions {
  cli?: OpenShellClient;
  registry?: WorkspaceRegistry;
  proposalPollMs?: number;
  agentDir?: string;
  siteRules?: SiteRules;
}

interface BridgeContext {
  workerSandbox: string;
  browserSandbox: string;
  mode: "safe" | "professional-socials";
  jobId: string;
  controlSecret?: string;
  session?: MandateSession;
  ledger?: JobLedger;
  state: BridgeState;
  stagedUploads: string[];
}

export class OpenShellAgentOrchestrator {
  readonly cli: OpenShellClient;
  readonly registry: WorkspaceRegistry;
  private readonly proposalPollMs: number;
  private readonly agentDir?: string;
  private readonly rules: SiteRules;
  private readonly active = new Set<string>();

  constructor(options: OrchestratorOptions = {}) {
    this.cli = options.cli ?? new OpenShellClient();
    this.registry = options.registry ?? new WorkspaceRegistry();
    this.proposalPollMs = options.proposalPollMs ?? 1000;
    this.agentDir = options.agentDir;
    this.rules = options.siteRules ?? loadSiteRules();
  }

  async run(profile: OpenShellProfile, input: OpenShellJobInput, signal: AbortSignal | undefined, callbacks: RunCallbacks): Promise<OpenShellAgentDetails> {
    validateInput(this.rules, profile, input);
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
    const state = await this.registry.read();
    const records = state.workspaces;
    assertProviderIsolation(records, input.trustDomain, profile.providers, identity.logicalKey);
    const browserKey = profile.browser ? browserWorkspaceKey(input.trustDomain, input.browserProfile!) : undefined;
    if (this.active.has(identity.logicalKey)) throw new AgentFailure("sandbox_busy", "This workspace already has an active job");
    // One browser workspace never runs two jobs at once, even from two profiles.
    if (browserKey && this.active.has(browserKey)) {
      throw new AgentFailure("browser_workspace_busy", "This browser workspace already has an active job; professional-socials and authenticated-browser never share a browser concurrently");
    }
    this.active.add(identity.logicalKey);
    if (browserKey) this.active.add(browserKey);

    let record = records.find((entry) => entry.logicalKey === identity.logicalKey);
    let reused = false;
    let browserWorkspace: BrowserWorkspaceRecord | undefined;
    let mandate: Mandate | undefined;
    let session: MandateSession | undefined;
    let ledger: JobLedger | undefined;
    const bridgeState: BridgeState = {};
    const stagedUploads: string[] = [];
    const jobId = randomUUID();
    try {
      if (record?.browserAdoptionConflict) {
        throw new AgentFailure(
          "browser_adoption_conflict",
          "Two legacy workspaces claim one browser identity for this trust domain and browser profile. Delete the workspace you no longer need with /openshell delete, then run again.",
        );
      }
      if (record && record.staticFingerprint !== identity.staticFingerprint) {
        const confirmed = await callbacks.confirmRecreate(record, identity.sandboxName);
        if (!confirmed) throw new AgentFailure("static_profile_drift", "Static profile drift requires explicit sandbox recreation");
        callbacks.progress(`Recreating ${record.sandboxName}; persistent worker files are deleted. Browser login state lives in its own workspace and is kept.`);
        await this.cli.deleteSandbox(record.sandboxName);
        await this.registry.remove(record.logicalKey);
        record = undefined;
      }

      if (record) {
        const sandboxes = await this.cli.listSandboxes();
        const sandbox = sandboxes.find((entry) => entry.name === record!.sandboxName && entry.phase.toLowerCase() === "ready");
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
          createdAt: now,
          updatedAt: now,
        };
        await this.registry.put(record);
      }

      if (profile.browser && browserKey) {
        browserWorkspace = await this.resolveBrowserWorkspace(profile, input, browserKey, callbacks, signal);
        if (record.browserWorkspaceKey !== browserKey || JSON.stringify(record.browser) !== JSON.stringify(profile.browser)) {
          record = { ...record, browserWorkspaceKey: browserKey, browser: profile.browser, browserProfile: input.browserProfile, updatedAt: new Date().toISOString() };
          await this.registry.put(record);
        }
      }

      const inference = { provider: preflight.inferenceProvider, model: preflight.inferenceModel, mode: profile.codexSubscription ? "codex-subscription" as const : "gateway" as const };
      if (JSON.stringify(record.inference) !== JSON.stringify(inference)) {
        record = { ...record, inference, updatedAt: new Date().toISOString() };
        await this.registry.put(record);
      }

      const mode = profile.browser?.mode === "professional-socials" ? "professional-socials" as const : "safe" as const;
      if (mode === "professional-socials") {
        if (!callbacks.authorizeMandate) throw new AgentFailure("authorization_unavailable", "professional-socials requires an interactive task authorization");
        const request = input.professionalSocials!;
        const budget = clampBudget(request.budget);
        const ttlMinutes = clampTtlMinutes(request.ttlMinutes);
        const origins = originsFor(this.rules, request.sites);
        // Authorizing profile edits necessarily authorizes committing them:
        // the operator reviews the result, not each individual submit.
        const actionClasses = [...new Set(["read", ...request.allow, ...(request.allow.includes("edit-profile") ? ["submit-profile"] : [])])].sort();
        const authorized = await callbacks.authorizeMandate({
          profile: profile.name,
          trustDomain: input.trustDomain,
          browserProfile: input.browserProfile!,
          task: input.task,
          sites: this.rules.sites.filter((site) => request.sites.includes(site.id)).map((site) => ({ id: site.id, label: site.label, origins: site.origins })),
          actionClasses,
          budget,
          ttlMinutes,
          browserSandboxName: browserWorkspace!.sandboxName,
        });
        if (!authorized) throw new AgentFailure("mandate_declined", "The operator declined the professional-socials task authorization");
        const health = await this.cli.browserCall(browserWorkspace!.sandboxName, "/health");
        const epoch = typeof health.body.epoch === "string" ? health.body.epoch : undefined;
        if (!epoch) {
          throw new AgentFailure(
            "browser_controller_outdated",
            "This browser workspace still runs a controller without task-mandate support. Run /openshell browser-recreate to rebuild it; the persistent login is lost and must be re-established once through /openshell takeover.",
          );
        }
        const issuedAt = new Date();
        mandate = issueMandate(browserWorkspace!.controlSecret, {
          jobId,
          workspaceId: record.workspaceId,
          browserWorkspaceKey: browserKey!,
          controllerEpoch: epoch,
          taskHash: taskHash(input.task),
          sites: [...request.sites].sort(),
          origins,
          actionClasses,
          budget,
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + ttlMinutes * 60_000).toISOString(),
        });
        const activation = await this.cli.browserCall(browserWorkspace!.sandboxName, "/mandate/activate", {
          ...browserControlPacket(browserWorkspace!.controlSecret, "mandate-activate").packet,
          mandate,
        });
        if (activation.status < 200 || activation.status >= 300) {
          throw new AgentFailure("mandate_rejected", `The browser controller refused the task mandate (${String(activation.body.code ?? "unknown")})`);
        }
        session = new MandateSession(mandate);
        ledger = JobLedger.fromMandate(mandate, { trustDomain: input.trustDomain, browserProfile: input.browserProfile! }, this.agentDir);
        await ledger.append({ action: "mandate.activate", decision: "allow", note: `sites=${request.sites.join(",")} classes=${actionClasses.join(",")} ttl=${ttlMinutes}m` });
        callbacks.progress(`Task mandate active for ${request.sites.join(", ")}; the run proceeds without further prompts.`);
      }

      callbacks.progress(`${reused ? "Reusing" : "Preparing"} Ready sandbox ${record.sandboxName}…`);
      await this.installRuntime(record.sandboxName, Boolean(profile.browser));
      await this.waitForPolicyAdvisor(record.sandboxName);
      await this.writeRequest(record.sandboxName, jobId, profile, input, identity.repositoryKey, preflight, mode);
      callbacks.progress(`Running job ${jobId.slice(0, 8)} inside OpenShell…`);
      const execution = this.cli.exec(record.sandboxName, ["node", "/sandbox/.openshell-agent/worker-runtime.mjs", jobId], {
        signal,
        workdir: "/sandbox",
        timeout: 0,
      });
      const bridge: BridgeContext | undefined = browserWorkspace ? {
        workerSandbox: record.sandboxName,
        browserSandbox: browserWorkspace.sandboxName,
        mode,
        jobId,
        controlSecret: browserWorkspace.controlSecret,
        session,
        ledger,
        state: bridgeState,
        stagedUploads,
      } : undefined;
      const execResult = await this.monitorExecution(record.sandboxName, bridge, execution, callbacks);
      const summary = mandate && session && ledger
        ? { mandate, session, ledger }
        : undefined;
      if (execResult.aborted || signal?.aborted) {
        return this.finish(record, jobId, reused, { status: "cancelled", answer: "", artifacts: [], errorCode: "cancelled" }, summary);
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
      return this.finish(record, jobId, reused, worker, summary);
    } finally {
      if (browserWorkspace && mandate) {
        await this.closeMandate(browserWorkspace, session, ledger, stagedUploads, callbacks);
      }
      this.active.delete(identity.logicalKey);
      if (browserKey) this.active.delete(browserKey);
    }
  }

  /**
   * Resolves the shared browser workspace for `trustDomain + browserProfile`.
   * Adopting a migrated legacy sandbox never recreates it, so an existing login
   * survives; a genuine static drift asks for explicit destructive confirmation.
   */
  private async resolveBrowserWorkspace(
    profile: OpenShellProfile,
    input: OpenShellJobInput,
    key: string,
    callbacks: RunCallbacks,
    signal: AbortSignal | undefined,
  ): Promise<BrowserWorkspaceRecord> {
    const desiredStatic = await browserStaticFingerprint(profile, input.trustDomain);
    const desiredDynamic = canonicalHash({ policy: await readFile(profile.browser!.basePolicy, "utf8"), mode: profile.browser!.mode ?? "safe" });
    let workspace = await this.registry.findBrowserWorkspace(key);

    if (workspace) {
      const sandboxes = await this.cli.listSandboxes();
      const existing = sandboxes.find((entry) => entry.name === workspace!.sandboxName);
      if (existing && existing.phase.toLowerCase() !== "ready") {
        // Never treat a transient phase as a missing browser: recreating it
        // would silently destroy the persistent login.
        throw new AgentFailure(
          "browser_workspace_not_ready",
          `The persistent browser sandbox ${workspace.sandboxName} is ${existing.phase}, not Ready. Wait for it, or delete it explicitly with /openshell browser-recreate.`,
        );
      }
      if (!existing) {
        callbacks.progress("The persistent browser sandbox no longer exists; a new empty browser workspace will be created.");
        await this.registry.removeBrowserWorkspace(key);
        workspace = undefined;
      } else if (workspace.staticFingerprint === "") {
        // Migrated v1 workspace: adopt it as-is instead of destroying a login.
        workspace = { ...workspace, staticFingerprint: desiredStatic, updatedAt: new Date().toISOString() };
        await this.registry.putBrowserWorkspace(workspace);
        callbacks.progress(`Adopted the existing browser workspace ${workspace.sandboxName} without touching its login state.`);
      } else if (workspace.staticFingerprint !== desiredStatic) {
        const confirmed = await callbacks.confirmBrowserRecreate?.(workspace) ?? false;
        if (!confirmed) throw new AgentFailure("browser_static_drift", "The browser image or static policy changed; recreating it is an explicit destructive decision");
        await this.cli.deleteSandbox(workspace.sandboxName);
        await this.registry.removeBrowserWorkspace(key);
        workspace = undefined;
      }
    }

    if (!workspace) {
      const name = `browser-${slugName(input.browserProfile!)}-${key.slice(0, 10)}`;
      const controlSecret = randomBytes(32).toString("base64url");
      const sandbox = await this.cli.createSandbox(browserServiceProfile(profile), name, {
        "pi.openshell.agent": "true",
        "pi.openshell.role": "browser",
        "pi.openshell.browser": key.slice(0, 16),
        "pi.openshell.trust": canonicalHash(input.trustDomain).slice(0, 16),
      }, signal);
      try {
        await this.cli.startBrowserService(sandbox.name);
        await this.cli.initializeBrowserControl(sandbox.name, controlSecret, key);
      } catch (error) {
        await this.cli.deleteSandbox(sandbox.name).catch(() => {});
        throw error;
      }
      const now = new Date().toISOString();
      workspace = {
        browserWorkspaceKey: key,
        trustDomain: input.trustDomain,
        browserProfile: input.browserProfile!,
        sandboxName: sandbox.name,
        sandboxId: sandbox.id,
        staticFingerprint: desiredStatic,
        dynamicFingerprint: desiredDynamic,
        controlSecret,
        createdAt: now,
        updatedAt: now,
      };
      await this.registry.putBrowserWorkspace(workspace);
      callbacks.progress(`Created the isolated browser workspace ${sandbox.name}…`);
    } else if (workspace.dynamicFingerprint !== desiredDynamic) {
      callbacks.progress("Applying the browser network policy for this mode; the login state is untouched…");
      await this.cli.applyDynamicProfile(workspace.sandboxName, browserServiceProfile(profile));
      workspace = { ...workspace, dynamicFingerprint: desiredDynamic, updatedAt: new Date().toISOString() };
      await this.registry.putBrowserWorkspace(workspace);
    }
    await this.cli.startBrowserService(workspace.sandboxName);
    return workspace;
  }

  /** Revokes the mandate, narrows the browser policy again, and clears staged uploads. */
  private async closeMandate(
    workspace: BrowserWorkspaceRecord,
    session: MandateSession | undefined,
    ledger: JobLedger | undefined,
    stagedUploads: string[],
    callbacks: RunCallbacks,
  ): Promise<void> {
    const reason = session?.revocation ?? "job_finished";
    await this.cli.browserCall(workspace.sandboxName, "/mandate/revoke", {
      ...browserControlPacket(workspace.controlSecret, "mandate-revoke").packet,
      reason: /^[a-z0-9_:-]{1,64}$/.test(reason) ? reason : "job_finished",
    }).catch(() => undefined);
    if (stagedUploads.length > 0) {
      await this.cli.exec(workspace.sandboxName, ["sh", "-c", `rm -f ${stagedUploads.map((id) => `/run/openshell-browser/uploads/${id}`).join(" ")}`], { timeout: 15 }).catch(() => undefined);
    }
    const safe = BUILTIN_PROFILES["authenticated-browser"];
    const restored = await this.cli.applyDynamicProfile(workspace.sandboxName, browserServiceProfile(safe)).then(() => true).catch(() => false);
    await this.registry.putBrowserWorkspace({
      ...workspace,
      dynamicFingerprint: restored ? canonicalHash({ policy: await readFile(safe.browser!.basePolicy, "utf8"), mode: "safe" }) : undefined,
      updatedAt: new Date().toISOString(),
    });
    if (!restored) {
      callbacks.progress("Could not narrow the browser network policy back to the safe baseline; the next job reapplies it.");
      await ledger?.append({ action: "policy.restore", decision: "anomaly", code: "browser_policy_restore_failed" });
    }
  }

  private finish(
    record: WorkspaceRecord,
    jobId: string,
    reused: boolean,
    worker: { status: "complete" | "failed" | "cancelled"; answer: string; branch?: string; commit?: string; artifacts?: string[]; errorCode?: string },
    mandate?: { mandate: Mandate; session: MandateSession; ledger: JobLedger },
  ): OpenShellAgentDetails {
    const details = metadata(record, jobId, reused, worker);
    if (!mandate) return details;
    const { session, ledger } = mandate;
    const summary: ProfessionalSocialsSummary = {
      mandateId: mandate.mandate.mandateId,
      sites: mandate.mandate.sites,
      actionClasses: mandate.mandate.actionClasses,
      submits: session.use.submits,
      publishes: session.use.publishes,
      edits: session.use.edits,
      denials: session.use.denials,
      revocation: session.revocation,
      auditPath: ledger.path,
    };
    return {
      ...details,
      report: ledger.report(session.use, { status: worker.status, revocation: session.revocation }),
      professionalSocials: summary,
    };
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
    mode: "safe" | "professional-socials",
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
      // The worker learns which tool surface to register. It carries no
      // authority: the host bridge and the controller decide what is allowed.
      browserMode: profile.browser ? mode : undefined,
      sites: mode === "professional-socials" ? input.professionalSocials!.sites : undefined,
    });
    const path = `/sandbox/jobs/${jobId}/request.json`;
    const result = await this.cli.exec(sandboxName, ["sh", "-c", `umask 077; mkdir -p /sandbox/jobs/${jobId}/uploads; cat > ${path}`], { input: request, timeout: 15 });
    if (result.code !== 0) throw new AgentFailure("request_transfer_failed", "Could not transfer the non-secret job request over stdin");
  }

  private async monitorExecution(sandboxName: string, bridge: BridgeContext | undefined, execution: ReturnType<OpenShellClient["exec"]>, callbacks: RunCallbacks) {
    let complete = false;
    let final: Awaited<typeof execution> | undefined;
    execution.then((result) => { complete = true; final = result; }, () => { complete = true; });
    const reviewed = new Set<string>();
    let warnedAboutPolling = false;
    while (!complete) {
      await delay(this.proposalPollMs);
      if (complete) break;
      let proposals: Array<{ sandbox: string; proposal: PolicyProposal }>;
      try {
        if (bridge) await this.bridgeBrowserRequests(bridge, callbacks);
        const workerProposals = await this.cli.pendingRules(sandboxName);
        const browserProposals = bridge ? await this.cli.pendingRules(bridge.browserSandbox) : [];
        proposals = [
          ...workerProposals.map((proposal) => ({ sandbox: sandboxName, proposal })),
          ...browserProposals.map((proposal) => ({ sandbox: bridge!.browserSandbox, proposal })),
        ];
        warnedAboutPolling = false;
      } catch {
        if (!warnedAboutPolling) callbacks.progress("Policy proposal polling is temporarily unavailable; the worker remains sandboxed and waiting.");
        warnedAboutPolling = true;
        continue;
      }
      for (const item of proposals) {
        const key = `${item.sandbox}:${item.proposal.id}`;
        if (reviewed.has(key)) continue;
        reviewed.add(key);
        const decision = await callbacks.reviewProposal(item.proposal);
        if (decision.action === "approve") await this.cli.approveRule(item.sandbox, item.proposal.id);
        else await this.cli.rejectRule(item.sandbox, item.proposal.id, decision.reason);
      }
    }
    if (!final) throw new AgentFailure("worker_exec_failed", "The sandbox exec transport failed; no host fallback was attempted");
    return final;
  }

  private async waitForPolicyAdvisor(sandboxName: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const ready = await this.cli.exec(sandboxName, ["sh", "-c", "test -r /etc/openshell/skills/policy-advisor/SKILL.md && test -r /etc/openshell/skills/policy_advisor.md"], { timeout: 5 });
      if (ready.code === 0) return;
      await delay(100);
    }
    throw new AgentFailure("policy_advisor_unavailable", "The gateway did not install its Policy Advisor skill; the job was not started");
  }

  private async bridgeBrowserRequests(bridge: BridgeContext, callbacks: RunCallbacks): Promise<void> {
    const listed = await this.cli.exec(bridge.workerSandbox, ["sh", "-c", "find /sandbox/.openshell-agent/browser-bridge -maxdepth 1 -type f -name '*.request' -printf '%f\\n' 2>/dev/null | head -20"], { timeout: 5 });
    if (listed.code !== 0) return;
    const professionalSocials = bridge.mode === "professional-socials";
    const allowed: readonly string[] = professionalSocials ? PROFESSIONAL_SOCIALS_BRIDGE_PATHS : SAFE_BRIDGE_PATHS;
    const maxRequestBytes = professionalSocials ? MAX_PROFESSIONAL_SOCIALS_REQUEST_BYTES : MAX_SAFE_REQUEST_BYTES;
    for (const file of listed.stdout.split("\n").filter(Boolean)) {
      if (!/^[0-9a-f-]{36}\.request$/.test(file)) continue;
      const id = file.slice(0, -8);
      const request = await this.cli.exec(bridge.workerSandbox, ["cat", `/sandbox/.openshell-agent/browser-bridge/${file}`], { timeout: 5 });
      if (request.code !== 0 || Buffer.byteLength(request.stdout, "utf8") > maxRequestBytes) continue;
      let parsed: { id: string; path: string; body?: unknown };
      try { parsed = JSON.parse(request.stdout); } catch { continue; }
      if (parsed.id !== id) continue;
      if (!allowed.includes(parsed.path)) {
        if (bridge.mode !== "professional-socials") continue;
        await this.claimAndRespond(bridge, id, { status: 403, body: { code: "path_not_allowed" } });
        continue;
      }
      const claimed = await this.cli.exec(bridge.workerSandbox, ["mv", `/sandbox/.openshell-agent/browser-bridge/${id}.request`, `/sandbox/.openshell-agent/browser-bridge/${id}.processing`], { timeout: 5 });
      if (claimed.code !== 0) continue;

      if (!professionalSocials) {
        const response = await this.cli.browserCall(bridge.browserSandbox, parsed.path, parsed.body);
        // A newly denied destination returns before Policy Advisor has flushed its
        // proposal. Requeue it so the next monitor pass retries after the
        // operator's decision without spending another model turn.
        if (response.status === 400 && response.body.code === "controller_error") {
          await this.cli.exec(bridge.workerSandbox, ["mv", `/sandbox/.openshell-agent/browser-bridge/${id}.processing`, `/sandbox/.openshell-agent/browser-bridge/${id}.request`], { timeout: 5 });
          continue;
        }
        await this.writeResponse(bridge, id, response);
        continue;
      }

      try {
        await this.runAuthorizedAction(bridge, id, parsed, callbacks);
      } catch (error) {
        if (error instanceof AgentFailure) throw error;
        // A transport failure is not an authorization decision: tell the worker
        // and leave the mandate alone.
        await bridge.ledger?.append({ action: "bridge", decision: "anomaly", code: "bridge_transport_failed" });
        await this.writeResponse(bridge, id, { status: 503, body: { code: "bridge_transport_failed" } });
      }
    }
  }

  private async runAuthorizedAction(
    bridge: BridgeContext,
    id: string,
    parsed: { path: string; body?: unknown },
    callbacks: RunCallbacks,
  ): Promise<void> {
    const session = bridge.session!;
    const ledger = bridge.ledger!;
    const decision = authorizeBridgeAction(this.rules, session, bridge.state, parsed);
    const base = {
      action: decision.action,
      actionClass: decision.actionClass,
      site: decision.classification?.siteId,
      origin: decision.classification?.host,
      surface: decision.classification?.surfaceId,
    };
    if (!decision.allowed) {
      if (isPunitive(decision.code)) session.recordDenial(decision.code!);
      await ledger.append({ ...base, decision: "deny", code: decision.code });
      await this.writeResponse(bridge, id, { status: 403, body: { code: decision.code ?? "denied" } });
      if (session.revoked) await this.tripBreaker(bridge, callbacks);
      return;
    }

    let body = parsed.body as Record<string, unknown>;
    if (parsed.path === "/ps/upload") {
      const staged = await this.stageUpload(bridge, String(body.artifact));
      if (!staged.ok) {
        if (isPunitive(staged.code)) session.recordDenial(staged.code);
        await ledger.append({ ...base, decision: "deny", code: staged.code });
        await this.writeResponse(bridge, id, { status: 403, body: { code: staged.code } });
        if (session.revoked) await this.tripBreaker(bridge, callbacks);
        return;
      }
      body = { ref: body.ref, stageId: staged.stageId };
    }

    const auth = signRequest(bridge.controlSecret!, { mandateId: session.mandate.mandateId, seq: session.nextSeq(), path: parsed.path, body });
    const response = await this.cli.browserCall(bridge.browserSandbox, parsed.path, { auth, body });
    const responseBody = response.body as Record<string, unknown>;
    if (response.status < 200 || response.status >= 300) {
      const code = typeof responseBody.code === "string" ? responseBody.code : "controller_denied";
      // An operator takeover pauses the controller. Requeue instead of failing
      // the worker call or spending the mandate's denial budget on a human step.
      if (code === "automation_paused") {
        await this.cli.exec(bridge.workerSandbox, ["mv", `/sandbox/.openshell-agent/browser-bridge/${id}.processing`, `/sandbox/.openshell-agent/browser-bridge/${id}.request`], { timeout: 5 });
        return;
      }
      if (isPunitive(code)) session.recordDenial(code);
      await ledger.append({
        ...base,
        decision: code === "manual_takeover_required" ? "anomaly" : "deny",
        code,
        note: code === "manual_takeover_required" ? "human-only step; the operator takes over through noVNC" : "denied by the browser controller",
      });
      await this.writeResponse(bridge, id, response);
      if (session.revoked) await this.tripBreaker(bridge, callbacks);
      return;
    }

    session.charge(decision.budget ?? ["actions"]);
    if (typeof responseBody.url === "string") bridge.state.lastUrl = responseBody.url;
    const changes = Array.isArray(responseBody.changes)
      ? (responseBody.changes as Array<Record<string, unknown>>).map((change) => ({
          field: String(change.field ?? ""),
          before: String(change.before ?? ""),
          after: String(change.after ?? ""),
        }))
      : undefined;
    const observed = typeof responseBody.url === "string" ? classifyUrl(this.rules, responseBody.url) : undefined;
    await ledger.append({
      ...base,
      site: observed?.siteId ?? base.site,
      origin: observed?.host ?? base.origin,
      surface: observed?.surfaceId ?? base.surface,
      decision: "allow",
      url: typeof responseBody.url === "string" ? responseBody.url : undefined,
      permalink: typeof responseBody.permalink === "string" ? responseBody.permalink : undefined,
      changes,
    });
    if (decision.action === "publish" || decision.action === "submit") {
      callbacks.progress(`Committed ${decision.action} on ${observed?.siteId ?? base.site ?? "the authorized site"}.`);
    }
    await this.writeResponse(bridge, id, response);
  }

  private async tripBreaker(bridge: BridgeContext, callbacks: RunCallbacks): Promise<void> {
    const reason = bridge.session?.revocation ?? "circuit_breaker";
    callbacks.progress(`Professional-socials circuit breaker tripped (${reason}); the mandate is revoked and the run can only read.`);
    await bridge.ledger?.append({ action: "mandate.revoke", decision: "anomaly", code: reason });
    await this.cli.browserCall(bridge.browserSandbox, "/mandate/revoke", {
      ...browserControlPacket(bridge.controlSecret!, "mandate-revoke").packet,
      reason: /^[a-z0-9_:-]{1,64}$/.test(reason) ? reason : "circuit_breaker",
    }).catch(() => undefined);
  }

  /**
   * Moves a worker-produced upload into the browser sandbox without ever
   * exposing a browser-side path, and refuses anything that is not a small
   * image or PDF.
   */
  private async stageUpload(bridge: BridgeContext, artifact: string): Promise<{ ok: true; stageId: string } | { ok: false; code: string }> {
    const source = `/sandbox/jobs/${bridge.jobId}/uploads/${artifact}`;
    // The base64 form of a 5 MiB file exceeds the default capture bound, so
    // this one read raises it to a still bounded limit after the size check.
    const read = await this.cli.exec(bridge.workerSandbox, ["sh", "-c", `test -f '${source}' && test $(wc -c < '${source}') -le ${MAX_UPLOAD_BYTES} && base64 -w0 '${source}'`], { timeout: 30, maxCaptureBytes: 8 * 1024 * 1024 })
      .catch(() => ({ code: 1, stdout: "", stderr: "", aborted: false }));
    if (read.code !== 0 || !read.stdout.trim()) return { ok: false, code: "upload_not_available" };
    const bytes = Buffer.from(read.stdout.trim(), "base64");
    const extension = uploadExtension(bytes);
    if (!extension) return { ok: false, code: "upload_type_denied" };
    const stageId = `${randomUUID()}.${extension}`;
    const write = await this.cli.exec(bridge.browserSandbox, ["sh", "-c", `umask 077; mkdir -p /run/openshell-browser/uploads && base64 -d > /run/openshell-browser/uploads/${stageId}`], {
      input: read.stdout.trim(),
      timeout: 30,
    });
    if (write.code !== 0) return { ok: false, code: "upload_stage_failed" };
    bridge.stagedUploads.push(stageId);
    return { ok: true, stageId };
  }

  private async claimAndRespond(bridge: BridgeContext, id: string, response: { status: number; body: Record<string, unknown> }): Promise<void> {
    const claimed = await this.cli.exec(bridge.workerSandbox, ["mv", `/sandbox/.openshell-agent/browser-bridge/${id}.request`, `/sandbox/.openshell-agent/browser-bridge/${id}.processing`], { timeout: 5 });
    if (claimed.code !== 0) return;
    await this.writeResponse(bridge, id, response);
  }

  private async writeResponse(bridge: BridgeContext, id: string, response: { status: number; body: Record<string, unknown> }): Promise<void> {
    const written = await this.cli.exec(bridge.workerSandbox, ["sh", "-c", `umask 077; cat > /sandbox/.openshell-agent/browser-bridge/${id}.response.pending && mv /sandbox/.openshell-agent/browser-bridge/${id}.response.pending /sandbox/.openshell-agent/browser-bridge/${id}.response && rm -f /sandbox/.openshell-agent/browser-bridge/${id}.processing`], { input: JSON.stringify(response), timeout: 5 });
    if (written.code !== 0) throw new AgentFailure("browser_bridge_failed", "Could not return a bounded browser response to the worker sandbox");
  }
}

export function browserServiceProfile(profile: OpenShellProfile): OpenShellProfile {
  if (!profile.browser) throw new Error("Browser service profile is missing");
  return {
    ...profile,
    name: `${profile.name}-service`,
    image: profile.browser.image,
    imageContract: profile.browser.imageContract,
    basePolicy: profile.browser.basePolicy,
    providers: [],
    requiredProviderTypes: undefined,
    codexSubscription: undefined,
    browser: undefined,
    filesystem: { readOnly: ["/usr", "/lib", "/proc", "/dev/urandom", "/app", "/etc", "/var/log", "/opt"], readWrite: ["/sandbox", "/tmp", "/dev/null", "/run/openshell-browser", "/var/lib/openshell-browser"] },
    process: { runAsUser: "2000", runAsGroup: "2000" },
  };
}

export class AgentFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function validateInput(rules: SiteRules, profile: OpenShellProfile, input: OpenShellJobInput): void {
  if (!input.task.trim()) throw new AgentFailure("invalid_task", "task is required");
  if (Buffer.byteLength(input.task, "utf8") > 256 * 1024) throw new AgentFailure("invalid_task", "task exceeds the 256 KiB request limit");
  if (profile.repository?.required && !input.repository) throw new AgentFailure("repository_required", `Profile ${profile.name} requires repository.url`);
  if (profile.reuse === "browser-profile" && !input.browserProfile) throw new AgentFailure("browser_profile_required", `Profile ${profile.name} requires browserProfile`);
  if (input.browserProfile && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.browserProfile)) throw new AgentFailure("invalid_browser_profile", "browserProfile has invalid characters");
  if (input.repository?.baseBranch && (!/^[a-zA-Z0-9._/-]+$/.test(input.repository.baseBranch) || input.repository.baseBranch.includes(".."))) {
    throw new AgentFailure("invalid_base_branch", "repository.baseBranch is invalid");
  }
  if (profile.browser?.mode === "professional-socials") {
    const request = input.professionalSocials;
    if (!request || !Array.isArray(request.sites) || request.sites.length === 0) {
      throw new AgentFailure("sites_required", "professional-socials requires at least one rulebook site id");
    }
    const known = siteIds(rules);
    const unknown = request.sites.filter((site) => !known.includes(site));
    if (unknown.length > 0) throw new AgentFailure("unknown_site", `No professional-socials rule exists for ${unknown.join(", ")}`);
    if (new Set(request.sites).size !== request.sites.length) throw new AgentFailure("duplicate_site", "professionalSocials.sites repeats a site");
    if (!Array.isArray(request.allow) || request.allow.length === 0) throw new AgentFailure("classes_required", "professional-socials requires at least one action class");
    const invalid = request.allow.filter((entry) => !["edit-profile", "publish-post"].includes(entry));
    if (invalid.length > 0) throw new AgentFailure("unknown_action_class", `Unsupported action class ${invalid.join(", ")}`);
    try {
      clampBudget(request.budget);
      clampTtlMinutes(request.ttlMinutes);
    } catch (error) {
      throw new AgentFailure("invalid_mandate_bounds", error instanceof Error ? error.message : "invalid mandate bounds");
    }
  } else if (input.professionalSocials) {
    throw new AgentFailure("mode_mismatch", `Profile ${profile.name} does not run in professional-socials mode`);
  }
}

function uploadExtension(bytes: Buffer): string | undefined {
  if (bytes.length < 8) return undefined;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  return undefined;
}

function slugName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "workspace";
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
