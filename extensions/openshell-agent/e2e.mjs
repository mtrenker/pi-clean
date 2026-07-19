#!/usr/bin/env node

if (process.env.OPENSHELL_AGENT_E2E !== "1") {
  console.log("SKIP: set OPENSHELL_AGENT_E2E=1 for the credentialed OpenShell/Codex integration check");
  process.exit(0);
}

const [{ readLocalCodexCredentials }, { resolveIdentity }, { OpenShellAgentOrchestrator }, { BUILTIN_PROFILES }] = await Promise.all([
  import("./codex-auth.ts"),
  import("./identity.ts"),
  import("./orchestrator.ts"),
  import("./profile.ts"),
]);

const orchestrator = new OpenShellAgentOrchestrator({ proposalPollMs: 200 });
const profile = BUILTIN_PROFILES["web-research"];
const trustDomain = `openshell-agent-e2e-${Date.now()}`;
const callbacks = {
  confirmRecreate: async () => true,
  reviewProposal: async () => ({ action: "reject", reason: "The bounded integration check needs no policy expansion." }),
  progress: (message) => process.stderr.write(`${message}\n`),
};
const firstInput = { task: "Reply with exactly OPENSHELL_CODEX_E2E_ONE", profile: profile.name, trustDomain };
const identity = await resolveIdentity(profile, firstInput);
const credentialsBefore = await readLocalCodexCredentials();

try {
  const first = await orchestrator.run(profile, firstInput, undefined, callbacks);
  assertResult(first, "OPENSHELL_CODEX_E2E_ONE", false);

  const second = await orchestrator.run(profile, {
    task: "Reply with exactly OPENSHELL_CODEX_E2E_TWO", profile: profile.name, trustDomain,
  }, undefined, callbacks);
  assertResult(second, "OPENSHELL_CODEX_E2E_TWO", true);

  const credentialsAfter = await readLocalCodexCredentials();
  const inspection = await orchestrator.cli.exec(second.sandboxName, ["sh", "-c",
    "find /sandbox/.pi-agent /sandbox/.openshell-agent /sandbox/jobs -type f -maxdepth 3 -exec cat {} \\; 2>/dev/null; printf '\\n---ENV---\\n'; env; printf '\\n---PROC---\\n'; for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\" 2>/dev/null; echo; done"], { timeout: 30 });
  if (inspection.code !== 0) throw new Error("Sandbox canary inspection failed");
  const canaries = new Set([...Object.values(credentialsBefore), ...Object.values(credentialsAfter)]);
  for (const value of canaries) {
    if (inspection.stdout.includes(value) || inspection.stderr.includes(value)) throw new Error("A host Codex credential appeared in the sandbox inspection");
  }
  console.log(JSON.stringify({ status: "pass", model: profile.codexSubscription.model, persistentReuse: true, credentialCanariesAbsent: true }));
} finally {
  await orchestrator.cli.deleteSandbox(identity.sandboxName).catch(() => {});
  await orchestrator.registry.remove(identity.logicalKey).catch(() => {});
}

function assertResult(result, expected, reused) {
  if (result.status !== "complete" || result.answer.trim() !== expected || result.reused !== reused) {
    throw new Error(`Unexpected bounded worker result (${result.status}, reused=${result.reused})`);
  }
}
