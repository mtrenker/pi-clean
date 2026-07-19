import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InferenceApi, OpenShellProfile, PolicyProposal, PreflightReport } from "./types.ts";

export const MINIMUM_OPENSHELL_VERSION = "0.0.86";
const MAX_CAPTURE_BYTES = 256 * 1024;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

export interface CommandRunner {
  run(args: string[], options?: { input?: string; signal?: AbortSignal }): Promise<CommandResult>;
}

export class SpawnCommandRunner implements CommandRunner {
  private readonly executable: string;

  constructor(executable = "openshell") {
    this.executable = executable;
  }

  run(args: string[], options: { input?: string; signal?: AbortSignal } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const child = spawn(this.executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      });

      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch { /* already gone */ }
      };
      const abort = () => { aborted = true; kill(); };
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > MAX_CAPTURE_BYTES) {
          kill();
          reject(new Error("OpenShell command output exceeded the safe capture limit"));
        }
        return next;
      };

      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
      child.on("close", (code) => finish({
        code: code ?? (aborted ? 130 : 1),
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        aborted,
      }));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

export interface ForwardHandle {
  url: string;
  stop(): void;
}

export class OpenShellClient {
  readonly runner: CommandRunner;
  private readonly executable: string;

  constructor(runner: CommandRunner = new SpawnCommandRunner(), executable = "openshell") {
    this.runner = runner;
    this.executable = executable;
  }

  async preflight(profileApi?: InferenceApi): Promise<PreflightReport> {
    const [versionResult, status, createHelp, ruleHelp, profileHelp, inference, settings] = await Promise.all([
      this.runner.run(["--version"]),
      this.runner.run(["status"]),
      this.runner.run(["sandbox", "create", "--help"]),
      this.runner.run(["rule", "--help"]),
      this.runner.run(["provider", "list-profiles", "--help"]),
      this.runner.run(["inference", "get"]),
      this.runner.run(["settings", "get", "--global"]),
    ]);
    for (const [name, result] of [["CLI", versionResult], ["gateway", status], ["sandbox create", createHelp], ["Policy Advisor", ruleHelp], ["Providers v2", profileHelp], ["inference", inference], ["settings", settings]] as const) {
      if (result.code !== 0) throw new Error(`OpenShell ${name} preflight failed. Verify the gateway is reachable and upgrade both CLI and gateway to v${MINIMUM_OPENSHELL_VERSION} or newer.`);
    }

    const cliVersion = parseVersion(versionResult.stdout);
    const gatewayVersion = parseGatewayVersion(status.stdout);
    if (compareVersions(cliVersion, MINIMUM_OPENSHELL_VERSION) < 0 || compareVersions(gatewayVersion, MINIMUM_OPENSHELL_VERSION) < 0) {
      throw new Error(`OpenShell v${MINIMUM_OPENSHELL_VERSION}+ is required (CLI ${cliVersion}, gateway ${gatewayVersion}). Upgrade both; host execution fallback is disabled.`);
    }
    if (cliVersion !== gatewayVersion) {
      throw new Error(`OpenShell CLI/gateway mismatch (CLI ${cliVersion}, gateway ${gatewayVersion}). Install matching released versions before running a job.`);
    }
    const cleanSettings = stripAnsi(settings.stdout);
    if (!/providers_v2_enabled\s*=\s*true/i.test(cleanSettings)) {
      throw new Error("OpenShell Providers v2 is not enabled. Run: openshell settings set --global --key providers_v2_enabled --value true");
    }
    const inferenceInfo = parseInference(inference.stdout);
    if (!inferenceInfo.provider || !inferenceInfo.model) {
      throw new Error("OpenShell inference.local is not configured. Create a gateway provider, then run openshell inference set --provider <name> --model <model>.");
    }
    const inferredApi = profileApi ?? inferApi(inferenceInfo.provider, inferenceInfo.model);
    return { cliVersion, gatewayVersion, inferenceProvider: inferenceInfo.provider, inferenceModel: inferenceInfo.model, inferenceApi: inferredApi };
  }

  async validateProviders(profile: OpenShellProfile): Promise<void> {
    const types: string[] = [];
    for (const provider of profile.providers) {
      const result = await this.required(["provider", "get", provider], `resolve provider ${provider}`);
      const type = stripAnsi(result.stdout).match(/Type\s*:\s*([^\s]+)/i)?.[1];
      if (!type) throw new Error(`OpenShell provider ${provider} did not report a profile type; attach only Providers v2 instances.`);
      types.push(type);
    }
    const missing = (profile.requiredProviderTypes ?? []).filter((required) => !types.includes(required));
    if (missing.length > 0) {
      throw new Error(`Profile ${profile.name} requires Providers v2 type ${missing.join(", ")}. Configure a separately named provider instance for this trust domain.`);
    }
  }

  async listSandboxes(selector?: string): Promise<Array<{ id: string; name: string; phase: string; labels?: Record<string, string> }>> {
    const args = ["sandbox", "list", "--output", "json"];
    if (selector) args.push("--selector", selector);
    const result = await this.required(args, "list sandboxes");
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ id: string; name: string; phase: string; labels?: Record<string, string> }>;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error("OpenShell returned malformed sandbox JSON");
    }
  }

  async createSandbox(profile: OpenShellProfile, name: string, labels: Record<string, string>, signal?: AbortSignal): Promise<{ id: string; name: string }> {
    const args = ["sandbox", "create", "--name", name, "--from", profile.image, "--policy", profile.basePolicy, "--approval-mode", profile.advisorMode, "--no-auto-providers", "--no-tty"];
    if (profile.cpu) args.push("--cpu", profile.cpu);
    if (profile.memory) args.push("--memory", profile.memory);
    for (const provider of profile.providers) args.push("--provider", provider);
    for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
    // Avoid the CLI's default interactive shell. The short initial command
    // exits while the default keep behavior leaves the Ready sandbox intact.
    args.push("--", "/bin/true");
    await this.required(args, "create sandbox", { signal });
    await this.required(["settings", "set", name, "--key", "agent_policy_proposals_enabled", "--value", "true"], "enable Policy Advisor", { signal });
    await this.required(["settings", "set", name, "--key", "proposal_approval_mode", "--value", profile.advisorMode], "set proposal approval mode", { signal });
    const sandbox = (await this.listSandboxes()).find((entry) => entry.name === name);
    if (!sandbox || sandbox.phase.toLowerCase() !== "ready") throw new Error(`Sandbox ${name} did not become Ready`);
    return { id: sandbox.id, name: sandbox.name };
  }

  async deleteSandbox(name: string): Promise<void> {
    await this.required(["sandbox", "delete", name], "delete sandbox");
  }

  async exec(name: string, command: string[], options: { input?: string; signal?: AbortSignal; timeout?: number; workdir?: string } = {}): Promise<CommandResult> {
    const args = ["sandbox", "exec", "--name", name, "--no-tty"];
    if (options.workdir) args.push("--workdir", options.workdir);
    if (options.timeout !== undefined) args.push("--timeout", String(options.timeout));
    args.push("--", ...command);
    return this.runner.run(args, { input: options.input, signal: options.signal });
  }

  async installFile(name: string, sandboxPath: string, content: string, mode = "600"): Promise<void> {
    const result = await this.exec(name, ["sh", "-c", `umask 077; mkdir -p /sandbox/.openshell-agent; cat > ${shellPath(sandboxPath)}; chmod ${mode} ${shellPath(sandboxPath)}`], { input: content });
    if (result.code !== 0) throw new Error("Could not install the non-secret sandbox worker payload");
  }

  async attachedProviders(name: string): Promise<string[]> {
    const result = await this.required(["sandbox", "provider", "list", name], "list attached providers");
    return stripAnsi(result.stdout).split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((value) => value && !/^provider$/i.test(value) && !/^-+$/.test(value));
  }

  async applyDynamicProfile(name: string, profile: OpenShellProfile): Promise<void> {
    const before = await this.attachedProviders(name);
    const previousPolicy = await this.required(["policy", "get", name, "--base"], "snapshot the current base policy");
    const rollbackDir = await mkdtemp(join(tmpdir(), "pi-openshell-policy-"));
    const rollbackPath = join(rollbackDir, "base-policy.yaml");
    await writeFile(rollbackPath, previousPolicy.stdout, { encoding: "utf8", mode: 0o600 });
    const attached: string[] = [];
    const detached: string[] = [];
    try {
      for (const provider of profile.providers.filter((item) => !before.includes(item))) {
        await this.required(["sandbox", "provider", "attach", name, provider], "attach provider");
        attached.push(provider);
      }
      await this.required(["policy", "set", name, "--policy", profile.basePolicy, "--wait"], "update base policy");
      for (const provider of before.filter((item) => !profile.providers.includes(item))) {
        await this.required(["sandbox", "provider", "detach", name, provider], "detach provider");
        detached.push(provider);
      }
      await this.required(["settings", "set", name, "--key", "proposal_approval_mode", "--value", profile.advisorMode], "update proposal approval mode");
    } catch (error) {
      await this.runner.run(["policy", "set", name, "--policy", rollbackPath, "--wait"]);
      for (const provider of detached.reverse()) await this.runner.run(["sandbox", "provider", "attach", name, provider]);
      for (const provider of attached.reverse()) await this.runner.run(["sandbox", "provider", "detach", name, provider]);
      throw new Error(`Dynamic profile update failed; last-known policy and provider attachments were restored: ${errorMessage(error)}`);
    } finally {
      await rm(rollbackDir, { recursive: true, force: true });
    }
  }

  async pendingRules(name: string): Promise<PolicyProposal[]> {
    const result = await this.required(["rule", "get", name, "--status", "pending"], "read pending policy proposals");
    return parsePolicyProposals(result.stdout);
  }

  async approveRule(name: string, id: string): Promise<void> {
    await this.required(["rule", "approve", name, "--chunk-id", id], "approve policy proposal");
  }

  async rejectRule(name: string, id: string, reason: string): Promise<void> {
    await this.required(["rule", "reject", name, "--chunk-id", id, "--reason", reason], "reject policy proposal");
  }

  startForward(name: string, targetPort: number, localPort: number): ForwardHandle {
    const child = spawn(this.executable, ["forward", "service", name, "--target-port", String(targetPort), "--local", `127.0.0.1:${localPort}`], {
      stdio: ["ignore", "ignore", "ignore"], shell: false, detached: process.platform !== "win32",
    });
    return {
      url: `http://127.0.0.1:${localPort}/vnc.html`,
      stop: () => stopChild(child),
    };
  }

  private async required(args: string[], action: string, options: { input?: string; signal?: AbortSignal } = {}): Promise<CommandResult> {
    const result = await this.runner.run(args, options);
    if (result.aborted) return result;
    if (result.code !== 0) throw new Error(`Could not ${action}; OpenShell kept the operation closed. Inspect gateway/sandbox logs for secret-safe diagnostics.`);
    return result;
  }
}

export function parsePolicyProposals(output: string): PolicyProposal[] {
  const clean = stripAnsi(output);
  const starts = [...clean.matchAll(/(?:^|\n)\s*(?:Chunk(?: ID)?|ID)\s*:\s*([^\s]+)/gi)];
  return starts.map((match, index) => {
    const block = clean.slice(match.index ?? 0, starts[index + 1]?.index ?? clean.length);
    const endpoint = block.match(/(?:Endpoint|Endpoints)\s*:\s*([^\s:,[\]]+):(\d+)/i);
    const l7 = block.match(/allow\s+([A-Z]+)\s+([^\]\s]+)/i);
    const findings = block.match(/(?:prover|validation)(?: findings?| result)?\s*:\s*([^\n]+)/i)?.[1]
      ?.split(/[,;]+/).map((value) => value.trim()).filter((value) => value && !/^(?:empty|none|ok)$/i.test(value)) ?? [];
    const status = block.match(/Status\s*:\s*(pending|approved|rejected)/i)?.[1]?.toLowerCase() as PolicyProposal["status"] | undefined;
    return {
      id: safeField(match[1], 128)!,
      status: status ?? "pending",
      host: safeField(endpoint?.[1], 253),
      port: endpoint ? Number(endpoint[2]) : undefined,
      binary: safeField(block.match(/Binary\s*:\s*([^\s]+)/i)?.[1], 512),
      method: safeField(l7?.[1], 16),
      path: safeField(l7?.[2], 1024),
      proverFindings: findings.map((finding) => safeField(finding, 128)!).filter(Boolean),
      rationale: safeField(block.match(/Rationale\s*:\s*([^\n]+)/i)?.[1]?.trim(), 1000),
    };
  }).filter((proposal) => proposal.status === "pending" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(proposal.id));
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

function parseVersion(output: string): string {
  const version = stripAnsi(output).match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!version) throw new Error("Could not parse OpenShell CLI version");
  return version;
}

function parseGatewayVersion(output: string): string {
  const version = stripAnsi(output).match(/Version\s*:\s*(\d+\.\d+\.\d+)/i)?.[1];
  if (!version) throw new Error("Could not parse OpenShell gateway version");
  return version;
}

function parseInference(output: string): { provider?: string; model?: string } {
  const clean = stripAnsi(output);
  const gateway = clean.split(/System inference:/i)[0];
  return {
    provider: gateway.match(/Provider\s*:\s*([^\s]+)/i)?.[1],
    model: gateway.match(/Model\s*:\s*([^\s]+)/i)?.[1],
  };
}

function inferApi(provider: string, model: string): InferenceApi {
  return /anthropic/i.test(provider) || /claude/i.test(model) ? "anthropic-messages" : "openai-responses";
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function safeField(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : stripAnsi(value).slice(0, limit);
}

function shellPath(value: string): string {
  if (!/^\/sandbox\/[a-zA-Z0-9/._-]+$/.test(value)) throw new Error("Worker payload path must stay under /sandbox");
  return `'${value}'`;
}

function stopChild(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* already stopped */ }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
