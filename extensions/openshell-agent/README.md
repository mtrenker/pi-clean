# OpenShell Agent

`openshell_agent` runs the autonomous Pi worker **inside** an OpenShell sandbox. The host extension only creates/reuses the workspace, reviews structured policy grants, streams trusted lifecycle metadata, and renders the bounded final answer from tool `details`.

The result is terminating. Model-visible tool `content` contains only status and sandbox/job IDs; the untrusted worker answer is never returned to the host model. For that reason the tool fails closed in print, JSON, and RPC modes and currently supports TUI mode only.

## Prerequisites and compatibility

The first tested contract is the published OpenShell **v0.0.86** release. CLI and gateway must both be at least that version and must match exactly. The built-in worker image is pinned to OpenShell Community Pi commit `a2afd1ba5d0655ed531d7cd0bd7e1b93cb788a61` (`:a2afd1b`) rather than `latest`; the authenticated-browser derivative pins the same base. The extension never falls back to host execution. The preflight also checks:

- `sandbox create`, Providers v2, and Policy Advisor capabilities;
- `providers_v2_enabled = true`;
- a configured user-facing `inference.local` provider and model.

Typical setup:

```bash
openshell settings set --global --key providers_v2_enabled --value true
openshell settings set --global --key agent_policy_proposals_enabled --value true --yes
openshell inference set --provider <gateway-provider-name> --model <model-id>
```

Real inference/provider credentials remain gateway-owned. Profiles contain provider **names**, never values. The worker gets only an `unused` SDK placeholder; `inference.local` strips it and injects gateway credentials. Do not put tokens, passwords, cookies, refresh material, or private keys in profile files or tool arguments.

## Profiles and trust domains

Every invocation requires `trustDomain`. Sandbox identity includes the profile, trust domain, static fingerprint, and—where relevant—the normalized repository or browser profile. A provider instance already recorded for another trust domain is rejected; create separately named provider instances for personal, project, and client domains.

Built-ins:

- `web-research`: provider-free, default-deny network, persistent per trust domain. Policy Advisor `auto` is opt-in at sandbox scope and OpenShell only auto-approves an **empty prover delta**.
- `development`: persistent per trust domain + repository, sandbox-side clone/worktrees, built-in GitHub provider name `github`, manual policy review. Override the provider name when your gateway instance has another name. Preflight resolves every provider instance and requires at least one Providers v2 `github` profile type; a same-named arbitrary provider is not accepted.
- `authenticated-browser`: repository-owned Pi/Chromium derivative, persistent per trust domain + `browserProfile`, no provider by default, manual policy review and noVNC takeover.

Invoke from the model with a request shaped like:

```json
{
  "task": "Research the provenance of this claim and summarize the evidence.",
  "profile": "web-research",
  "trustDomain": "personal-research"
}
```

Development example:

```json
{
  "task": "Implement the requested change, test it, and commit it. Do not open a PR.",
  "profile": "client-a-development",
  "trustDomain": "client-a",
  "repository": {
    "url": "https://github.com/example/project.git",
    "baseBranch": "main"
  }
}
```

The task is written through `openshell sandbox exec` stdin, never placed in a host process argument. The host checkout, home, SSH agent, auth files, and browser profile are never mounted or uploaded. Repository clones, task worktrees, caches, full worker JSONL logs, results, and artifacts stay under `/sandbox`.

## Operator overlays

User config: `~/.pi/agent/openshell-agent.json`

Trusted project config: `.pi/openshell-agent.json`

Project config is ignored unless Pi reports the project trusted. User overlays load last. Paths beginning with `.` resolve relative to their config file.

```json
{
  "profiles": {
    "client-a-development": {
      "extends": "development",
      "providers": ["client-a-github"],
      "cpu": "2",
      "memory": "6G"
    },
    "client-a-browser": {
      "extends": "authenticated-browser",
      "providers": ["client-a-job-board"]
    }
  }
}
```

Static image/resource/filesystem/process/trust-domain drift requires an explicit destructive recreation confirmation. Network policy, advisor mode, and provider-name changes are applied dynamically; failed updates do not update the workspace registry and newly attached providers are rolled back. OpenShell applies policy replacement atomically.

## Policy review and cancellation

Unknown egress is denied. Pending proposals display chunk ID, host, port, binary, method/path, and gateway prover findings. Agent rationale is labeled untrusted and is never enough to approve. Rejection guidance is returned through OpenShell to the waiting worker. The worker waits on `policy.local` without consuming model turns.

Escape cancellation terminates the active `sandbox exec` process group. It does not delete a persistent sandbox or worktree. Full diagnostics remain in `/sandbox/jobs/<job-id>/worker.jsonl`; stdout/result transfer is bounded and malformed results fail closed.

## Authenticated browser and manual takeover

The browser image keeps Chromium under a separate Unix account in `/var/lib/openshell-browser`. The worker only receives a loopback controller with navigate, bounded text snapshot, non-consequential click/type, and navigation-key operations. There are no cookie/storage/export, download, screenshot, trace, raw CDP, or arbitrary-JavaScript endpoints. Password, OTP, CAPTCHA, submit, login, profile/account, application, message/post, purchase/payment, consent/terms, and delete actions are blocked for manual takeover.

```text
/openshell takeover <workspace-id> [local-port]
/openshell resume <workspace-id>
```

Takeover first suspends the worker process group, then asks the controller to write its pause marker and OS-suspend its own process before opening a loopback-only noVNC forward. Chromium exposes no CDP/debugging socket to the worker. The stopped controller retains only an inert private Playwright pipe so Chromium can stay alive for the human; no automation, screenshots, tracing, keystroke capture, or request-body logging can run during takeover. Password and 2FA values travel directly through noVNC to the sandbox browser process; they do enter that browser process, but not Pi context, OpenShell provider values, command arguments, logs, tool results/details, or artifacts. The operator must explicitly run `resume`; closing the page is not enough.

CAPTCHA and site-security challenges are always handed to the operator. The extension does not spoof browser identity, solve challenges, evade rate limits/robots/paywalls/access controls, or export browser bearer state. Consequential authenticated actions remain manual in this first slice even after confirmation, which is deliberately safer than letting a compromised worker forge an approval.

## Management and cleanup

```text
/openshell profiles
/openshell list
/openshell status <workspace-id>
/openshell recreate <workspace-id>
/openshell delete <workspace-id>
```

Delete/recreate explicitly warns that checkout, cache, artifact, download, history, cookie, local-storage, and browser-profile state will be removed. There is no browser-profile backup/export path.

## Validation

Deterministic tests use injected fake CLI responses for compatibility, identity isolation, policy parsing, result boundaries, lifecycle reuse, and cancellation-safe command transport. An end-to-end gateway run is intentionally opt-in because it requires matching OpenShell v0.0.86+, the community Pi image, configured inference, and operator-owned providers.
