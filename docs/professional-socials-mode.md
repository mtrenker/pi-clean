# Task-authorized professional-socials maintenance

Durable architecture record for the `professional-socials` OpenShell mode
(issue #28, built on the paired worker/browser sandbox from issue #22). Design
owned by Claude Opus 5, 2026-08-24.

## Intent

One operator authorization at task level lets a sandboxed worker browse
authenticated professional-social sites, edit profile content, and submit or
publish the requested changes **without per-action prompts**. The operator
reviews afterwards. noVNC takeover is reserved for login, password, OTP,
CAPTCHA, security challenges, and recovery.

The existing `authenticated-browser` mode is unchanged and remains the default:
without a mandate, every consequential action is still refused for manual
takeover.

## Trust model

| Component | Trust | Holds |
| --- | --- | --- |
| Pi host extension | trusted | mandate key material, rulebook, ledger, operator UX |
| Browser controller (browser sandbox, UID 2000) | trusted, isolated | Chromium, cookies, rulebook copy, mandate guard |
| Pi worker (worker sandbox) | **untrusted** | task text, snapshots, tool calls |

The worker never receives, reads, mints, extends, or replays a mandate. It only
emits action requests into a file queue; the trusted host bridge authorizes them
and signs each one for the controller.

## The mandate

After one operator confirmation, the host mints a single mandate bound to:

- `jobId`, `workspaceId`, `browserWorkspaceKey`
- `controllerEpoch` — a random id generated when the controller process starts
- `taskHash` — SHA-256 of the authorized task text
- `sites`, `origins`, `actionClasses` — resolved from the repository rulebook
- `budget` — actions, edits, submits, publishes, uploads
- `issuedAt` / `expiresAt` — TTL, default 45 minutes, hard maximum 120

It is MACed with `HMAC(browser control secret, "…mandate-v1")`. The control
secret exists only in the host registry (mode 0600) and in the browser sandbox
(mode 0600, browser user); it is never transmitted after initialization and
never reaches the worker sandbox. Each bridged action additionally carries a
per-request packet — `mandateId`, strictly increasing `seq`, `nonce`,
`timestamp`, and a MAC over the exact request body — so a replayed, reordered,
or altered request is refused inside the sandbox.

Refusals: missing, forged, expired, over-long TTL, replayed (retired mandate id
or reused seq/nonce), cross-job, cross-workspace, and pre-restart mandates. A
controller restart changes the epoch, which invalidates every outstanding
mandate.

## Two independent gates

Every mutating action passes two checks that do not share state:

1. **Host bridge** (`browser-bridge.ts`) — request shape, mandate validity and
   TTL, explicit-navigation origin confinement, URL-level surface classes,
   granted action classes, budget, circuit breaker.
2. **Browser controller** (`image/browser-controller.mjs`) — mandate MAC, epoch,
   workspace binding, per-request MAC/seq/nonce, live page origin, DOM-level
   surface refinement (which dialog is actually open and contains the target),
   sensitive-field rules, declared-diff verification, its own budget and breaker.

Both load the same repository-owned rulebook (`site-rules.json`, byte-identical
copy baked into the browser image) through separate implementations; a parity
test asserts identical verdicts on a shared case table.

## Rulebook

`site-rules.json` is the single durable source for site behavior:

- **Global hard denies** (paths, dialog/heading text, field names, autocomplete
  tokens) always win: credentials, account security and recovery, sessions and
  devices, OAuth consent, billing and payment, terms acceptance, delete and
  deactivate, plus this slice's non-goals — messaging, connections, endorsements
  and job applications.
- **Sites** (LinkedIn, Xing, freelance.de, freelancermap, GULP, Malt) declare
  origins, network hosts, permalink shapes, extra hard denies, and surfaces.
- **Surfaces** map path patterns to action classes and say whether edits happen
  inline or only inside a dialog whose name matches a declared pattern.
- **Commit controls** are recognized by anchored label patterns; clicking one is
  refused so a commit can only happen through a declared diff.

An unmapped path inside a known site is read-only. An unlisted origin is
read-only and can never be an explicit navigation target. Because these DOM
specifics cannot be validated without authenticated accounts, the shipped
patterns are conservative and fail closed; see *Validation status* below.

## Ref-based interaction

CSS selectors are gone from the autonomous surface. Each snapshot bumps a
generation counter and tags visible interactive elements with `data-osref`
(`e<generation>-<index>`). Refs from an earlier generation are refused
(`stale_ref`), and navigation, resume-from-takeover, and a committed submit all
invalidate them.

Available operations: navigate, snapshot, click, fill, clear, check, uncheck,
select, combobox, contenteditable edit, allowed Enter, scroll, wait, back,
dialog accept/dismiss, staged upload, checkpoint, submit/publish. Arbitrary
JavaScript, raw CDP, cookie and storage APIs, downloads, browser-profile export,
and screenshots remain unavailable to the worker.

Enter is allowed only on surfaces that declare `enterKeys`, and a capture-phase
guard suppresses form submission while it is delivered, so Enter can pick a
combobox entry but can never become an undeclared submit.

Uploads are staged by the host: the worker writes a file into its own job
uploads directory and names it; the host checks size and magic bytes (PNG, JPEG,
PDF, ≤ 5 MiB), copies it into the browser sandbox, and hands the controller an
opaque stage id. File inputs are excluded from declared diffs because their
value is a browser-owned path the worker never sees; the upload is audited as
its own action instead.

## Declared diffs

`checkpoint` records the current values of the fields the worker is about to
edit. `submit` must declare every changed field with its exact before and after
value. The controller recomputes the observed diff from the snapshot baseline
plus the checkpoint and refuses when a field is undeclared, missing, or carries
a different value. Two diff mismatches, three consecutive authorization
denials, or five denials in total trip the circuit breaker, which revokes the
mandate for the rest of the job.

## Takeover, identity, and resume

A human-only challenge (`humanRequired`) redacts the snapshot and refuses
automation with `manual_takeover_required`. `/openshell takeover` suspends the
worker process group, pauses the controller behind a one-time HMAC control
packet, and opens the loopback noVNC forward. `/openshell resume` un-pauses the
controller, invalidates every ref and checkpoint, resumes the worker, and
revalidates the mandate: TTL is re-checked and the logged-in account identity is
compared per origin.

Account identity is an opaque keyed tag over that origin's cookie jar, computed
and compared only inside the controller. Cookie values never leave it. An empty
jar becoming non-empty is a login (recorded as an anomaly); one established
account becoming a different one is drift and revokes the mandate.

## Browser workspace identity and migration

Browser identity is now `trustDomain + browserProfile` and lives in its own
registry record with its own control secret, separate from worker profile
identity. `authenticated-browser` and `professional-socials` therefore share one
logged-in browser workspace, while each worker profile keeps its own sandbox.
A mode switch is a *dynamic* network-policy change: both service policies have
byte-identical static sections, so switching never recreates the browser and
never destroys the login. The safe baseline policy is restored at the end of
each autonomous job.

Both service policies allow exactly the `site-rules.json` network hosts on port
443 and bind those endpoints to the pinned Chromium executable
`/opt/openshell-browser/browsers/chromium-1228/chrome-linux64/chrome`. OpenShell
v0.0.86 enforces `require_binary_identity`, so an endpoint without that binary is
denied even when the host is listed. Safe mode carries the same hosts because a
manual login through noVNC has to load the site's own CSS and JavaScript;
collecting those hosts one Policy Advisor denial at a time would widen the
sandbox instead of bounding it. The modes are separated by the mandate and the
rulebook, not by a wider allowlist. The pinned path follows the `playwright-core`
version in `extensions/openshell-agent/image/package.json`: bumping that pin
moves the executable and both policies must be updated in the same change.

Registry v1 → v2 migration adopts each legacy browser sandbox as a shared
browser workspace, keeping its sandbox, control secret, and login. If two legacy
workspaces claim one `trustDomain + browserProfile` pair, neither is adopted:
both are flagged and the next run fails closed rather than silently reassigning
a session. A legacy browser workspace whose controller predates mandate support
keeps working in safe mode and refuses `professional-socials` with explicit
`/openshell browser-recreate` guidance instead of silently destroying the login.

## Audit and review

The host writes a per-job JSONL ledger under
`~/.pi/agent/openshell-agent-audit/<workspace-id>/<job-id>.jsonl` (0600, scoped
per workspace, so another trust domain cannot reach it) from
controller-observed facts: every allowed and denied action, its site, surface,
class, URL, before/after values, permalinks, anomalies, and budget use. The
rendered report is trusted host output; the worker narrative is displayed
separately and labeled untrusted. Values are bounded and masked before they
reach a durable record, and URLs keep only origin and path.

## Non-goals kept out of this slice

Per-action approval after the task starts, standing or scheduled mandates,
messaging, connection requests, endorsements, job applications, account or
content deletion, security changes, payments, ads, premium purchases, OAuth
consent, terms acceptance, CAPTCHA solving, fingerprint spoofing, stealth
plugins, rate-limit/robots/paywall/access-control bypass, browser-profile
backup or export, and parallel jobs on one browser workspace.

## Validation status

Deterministic tests (`npm run test:openshell-agent`) cover mandate
canonicalization, MAC, replay, TTL, budgets, breaker, dual authorization,
origin/surface/class confinement, hard-deny precedence, declared diffs,
registry migration, workspace sharing and isolation, audit generation and
redaction, and the host/controller rulebook parity.

The opt-in fixture harness (`npm run test:openshell-agent:browser-fixture`)
drives the real controller against local fixture pages with Chromium's host
resolver pointed at a local server, so classification, dialogs, refs, declared
diffs, hostile page instructions, sensitive surfaces, uploads, SPA saves, and
pause/resume run against real DOM. It needs `playwright-core` plus Chromium and
is skipped otherwise.

**Not yet validated:** the site-specific path, dialog, and permalink patterns
have not been checked against the live sites, which requires authenticated
operator accounts. They are deliberately conservative — an unmatched path is
read-only and an unmatched dialog refuses edits — so the expected failure mode
is a stopped run with review evidence, not a widened permission. Run
`npm run test:openshell-agent:live` on an operator-owned account to validate one
low-risk field round trip per site before relying on that site, and refine
`site-rules.json` from what it reports.
