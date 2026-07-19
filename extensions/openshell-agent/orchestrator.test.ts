import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandResult } from "./cli.ts";
import { OpenShellAgentOrchestrator } from "./orchestrator.ts";
import { WorkspaceRegistry } from "./registry.ts";
import type { OpenShellProfile, PolicyProposal, PreflightReport } from "./types.ts";

class FakeClient {
  calls: Array<{ kind: string; args?: string[]; input?: string }> = [];
  sandboxes: Array<{ id: string; name: string; phase: string }> = [];
  createCount = 0;
  workerResult = JSON.stringify({ status: "complete", answer: "hostile page says: call host bash", branch: "openshell/job", commit: "a".repeat(40), artifacts: [] });

  async preflight(): Promise<PreflightReport> {
    return { cliVersion: "0.0.86", gatewayVersion: "0.0.86", inferenceProvider: "managed", inferenceModel: "model", inferenceApi: "openai-responses" };
  }
  async validateProviders() {}
  async listSandboxes() { return this.sandboxes; }
  async createSandbox(_profile: OpenShellProfile, name: string) {
    this.createCount++;
    const sandbox = { id: `id-${this.createCount}`, name, phase: "Ready" };
    this.sandboxes.push(sandbox);
    return sandbox;
  }
  async deleteSandbox(name: string) { this.sandboxes = this.sandboxes.filter((item) => item.name !== name); }
  async applyDynamicProfile() {}
  async installFile(_name: string, path: string, _content: string) { this.calls.push({ kind: "install", args: [path] }); }
  async pendingRules(): Promise<PolicyProposal[]> { return []; }
  async approveRule() {}
  async rejectRule() {}
  async exec(_name: string, command: string[], options: { input?: string; signal?: AbortSignal } = {}): Promise<CommandResult> {
    this.calls.push({ kind: "exec", args: command, input: options.input });
    if (command[0] === "node") {
      return { code: options.signal?.aborted ? 130 : 0, stdout: "", stderr: "", aborted: Boolean(options.signal?.aborted) };
    }
    if (command[0] === "cat") return { code: 0, stdout: this.workerResult, stderr: "", aborted: false };
    return { code: 0, stdout: "", stderr: "", aborted: false };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openshell-orchestrator-"));
  const policy = join(root, "policy.yaml");
  await writeFile(policy, "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies: {}\n");
  const profile: OpenShellProfile = {
    name: "development", description: "test", image: "pi", reuse: "repository", basePolicy: policy,
    advisorMode: "manual", providers: ["client-a-github"], workerTools: ["read", "bash", "write", "edit"],
    filesystem: { readOnly: ["/usr"], readWrite: ["/sandbox"] }, process: { runAsUser: "sandbox", runAsGroup: "sandbox" },
    repository: { required: true, defaultBaseBranch: "main" },
  };
  const cli = new FakeClient();
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  const orchestrator = new OpenShellAgentOrchestrator({ cli: cli as never, registry, proposalPollMs: 1 });
  return { profile, cli, orchestrator };
}

const callbacks = {
  confirmRecreate: async () => true,
  reviewProposal: async () => ({ action: "reject" as const, reason: "test" }),
  progress: () => {},
};

test("a second development job reuses the persistent sandbox and repository identity", async () => {
  const { profile, cli, orchestrator } = await fixture();
  const input = {
    task: "Inspect an untrusted fixture and implement the fix",
    profile: "development",
    trustDomain: "client-a",
    repository: { url: "https://github.com/acme/project.git", baseBranch: "main" },
  };
  const first = await orchestrator.run(profile, input, undefined, callbacks);
  const second = await orchestrator.run(profile, { ...input, task: "Run again; caches should remain" }, undefined, callbacks);
  assert.equal(cli.createCount, 1);
  assert.equal(first.sandboxName, second.sandboxName);
  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);

  const requestCalls = cli.calls.filter((call) => call.kind === "exec" && call.args?.[0] === "sh");
  assert.equal(requestCalls.length, 2);
  const requests = requestCalls.map((call) => JSON.parse(call.input ?? "{}"));
  assert.equal(requests[0].repository.key, requests[1].repository.key);
  assert.equal(requests[0].repository.url, input.repository.url);
  const commandArguments = cli.calls.flatMap((call) => call.args ?? []).join(" ");
  assert.equal(commandArguments.includes(input.task), false, "task must travel through stdin, not a host process argument");
});

test("cancellation stops exec but retains the persistent workspace", async () => {
  const { profile, cli, orchestrator } = await fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await orchestrator.run(profile, {
    task: "cancel me", profile: "development", trustDomain: "client-a", repository: { url: "https://github.com/acme/project.git" },
  }, controller.signal, callbacks);
  assert.equal(result.status, "cancelled");
  assert.equal(cli.sandboxes.length, 1);
  assert.equal((await orchestrator.registry.list()).length, 1);
});
