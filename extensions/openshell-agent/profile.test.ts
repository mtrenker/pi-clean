import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BUILTIN_PROFILES, loadProfiles } from "./profile.ts";

test("built-in examples are deny-first and keep business providers off research", async () => {
  const research = BUILTIN_PROFILES["web-research"];
  const development = BUILTIN_PROFILES.development;
  assert.deepEqual(research.providers, []);
  assert.equal(research.advisorMode, "auto");
  assert.equal(development.advisorMode, "manual");
  assert.deepEqual(development.requiredProviderTypes, ["github"]);
  const { readFile } = await import("node:fs/promises");
  for (const profile of Object.values(BUILTIN_PROFILES)) {
    const policy = await readFile(profile.basePolicy, "utf8");
    assert.match(policy, /host: chatgpt\.com/);
    assert.match(policy, /path: \/opt\/openshell-agent\/relay-node/);
    assert.match(policy, /method: POST\s+path: \/backend-api\/codex\/responses/);
    assert.doesNotMatch(policy, /host: chatgpt\.com[\s\S]*?access:/);
    assert.equal((policy.match(/host:/g) ?? []).length, 1);
    assert.equal(policy.includes("host: *"), false);
  }
});

test("project profiles are honored only for a trusted Pi project and user overlays win", async () => {
  const root = await mkdtemp(join(tmpdir(), "openshell-profiles-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, ".pi", "project-policy.yaml"), "version: 1\nnetwork_policies: {}\n");
  await writeFile(join(cwd, ".pi", "openshell-agent.json"), JSON.stringify({ profiles: {
    "client-dev": { extends: "development", providers: ["project-github"], basePolicy: "./project-policy.yaml" },
  } }));
  await writeFile(join(agentDir, "openshell-agent.json"), JSON.stringify({ profiles: {
    "client-dev": { extends: "development", providers: ["user-github"] },
  } }));

  const untrusted = await loadProfiles({ cwd, agentDir, projectTrusted: false });
  assert.deepEqual(untrusted["client-dev"].providers, ["user-github"]);
  assert.match(untrusted["client-dev"].basePolicy, /development\.policy\.yaml$/);

  const trusted = await loadProfiles({ cwd, agentDir, projectTrusted: true });
  assert.deepEqual(trusted["client-dev"].providers, ["user-github"]);
});

test("profile files reject credential-shaped fields instead of forwarding values", async () => {
  const root = await mkdtemp(join(tmpdir(), "openshell-secret-profile-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "openshell-agent.json"), JSON.stringify({ profiles: {
    unsafe: { extends: "development", apiKey: "do-not-forward" },
  } }));
  await assert.rejects(loadProfiles({ cwd: root, agentDir: root, projectTrusted: false }), /never credential material.*apiKey/i);
});
