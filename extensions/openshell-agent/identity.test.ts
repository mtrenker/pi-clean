import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertProviderIsolation, dynamicFingerprint, resolveIdentity } from "./identity.ts";
import type { OpenShellJobInput, OpenShellProfile, WorkspaceRecord } from "./types.ts";

const BASE_POLICY = "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies: {}\n";

function profile(policy: string): OpenShellProfile {
  return {
    name: "development", description: "test", image: "pi", cpu: "1", memory: "2G",
    reuse: "repository", basePolicy: policy, advisorMode: "manual", providers: ["client-a-github"],
    workerTools: ["read", "bash"], filesystem: { readOnly: ["/usr"], readWrite: ["/sandbox"] },
    process: { runAsUser: "sandbox", runAsGroup: "sandbox" }, repository: { required: true, defaultBaseBranch: "main" },
  };
}

function input(trustDomain: string): OpenShellJobInput {
  return { task: "test", profile: "development", trustDomain, repository: { url: "https://github.com/acme/project.git" } };
}

test("workspace and sandbox identities cannot cross trust domains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openshell-identity-"));
  const policy = join(dir, "policy.yaml");
  await writeFile(policy, BASE_POLICY);
  const a = await resolveIdentity(profile(policy), input("client-a"));
  const b = await resolveIdentity(profile(policy), input("client-b"));
  assert.notEqual(a.logicalKey, b.logicalKey);
  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.notEqual(a.sandboxName, b.sandboxName);
});

test("static drift recreates while network/provider drift remains dynamic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openshell-drift-"));
  const policy = join(dir, "policy.yaml");
  await writeFile(policy, BASE_POLICY);
  const base = profile(policy);
  const identity = await resolveIdentity(base, input("client-a"));
  const staticChanged = await resolveIdentity({ ...base, memory: "4G" }, input("client-a"));
  assert.equal(identity.logicalKey, staticChanged.logicalKey);
  assert.notEqual(identity.staticFingerprint, staticChanged.staticFingerprint);
  assert.notEqual(identity.sandboxName, staticChanged.sandboxName);

  const before = await dynamicFingerprint(base);
  await writeFile(policy, BASE_POLICY.replace("network_policies: {}", "network_policies:\n  docs: {name: docs, endpoints: []}"));
  const after = await dynamicFingerprint(base);
  assert.notEqual(before, after);
  assert.equal(identity.staticFingerprint, (await resolveIdentity(base, input("client-a"))).staticFingerprint);

  await writeFile(policy, BASE_POLICY.replace("read_write: [/sandbox]", "read_write: [/sandbox, /extra]"));
  assert.notEqual(identity.staticFingerprint, (await resolveIdentity(base, input("client-a"))).staticFingerprint);
});

test("one provider instance name cannot be shared by different trust domains", () => {
  const record = {
    logicalKey: "a", workspaceId: "a", profile: "development", trustDomain: "client-a",
    sandboxName: "a", sandboxId: "a", staticFingerprint: "a", dynamicFingerprint: "a",
    providers: ["shared-github"], createdAt: "now", updatedAt: "now",
  } satisfies WorkspaceRecord;
  assert.throws(() => assertProviderIsolation([record], "client-b", ["shared-github"], "b"), /distinct provider instance/);
  assert.doesNotThrow(() => assertProviderIsolation([record], "client-a", ["shared-github"], "b"));
});
