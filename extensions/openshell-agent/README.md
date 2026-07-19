# OpenShell Agent

`openshell_agent` runs the autonomous Pi worker **inside** an OpenShell sandbox. The host extension only creates/reuses the workspace, reviews structured policy grants, streams trusted lifecycle metadata, and renders the bounded final answer from tool `details`.

The result is terminating. Model-visible tool `content` contains only status and sandbox/job IDs; the untrusted worker answer is never returned to the host model. For that reason the tool fails closed in print, JSON, and RPC modes and currently supports TUI mode only.

## Prerequisites and compatibility

The first tested contract is the published OpenShell **v0.0.86** release. CLI and gateway must both be at least that version and must match exactly. The built-in worker image is pinned to OpenShell Community Pi commit `a2afd1ba5d0655ed531d7cd0bd7e1b93cb788a61` and multi-platform image digest `sha256:88716cf8c342af78b2af20e6e3b2c55e27eecea5a989fcbeaf61c10e0ec1df02` rather than a mutable tag; the authenticated-browser derivative pins the same base. The extension never falls back to host execution. The preflight also checks:

- `sandbox create`, Providers v2, and Policy Advisor capabilities;
- `providers_v2_enabled = true`;
- a current official Codex CLI login at `~/.codex/auth.json`, owned by the current user and mode `0600`.

Typical setup:

```bash
openshell settings set --global --key providers_v2_enabled --value true
openshell settings set --global --key agent_policy_proposals_enabled --value true --yes
codex login
```

Before every job, the trusted host reads the local Codex file without following symlinks, validates its owner, mode, account claim, and access-token expiry, then creates or updates the configured gateway `codex` provider. Credential values travel only in the host `openshell provider create|update` child environment—never arguments, output, logs, uploads, the extension workspace registry, or sandbox files. The default provider/model is `codex-subscription` + `gpt-5.6-terra`.

The worker uses a synthetic non-secret JWT only to satisfy Pi's local account-claim parser and calls an image-owned loopback relay. That relay accepts one bounded Codex Responses path, discards caller authentication, inserts stable OpenShell access/account placeholders, and forwards only to `chatgpt.com/backend-api/codex/responses`. OpenShell resolves the current gateway provider values at the network boundary. Local refresh is disabled; the official host Codex login remains the source of truth and must be refreshed externally before it expires. Do not put tokens, passwords, cookies, refresh material, or private keys in profile files or tool arguments.

## Profiles and trust domains

Every invocation requires `trustDomain`. Sandbox identity includes the profile, trust domain, static fingerprint, and—where relevant—the normalized repository or browser profile. A provider instance already recorded for another trust domain is rejected; create separately named provider instances for personal, project, and client domains.

Built-ins all use the Codex inference provider through the fixed relay; it is infrastructure access and is excluded from cross-trust business-provider reuse checks. Other providers remain isolated by trust domain:

- `web-research`: no research/business provider, default-deny network except the fixed model relay, persistent per trust domain. Policy Advisor `auto` is opt-in at sandbox scope and OpenShell only auto-approves an **empty prover delta**.
- `development`: persistent per trust domain + repository, sandbox-side clone/worktrees, built-in GitHub provider name `github`, manual policy review. Override the provider name when your gateway instance has another name. Preflight resolves every provider instance and requires at least one Providers v2 `github` profile type; a same-named arbitrary provider is not accepted.
- `authenticated-browser`: repository-owned Pi/Chromium derivative, persistent per trust domain + `browserProfile`, no business provider by default, manual policy review and noVNC takeover.

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

A profile may override `codexSubscription.provider` and `codexSubscription.model`; the provider must be a Providers v2 `codex` instance. The host credential source is deliberately not configurable from project files and remains the current user's protected `~/.codex/auth.json`.

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

Takeover first suspends the worker process group, then submits a timestamped, one-time HMAC control packet so the controller enters a paused state before opening a loopback-only noVNC forward. The shared control secret is initialized before the first worker starts, persists only in the host mode-`0600` registry and browser-user mode-`0600` storage, and is never transmitted after initialization. The VNC password is derived independently by host and controller from that secret during pre-worker initialization, so it is never sent in a control packet or returned by any in-sandbox endpoint. If controller pause fails, the worker is resumed and no forward opens; explicit `/openshell resume` also repairs a stranded pause. Chromium exposes no CDP/debugging socket to the worker. Xvfb requires a browser-user-only Xauthority cookie and x11vnc requires the one-time VNC password. While paused, every automation route returns `automation_paused`; no automation, screenshots, tracing, keystroke capture, or request-body logging runs during takeover. Password and 2FA values travel directly through noVNC to the sandbox browser process; they do enter that browser process, but not Pi context, OpenShell provider values, command arguments, logs, tool results/details, or artifacts. The operator must explicitly run `resume`; closing the page is not enough.

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

Deterministic tests use injected fake CLI responses for compatibility, identity isolation, safe Codex auth import, provider synchronization, fixed relay boundaries, policy parsing, result boundaries, lifecycle reuse, and cancellation-safe command transport. Live validation on OpenShell v0.0.86 ran Pi with `gpt-5.6-terra` through the placeholder relay, scanned sandbox files/environment/process arguments/diagnostics for host token canaries, and reused the same persistent workspace for a second successful job.
