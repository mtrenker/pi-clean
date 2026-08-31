# Cloudflare Browser Run

A Pi extension for two kinds of web work that Pi otherwise cannot do:

1. **Attended browsing on signed-in sites.** Pi drives navigation, extraction, comparison, and form
   preparation through Playwright over Cloudflare's Chrome DevTools Protocol endpoint. You complete
   login, CAPTCHA, MFA, and any sensitive data entry yourself through Cloudflare Live View.
2. **Fire-and-forget public crawls.** Pi starts a Cloudflare `/crawl` job, exits, and a later Pi
   session finds the job again, pages through its results, and cancels it if needed.

The extension is site agnostic. No hostname, selector, or workflow for any particular website
appears in the code; a site's origins are configuration you write, not logic the extension carries.

[DESIGN.md](DESIGN.md) is the architecture and threat-boundary record. Read it before changing how
credentials, profiles, or Live View behave.

## Which tool for which job

| Task | Use | Why |
| --- | --- | --- |
| Read one public page | `browser_read` | One request, no session, bounded Markdown |
| Read a whole public documentation site | `browser_crawl_start` | Cloudflare crawls it after Pi exits; results keep for 14 days |
| Anything behind a login | `/browser-login` then `browser_open` with a profile | `/crawl` cannot hold a session, and this extension never sends credentials to a stateless endpoint |
| Multi-step interaction on one page | `browser_open` and the interaction tools | Page state has to persist between actions |

Do not point `browser_crawl_start` at a signed-in site. The crawl endpoint identifies itself as
`CloudflareBrowserRenderingCrawler/1.0`, respects robots.txt, and has no session to authenticate
with. Authenticated work goes through a profile-backed browser session.

## Setup

### 1. Get a token

Create a Cloudflare API token with the **Browser Rendering - Edit** permission. Note your account
id. Cloudflare's generic `/user/tokens/verify` endpoint answers 401 for a working Browser Run
token, so use `/browser check` to verify it rather than that endpoint.

### 2. Tell the extension where the credentials live

Preferred: write a locator, never a value, to `~/.pi/agent/cloudflare-browser-run/config.json`:

```jsonc
{
  "credentials": {
    "source": "proton-pass",
    "vault": "hub",
    "item": "cloudflare",
    "accountIdField": "Account ID",
    "tokenField": "browser-run token"
  }
}
```

`source: "command"` takes an `argv` array containing a `{field}` placeholder, for any other secret
manager. Credential configuration is user scoped only; a project cannot supply one.

The alternative is exporting them:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_BROWSER_RUN_TOKEN=...
```

This works and is supported, but understand what it costs. Pi's environment is inherited by every
child process, including the `bash` tool the model can call, so an exported token is readable by any
shell command the model runs. The extension never writes credentials into the environment, and it
cannot take them back out of one: by the time it reads them they are already there. `/browser`
status says so when this is the active source. Use it for CI and the opt-in live test; use a locator
for ordinary work.

Nothing is resolved until the first call that needs a token. Opening Pi never unlocks your vault,
and `/browser` reports configuration shape without touching the secret store. Run `/browser check`
when you want an explicit verification.

### 3. Check it

```text
/browser          # configuration, browser state, profiles, activity log path
/browser check    # one real Browser Run call to confirm the token works
```

## Commands

| Command | What it does |
| --- | --- |
| `/browser [status]` | Configuration, credential state, browser state, action budget, profile names |
| `/browser check` | Verifies the token against a real Browser Run capability |
| `/browser close` | Closes an open browser session |
| `/browser-login <profile>` | Attended sign-in through Live View; saves encrypted, filtered state |
| `/browser-profiles list \| status <name> \| delete <name>` | Inspect and destroy saved profiles |
| `/browser-crawls list \| refresh \| show <id> \| cancel <id> \| forget <id>` | Crawls across sessions |

## Tools

Three are always available: `browser_read`, `browser_open`, and `browser_crawl_start`. The rest
appear when they become usable, so a session that never browses does not carry fifteen tool schemas.

| Tool | Notes |
| --- | --- |
| `browser_read` | One public page to Markdown. Bounded to 24KB and 800 lines |
| `browser_open` | Opens the session, optionally restores a profile, activates the interaction tools |
| `browser_navigate` | URL, back, forward, or reload |
| `browser_snapshot` | Accessibility snapshot with the `[ref=eN]` markers the action tools take |
| `browser_click`, `browser_fill`, `browser_select`, `browser_press` | Act on one ref |
| `browser_screenshot` | Explicit only, one bounded image per call |
| `browser_tabs` | list, new, select, close |
| `browser_close` | Releases the Cloudflare session |
| `browser_crawl_start`, `_status`, `_results`, `_cancel` | Asynchronous crawls |

Every acting tool returns short page orientation rather than a full snapshot: the settled URL, the
title, whether navigation happened, and the nearby interactive elements. Ask for
`browser_snapshot` when you need the whole page.

## Authenticated profiles

A profile is a name, a list of exact origins, and encrypted browser state for those origins.

```text
/browser-login freelance-example
```

The flow:

1. If the profile is new, you are asked for its origins and they are written to `config.json`.
2. A fresh isolated browser context opens on the first origin.
3. Your browser opens a **local** link that redirects once to the Cloudflare Live View session.
4. You sign in, complete MFA, dismiss consent dialogs, then choose **Done** in the Cloudflare
   toolbar. Choose **Failed** to abandon without saving.
5. The extension filters the resulting storage state to the allowed origins, encrypts it, and
   reports counts only.

While you hold the session, Pi cannot act on the page, cannot snapshot it, and cannot screenshot
it. That is enforced by the action queue, not by prompt guidance.

Later, `browser_open` with `profile: "freelance-example"` restores it. If the profile is missing,
expired, or unreadable the call fails rather than opening an anonymous session, because a model
that believes it is signed in and is not will misread every page that follows.

### Where the state lives

```text
~/.pi/agent/cloudflare-browser-run/
  config.json                  operator-editable, non-secret
  profiles/<name>.sealed       AES-256-GCM ciphertext of the filtered state
  profiles/<name>.meta.json    counts and dates, never cookie names or values
  crawls/<jobId>/record.json   durable non-secret crawl metadata, one file per job
  crawls/<jobId>/page-*.json   cached result pages
  activity.jsonl               rotating activity log
```

Everything is mode 0600 inside a 0700 directory, outside any repository, and every write goes
through a temporary file and a rename so a crash cannot truncate one. A file that cannot be read is
reported with its path rather than treated as absent, so a permission problem never looks like an
empty registry or a missing profile. A crawl record that cannot be read is named in
`/browser-crawls list` and at session start, and it blocks new crawls until you fix or remove it,
because a count that skipped it would let a corrupt file past the daily cap. The same applies to a
legacy crawl index that cannot be migrated: it is left exactly where it is, reported, and it blocks
new crawls, rather than being moved aside with its jobs still inside it.

### Key backends

The data key that seals a profile is wrapped by the first backend that is available, with no silent
downgrade to something weaker:

1. **OS keyring** through `secret-tool` (libsecret). Default when it is installed.
2. **Secret manager**, a command whose stdout is a base64 master key, configured as
   `profileVault: { "backend": "secret-manager", "command": "...", "args": [...] }`. Works headless.
3. **`PI_BROWSER_RUN_PROFILE_KEY`**, a base64 master key in the environment, for the live test.

A locked keyring is an error naming the keyring, not a quiet fall-through. Backends 2 and 3 derive
each profile's key from one master key with HKDF, which is what makes them work without a prompt,
and which is why `delete` on those backends says the master key must be rotated instead of
pretending it destroyed one profile's key.

## Security boundaries

These are enforced in code:

- **The model never types a credential.** `browser_fill` refuses password fields, checked against
  the resolved element rather than the snapshot text. There is no secret-fill tool.
- **No page JavaScript.** There is no evaluate tool, which removes the most direct route from
  injected page text to arbitrary effects.
- **No uploads and no downloads.** No local file can reach a page and no page byte can reach disk
  through a tool.
- **Navigation confinement.** A profile-backed session refuses to navigate outside the profile's
  origins by default. The origin check runs before DNS, so an out-of-scope host is never resolved.
- **Page-driven navigation is checked after the fact.** A click or a submitted form decides where it
  goes, so every action that can navigate ends by checking where the page landed. A prohibited
  target, or an origin outside the profile, means the page's content is not returned. This is
  detection, not prevention: the request has already left Cloudflare's network.
- **The sign-in browser is closed when login ends.** `/browser-login` runs in its own fresh context
  and tears it down whether you finish or abandon, so an authenticated context is never left
  reachable as an ordinary anonymous session. Reopen it with `browser_open` and the profile name.
- **The Live View URL never reaches the model.** It carries a JWT, so it goes into a one-shot
  loopback redirector; your browser opens `http://127.0.0.1:<port>/<nonce>`, valid for one request
  and two minutes. The JWT URL is never written to disk, never logged, and never placed in a
  process argument list.
- **Credentials stay out of the environment.** Nothing is written to `process.env`, which every
  bash command Pi runs would otherwise inherit.
- **URL validation.** Only http and https; no userinfo; loopback, private, carrier-grade NAT,
  link-local, unique-local, multicast, and reserved ranges rejected, including obfuscated and
  IPv4-mapped forms; every DNS answer checked, not only the first.
- **Action budget.** A session stops after `maxActionsPerSession` actions, default 200.
- **Optional click confirmation.** `confirmClicks: "always"` asks before every click, inside the
  action queue, and the prompt's page URL is sanitized like any other page text. If the action times
  out or the turn is aborted while you are deciding, a later yes does not click: you were already
  told it failed. There is no "confirm the risky ones" setting, because a heuristic that guesses
  which clicks mutate cannot be made honest.

These are not:

- **Prompt injection is reduced, not solved.** Page text is sanitized, wrapped in an
  `<untrusted-page-content>` envelope it cannot close early, and bounded. A page can still address
  the model. What bounds the damage is the capability list above, not the wrapper.
- **Redaction is exact-match, not clairvoyant.** Resolved credentials and restored cookie values are
  removed from anything the extension emits, and so are JWT and bearer patterns. A secret this
  extension never resolved, or one a page paraphrases rather than repeats, is not detectable. Values
  shorter than eight characters are not registered at all, because redacting a string that short
  would replace it everywhere it occurs in every page; a site whose session token is that short is
  outside what this mechanism can protect.
- **"It will not apply for a job" is workflow guidance.** A generic browser cannot tell a mutating
  click from a harmless one: a link can POST, and a single-page application routes both through the
  same event. This extension does not claim a gate it cannot enforce.
- **Cookie scope is wider than the allowlist.** Filtering bounds what is *stored*. A retained
  `.example.com` cookie is still sent by Chrome to every `*.example.com` host the context visits.
  `/browser-profiles status` says when a profile carries domain-wide cookies. Navigation
  confinement is the control that actually limits where they go.
- **The URL guard does not protect your LAN.** The browser runs on Cloudflare's network, so
  `127.0.0.1` there is a Cloudflare container, not your machine. The guard stops the model probing
  Cloudflare's internals, keeps credential-bearing URLs out of durable tool arguments, and turns an
  accidental `http://localhost:3000` into a clear rejection.
- **Deletion destroys the key, not the bytes.** On a copy-on-write or journaling filesystem,
  overwriting a file does not reliably erase the old blocks. `delete` destroys the wrapping key
  first, which is the guarantee that holds, and leaves the ciphertext if that fails.
- **Screenshots are durable.** Images are stored in the Pi session file as base64. With a profile
  active you are asked before each one (`screenshotsWithProfile`, default `ask`), and refused
  outright when there is no operator to ask.

## Bot policy

Browser Run traffic is always identified as bot traffic by Cloudflare and sends `cf-biso-request-id`
and `cf-biso-devtools` headers. Sites may block it, and their terms may prohibit automation
regardless. This extension makes no attempt to evade detection, does not rotate outbound IPs
(Cloudflare does not offer it), and does not bypass robots.txt, Content Signals, CAPTCHA, or bot
controls. Whether a given site works is something to find out by hand before building on it.

## Cost, limits, and retention

Cloudflare's published limits at the time of writing:

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Browser time | 10 minutes per day | usage-based, no cap |
| Concurrent browsers | 3 | 200 |
| Quick Action requests | 1 per 10 seconds | 30 per second |
| Crawl jobs | 5 per day, 100 pages each | standard pricing |
| Browser idle timeout | 60 seconds, extendable to 10 minutes with `keep_alive` | same |

The extension assumes Workers Paid and detects the free plan reactively through 429 and quota
errors rather than asking Cloudflare. Its own defaults stay conservative anyway: 2 requests per
second, one browser session at a time, and crawls capped at 25 pages and depth 2 with rendering off.

Crawl behaviour worth knowing:

- `render: false` is currently unmetered during Cloudflare's beta; rendered crawls are billed and
  need `allowRenderedCrawl: true` before the extension will request one.
- Cloudflare keeps completed crawl results for 14 days. The extension ages out its own records and
  cached pages on the same schedule.
- Cancelling stops further work. It does not refund browser time already billed.
- `X-Browser-Ms-Used` and `browserSecondsUsed` are recorded, so `/browser-crawls show` reports what
  a job actually cost rather than an estimate.

### Content Signals

The extension declares `crawlPurposes: ["ai-input"]` by default, narrower than Cloudflare's
`["search", "ai-input", "ai-train"]`. That is what actually happens to the content: crawled pages
are read into a model's context to answer a question. Nothing here builds a search index, so
`search` is opt-in, and nothing trains a model, so `ai-train` is rejected by configuration
validation with that reason.

Purposes come from configuration, never from tool arguments, and a site that refuses a declared
purpose produces a `content_signals_declined` error that is never retried with a narrower purpose.
Narrowing a declaration to get past a refusal would turn the site's answer into a negotiation it
never agreed to have.

## Recovery

| Symptom | What it means | What to do |
| --- | --- | --- |
| `not_configured` | No credentials and no locator | `/browser` prints the setup steps |
| `credentials_unavailable` | Vault or keyring locked, or `pass-cli` missing | Unlock it and retry |
| `credentials_rejected` | Cloudflare answered 401 or 403 | Check the Browser Rendering - Edit permission, rotate the token |
| `session_expired` | Cloudflare closed the idle session, or an action timed out | `browser_open` again; the profile is restored |
| `no_session` | The interaction tools are listed but nothing is open | `browser_open` |
| `busy_handoff` | You are signing in | Finish or cancel the handoff |
| `busy_queue` | Too many parallel browser actions | Retry after the batch |
| `profile_expired` / `profile_unreadable` | Stored state is stale, no longer matches the profile's origins, or the key is gone | `/browser-login <name>` |
| `target_rejected` | The URL guard refused it | The message names the rule |
| `content_signals_declined` | The site refuses the declared crawl purpose | Read what you need with `browser_read` |
| `quota_exhausted` | Action budget or daily crawl cap | Reopen the browser, or wait |
| `results_expired` | Past Cloudflare's 14 day retention | Start a new crawl |

The browser closes on `browser_close`, on `/browser close`, on `/reload`, on `/new`, `/resume`, and
`/fork`, and on exit. There is no silent reconnect after expiry, because reconnecting would lose
page state and could resubmit a form the model believes it already submitted.

## Activity log

`~/.pi/agent/cloudflare-browser-run/activity.jsonl`, rotating at 5MB keeping 3 files. It records
what happened, how long it took, the error class, byte counts, and billed browser milliseconds. It
records a URL as origin plus path with the query removed, and as origin alone when a profile is
active. It never records tokens, account ids, Live View URLs, cookies, local storage, page text,
screenshots, or form values.

```bash
tail -f ~/.pi/agent/cloudflare-browser-run/activity.jsonl
jq 'select(.errorClass)' ~/.pi/agent/cloudflare-browser-run/activity.jsonl
```

## Configuration reference

```jsonc
{
  "credentials": { "source": "env" },
  "browser": {
    "keepAliveMs": 600000,           // Cloudflare's documented maximum
    "actionTimeoutMs": 30000,
    "queueDepth": 4,
    "maxActionsPerSession": 200,
    "confirmClicks": "never",        // "never" | "always"
    "screenshotsWithProfile": "ask", // "ask" | "never" | "always"
    "viewport": { "width": 1280, "height": 800 }
  },
  "profiles": {
    "example-site": {
      "origins": ["https://www.example.com"],
      "allowNavigationOutsideProfile": false
    }
  },
  "profileVault": { "backend": "auto" },
  "crawl": {
    "crawlPurposes": ["ai-input"],
    "defaultLimit": 25,
    "maxLimit": 500,
    "defaultDepth": 2,
    "allowRenderedCrawl": false,
    "maxJobsPerDay": 10,
    "resultCacheDays": 14
  },
  "logging": { "enabled": true, "maxBytes": 5242880, "keep": 3 }
}
```

An unknown key is rejected with its name rather than ignored, because a typo that silently disables
a bound is worse than a startup error.

## Development

```bash
npm run test:cloudflare-browser-run
npm run test:extensions
npx tsc --noEmit
```

The unit tests use doubles throughout. None resolves a real credential, contacts Cloudflare, opens
a browser, or writes a real profile, and every fixture token is synthetic.

### Opt-in live test

`live.test.ts` skips unless `PI_BROWSER_RUN_LIVE=1`. It calls the real account, so run it
deliberately:

```bash
PI_BROWSER_RUN_LIVE=1 npm run test:cloudflare-browser-run
```

It uses a public Cloudflare documentation page as its target, closes every browser session in a
`finally`, starts no crawl, and prints no account id, token, cookie, Live View URL, or page text.
An authenticated-site run is a manual exercise you start yourself, not something this file does.

## Known limitations

- One browser session per Pi session. Opening a second profile requires closing the first.
- No page JavaScript evaluation, no file upload or download, and no session recording.
- Origin allowlists are exact. No wildcards and no subdomain expansion in this slice.
- Stored state covers cookies and local storage. IndexedDB is not captured.
- Tool names are not namespaced by Pi, so a second browser extension would collide with `browser_*`.
- A mid-flight redirect cannot be blocked. The settled URL is checked afterwards and reported.
- The per-day crawl cap is serialized within one Pi process. Two Pi processes starting crawls at the
  same instant can exceed it; it is a cost guard, not a security control.
- Cloudflare's REST endpoint for deleting a browser session is not reachable through a
  `connectOverCDP` connection, which never exposes the session id. Closing the browser drops the
  websocket and the idle timer releases the rest.
