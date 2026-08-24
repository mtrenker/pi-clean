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
- `authenticated-browser`: repository-owned Pi/Chromium derivative, persistent per trust domain + `browserProfile`, no business provider by default, manual policy review and noVNC takeover. Consequential actions stay blocked for the operator.
- `professional-socials`: the same persistent browser workspace, but one task-level authorization mints a bounded host mandate so the worker edits, submits, and publishes autonomously on LinkedIn, Xing, freelance.de, freelancermap, GULP, and Malt. See [Task-authorized professional-social maintenance](#task-authorized-professional-social-maintenance).

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

Authenticated browsing uses a paired persistent workspace: Pi runs in the normal worker sandbox, while Chromium, its profile, the constrained controller, and noVNC run under pinned UID 2000 in a separate browser-service sandbox keyed by `trustDomain + browserProfile` and shared with the autonomous mode. The worker can reach neither that sandbox nor its profile files. An image-owned file queue and bounded host bridge expose only navigate, bounded text snapshot, non-consequential click/type, and navigation-key operations. There are no cookie/storage/export, download, screenshot, trace, raw CDP, or arbitrary-JavaScript endpoints. Password, OTP, CAPTCHA, submit, login, profile/account, application, message/post, purchase/payment, consent/terms, and delete actions are blocked for manual takeover.

```text
/openshell takeover <workspace-id> [local-port]
/openshell resume <workspace-id>
```

Takeover first suspends the worker process group in the worker sandbox, then submits a timestamped, one-time HMAC control packet to the separate browser-service sandbox so the controller enters a paused state before opening a loopback-only noVNC forward. The shared control secret is initialized before the first worker starts, persists only in the host mode-`0600` registry and browser-user mode-`0600` storage, and is never transmitted after initialization. The VNC password is derived independently by host and controller from that secret during pre-worker initialization, so it is never sent in a control packet or returned by any in-sandbox endpoint. If controller pause fails, the worker is resumed and no forward opens; explicit `/openshell resume` also repairs a stranded pause. Chromium exposes no CDP/debugging socket to the worker. Xvfb requires a browser-user-only Xauthority cookie and x11vnc requires the one-time VNC password. While paused, every automation route returns `automation_paused`; no automation, screenshots, tracing, keystroke capture, or request-body logging runs during takeover. Password and 2FA values travel directly through noVNC to the sandbox browser process; they do enter that browser process, but not Pi context, OpenShell provider values, command arguments, logs, tool results/details, or artifacts. The operator must explicitly run `resume`; closing the page is not enough.

CAPTCHA and site-security challenges are always handed to the operator. The extension does not spoof browser identity, solve challenges, evade rate limits/robots/paywalls/access controls, or export browser bearer state. In this `authenticated-browser` mode every consequential authenticated action stays manual, which is deliberately safer than letting a compromised worker forge an approval. Autonomous editing and publishing is a separate, explicitly authorized mode; see below.

## Task-authorized professional-social maintenance

`professional-socials` is the autonomous mode. The operator authorizes the task
once, up front, and then reviews the result; there is no per-action prompt.

```json
{
  "task": "Update my LinkedIn headline to \"Fractional CTO\" and publish the launch post from /sandbox/jobs/<id>/uploads/post.md.",
  "profile": "professional-socials",
  "trustDomain": "personal",
  "browserProfile": "personal-browser",
  "professionalSocials": {
    "sites": ["linkedin", "xing"],
    "allow": ["edit-profile", "publish-post"],
    "budget": { "submits": 2, "publishes": 1 },
    "ttlMinutes": 30
  }
}
```

The confirmation dialog shows the sites and their origins, the action classes,
the budget, the TTL, and the browser workspace. Approving it mints a single
mandate bound to the job, workspace, browser workspace, controller process,
task hash, origins, classes, budget, and expiry. Declining stops before any
browser action.

**Authority boundary.** The mandate is minted by the host, verified again by the
browser controller with a key derived from the host-only browser control secret,
and never reaches the worker sandbox in any form. The worker cannot mint, read,
forge, replay, extend, or reuse it across jobs, workspaces, expiry, or a
controller restart. Every action is authorized twice — once by the host bridge
and once by the controller — against the repository-owned rulebook in
`site-rules.json`, a byte-identical copy of which is baked into the browser
image.

**What the worker can do.** Snapshot with element refs (no CSS selectors),
click, fill, clear, check/uncheck, select, combobox, contenteditable edit,
allowed Enter, scroll, wait, back, dialog accept/dismiss, staged upload,
checkpoint, and submit/publish. Arbitrary JavaScript, raw CDP, cookie and
storage APIs, downloads, browser-profile export, and screenshots stay
unavailable.

**What always stops it.** Global hard denies beat every site rule: credentials,
account security and recovery, sessions and devices, OAuth consent, billing and
payment, terms acceptance, delete or deactivate, plus messaging, connection
requests, endorsements, and job applications, which are out of scope for this
slice. Sensitive fields never receive a ref, denied surfaces are redacted out of
worker snapshots, an unmapped path stays read-only, and an unlisted origin is
never an explicit navigation target.

**Declared diffs.** A submit or publish must declare every changed field with
its exact before and after value against a checkpoint taken before the edits.
The controller compares that with what it observed and refuses on an undeclared
field, a missing field, or a different value. Two mismatches, three consecutive
authorization denials, or five denials in total revoke the mandate for the rest
of the job.

**Login and challenges.** Login, password, OTP, CAPTCHA, and security challenges
are refused with `manual_takeover_required` and belong to `/openshell takeover`.
Explicit `/openshell resume` invalidates every ref and checkpoint, revalidates
the mandate TTL, and compares the logged-in account identity per origin: a
different account revokes the mandate.

**Review.** Every job writes a trusted host ledger to
`~/.pi/agent/openshell-agent-audit/<workspace-id>/<job-id>.jsonl` and renders a
report from controller-observed facts: sites, surfaces, before/after values,
submits, publications and permalinks, denials, anomalies, and budget use. The
worker narrative is rendered separately and labeled untrusted. Read a stored
report again with `/openshell audit <workspace-id> [job-id]`.

**Shared browser workspace.** Browser identity is `trustDomain +
browserProfile`, separate from worker profile identity, so the safe and the
autonomous mode share one logged-in browser while keeping their own worker
sandboxes. Switching mode is a dynamic network-policy change and never
recreates the browser; the safe baseline policy is restored when the job ends.
The browser network policy is an explicit per-host allowlist generated from the
rulebook and contains no wildcard host. Both modes carry the same bounded host
set, because a manual login also needs the site's own CSS and JavaScript, and
every endpoint is bound to the pinned Chromium executable
(`/opt/openshell-browser/browsers/chromium-1228/chrome-linux64/chrome`) that
OpenShell v0.0.86 requires for binary identity. What safe mode withholds is the
mandate, not the network.

**Site rules need live validation.** The shipped path, dialog, and permalink
patterns are conservative and were not verified against the live sites, which
needs authenticated accounts. Unmatched paths and dialogs fail closed, so an
outdated rule stops a run with review evidence instead of widening anything.
Validate a site with the live check below before relying on it, and refine
`site-rules.json` from the report.

## Management and cleanup

```text
/openshell profiles
/openshell list
/openshell status <workspace-id>
/openshell audit <workspace-id> [job-id]
/openshell recreate <workspace-id>
/openshell delete <workspace-id>
/openshell browser-recreate <workspace-id>
```

`delete` and `recreate` act on the worker sandbox only and keep the shared
browser workspace and its logged-in sessions. `browser-recreate` is the explicit
destructive path for the browser workspace itself: it deletes cookies, local
storage, history, and every session, and you log in again through
`/openshell takeover`. Delete/recreate explicitly warns that checkout, cache, artifact, download, history, cookie, local-storage, and browser-profile state will be removed. There is no browser-profile backup/export path.

## Validation

Deterministic tests use injected fake CLI responses for compatibility, identity isolation, safe Codex auth import, provider synchronization, fixed relay boundaries, policy parsing, result boundaries, lifecycle reuse, and cancellation-safe command transport. The credentialed integration check is explicit and cleans up its temporary workspace:

```bash
OPENSHELL_AGENT_E2E=1 npm run test:openshell-agent:e2e
```

The professional-socials slice adds deterministic tests for mandate
canonicalization/MAC/replay/TTL/budgets, dual authorization, origin, surface and
class confinement, global-deny precedence, declared diffs, circuit breaking,
takeover and resume transitions, identity drift, audit generation and redaction,
workspace reuse and isolation, and the v1 to v2 registry migration, plus a
parity check that the host and the in-image rulebook reach identical verdicts.

Two opt-in checks go further:

```bash
# Real controller against local fixture pages; needs playwright-core + Chromium.
npm i --no-save playwright-core
node node_modules/playwright-core/cli.js install chromium
OPENSHELL_BROWSER_FIXTURE=1 npm run test:openshell-agent:browser-fixture

# One low-risk field change and revert on an operator-owned account.
OPENSHELL_PROFESSIONAL_SOCIALS_LIVE=1 PS_LIVE_TRUST_DOMAIN=personal \
  PS_LIVE_BROWSER_PROFILE=personal-browser PS_LIVE_SITE=linkedin \
  PS_LIVE_PROFILE_URL=https://www.linkedin.com/in/you PS_LIVE_FIELD=Headline \
  PS_LIVE_VALUE="temporary value" PS_LIVE_ORIGINAL="current value" \
  npm run test:openshell-agent:live
```

The fixture harness maps the authorized hostnames to a local server through
Chromium's host resolver, so it exercises the real rulebook, dialogs, refs,
declared diffs, hostile page instructions, sensitive surfaces, staged uploads,
single-page saves, and pause/resume without contacting any site. The live check
requires a browser workspace that is already logged in, changes exactly one
designated field, reverts it, checks the trusted report, scans the ledger for
credential canaries, and verifies persistent session reuse. Site terms of
service remain the operator's responsibility.

Live validation on OpenShell v0.0.86 ran that check with Pi and `gpt-5.6-terra` through the placeholder relay, scanned sandbox files/environment/process arguments/diagnostics for host token canaries, and reused the same persistent workspace for a second successful job.
