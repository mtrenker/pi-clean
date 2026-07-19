import assert from "node:assert/strict";
import test from "node:test";

import { OpenShellClient, parsePolicyProposals, type CommandResult, type CommandRunner } from "./cli.ts";

class FakeRunner implements CommandRunner {
  private readonly values: Record<string, Partial<CommandResult>>;

  constructor(values: Record<string, Partial<CommandResult>>) {
    this.values = values;
  }
  async run(args: string[]): Promise<CommandResult> {
    const value = this.values[args.join(" ")] ?? {};
    return { code: 0, stdout: "", stderr: "", aborted: false, ...value };
  }
}

function client(overrides: Record<string, Partial<CommandResult>> = {}) {
  return new OpenShellClient(new FakeRunner({
    "--version": { stdout: "openshell 0.0.86\n" },
    status: { stdout: "Gateway: test\nStatus: Connected\nVersion: 0.0.86\n" },
    "sandbox create --help": { stdout: "--approval-mode --provider --policy" },
    "rule --help": { stdout: "get approve reject" },
    "provider list-profiles --help": { stdout: "json yaml" },
    "inference get": { stdout: "Gateway inference:\n  Provider: managed\n  Model: model-a\n" },
    "settings get --global": { stdout: "providers_v2_enabled = true\n" },
    ...overrides,
  }));
}

test("preflight accepts the pinned released contract and configured inference", async () => {
  assert.deepEqual(await client().preflight(), {
    cliVersion: "0.0.86",
    gatewayVersion: "0.0.86",
    inferenceProvider: "managed",
    inferenceModel: "model-a",
    inferenceApi: "openai-responses",
  });
});

test("preflight rejects the installed legacy 0.0.68 contract without fallback", async () => {
  await assert.rejects(
    client({ "--version": { stdout: "openshell 0.0.68" }, status: { stdout: "Version: 0.0.68" } }).preflight(),
    /v0\.0\.86\+ is required.*host execution fallback is disabled/i,
  );
});

test("preflight rejects CLI/gateway mismatch and missing inference", async () => {
  await assert.rejects(client({ status: { stdout: "Version: 0.0.87" } }).preflight(), /CLI\/gateway mismatch/);
  await assert.rejects(client({ "inference get": { stdout: "Gateway inference:\n  Not configured" } }).preflight(), /inference\.local is not configured/);
});

test("development provider names resolve to an explicit Providers v2 GitHub type", async () => {
  const valid = client({ "provider get client-a-github": { stdout: "Name: client-a-github\nType: github\n" } });
  const profile = {
    name: "development", description: "test", image: "pi", reuse: "repository" as const, basePolicy: "/tmp/policy.yaml",
    advisorMode: "manual" as const, providers: ["client-a-github"], requiredProviderTypes: ["github"], workerTools: ["read"],
    filesystem: { readOnly: ["/usr"], readWrite: ["/sandbox"] }, process: { runAsUser: "sandbox", runAsGroup: "sandbox" },
    repository: { required: true },
  };
  await valid.validateProviders(profile);
  await assert.rejects(client({ "provider get client-a-github": { stdout: "Type: custom-write-provider" } }).validateProviders(profile), /requires Providers v2 type github/);
});

test("dynamic update failure restores the prior policy and newly attached providers", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      const command = args.join(" ");
      if (command === "sandbox provider list workspace") return { code: 0, stdout: "PROVIDER\nold-provider\n", stderr: "", aborted: false };
      if (command === "policy get workspace --base") return { code: 0, stdout: "version: 1\nnetwork_policies: {}\n", stderr: "", aborted: false };
      if (command === "sandbox provider detach workspace old-provider") return { code: 1, stdout: "", stderr: "denied", aborted: false };
      return { code: 0, stdout: "", stderr: "", aborted: false };
    },
  };
  await assert.rejects(new OpenShellClient(runner).applyDynamicProfile("workspace", {
    name: "test", description: "test", image: "pi", reuse: "trust-domain", basePolicy: "/tmp/new-policy.yaml",
    advisorMode: "manual", providers: ["new-provider"], workerTools: ["read"],
    filesystem: { readOnly: ["/usr"], readWrite: ["/sandbox"] }, process: { runAsUser: "sandbox", runAsGroup: "sandbox" },
  }), /last-known policy and provider attachments were restored/);
  assert.ok(calls.some((args) => args[0] === "policy" && args[1] === "set" && args[4]?.includes("pi-openshell-policy-")));
  assert.ok(calls.some((args) => args.join(" ") === "sandbox provider detach workspace new-provider"));
});

test("policy proposal parsing exposes structured grant and prover evidence", () => {
  const proposals = parsePolicyProposals(`
Pending network rules
Chunk ID: chunk-123
Status: pending
Binary: /usr/bin/gh
Endpoints: api.github.com:443 [L7 rest, allow PUT /repos/acme/docs/**]
Validation result: credential_reach_expansion, capability_expansion
Rationale: the agent says this is safe
`);
  assert.deepEqual(proposals, [{
    id: "chunk-123",
    status: "pending",
    host: "api.github.com",
    port: 443,
    binary: "/usr/bin/gh",
    method: "PUT",
    path: "/repos/acme/docs/**",
    proverFindings: ["credential_reach_expansion", "capability_expansion"],
    rationale: "the agent says this is safe",
  }]);
});
