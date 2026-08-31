/**
 * Opt-in live integration test - DESIGN.md acceptance criterion AC-L4.
 *
 * This never runs in ordinary validation. It is skipped unless
 * `PI_BROWSER_RUN_LIVE=1`, so `npm run test:cloudflare-browser-run` and CI stay
 * offline and free.
 *
 * To run it:
 *
 *   1. Unlock Proton Pass, or export the credentials directly:
 *        export CLOUDFLARE_ACCOUNT_ID=...          # never echo these
 *        export CLOUDFLARE_BROWSER_RUN_TOKEN=...   # needs Browser Rendering - Edit
 *   2. Resolve them into the environment without printing them, for example:
 *        pass-cli run -- env | grep -c CLOUDFLARE   # count only, never values
 *   3. PI_BROWSER_RUN_LIVE=1 npm run test:cloudflare-browser-run
 *
 * Rules this file follows, and any addition to it must follow:
 *
 *   - the target is a synthetic public page, never a real signed-in site. An
 *     authenticated-site run happens only when Martin initiates it by hand;
 *   - every browser session closes in a `finally`, so a failed assertion cannot
 *     leave a Cloudflare session running until its idle timer;
 *   - nothing is printed. No account id, no token, no cookie, no Live View URL,
 *     and no page text. Assertions check shapes and sizes, not content;
 *   - no crawl is started, because a crawl outlives the test and bills for real.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { statePaths } from "./config.ts";
import { CredentialStore } from "./credentials.ts";
import { cdpWebSocketUrl } from "./endpoints.ts";
import { CloudflareClient, defaultSleep } from "./http.ts";
import { loadConfig } from "./config.ts";
import { probeCredentials, fetchMarkdown } from "./quick-actions.ts";
import { SecretRegistry } from "./redact.ts";

const ENABLED = process.env["PI_BROWSER_RUN_LIVE"] === "1";
/** A stable, public, JavaScript-light page owned by the vendor being called. */
const PUBLIC_TARGET = "https://developers.cloudflare.com/browser-rendering/";

test("live Browser Run integration", { skip: ENABLED ? false : "set PI_BROWSER_RUN_LIVE=1 to run" }, async (t) => {
  const registry = new SecretRegistry();
  const store = new CredentialStore({
    exec: async (command, args) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout, stderr } = await run(command, args);
      return { stdout, stderr, code: 0 };
    },
    env: process.env,
    now: () => Date.now(),
    registry,
  });

  const config = await loadConfig(statePaths());
  const credentials = await store.resolve(config);
  const client = new CloudflareClient(
    { fetch: (url, init) => fetch(url, init), now: () => Date.now(), sleep: defaultSleep, registry },
    {},
  );

  await t.test("the health probe exercises a Browser Run capability", async () => {
    const probe = await probeCredentials(client, credentials);
    assert.ok(probe.browserMs === undefined || probe.browserMs >= 0);
  });

  await t.test("a public page renders to bounded Markdown", async () => {
    const result = await fetchMarkdown(client, credentials, { url: PUBLIC_TARGET });
    // Shape and size only. The page text is never printed or asserted on.
    assert.equal(typeof result.markdown, "string");
    assert.ok(result.markdown.length > 0);
  });

  await t.test("a CDP session opens, navigates, and closes", async () => {
    const { chromium } = await import("playwright-core");
    const endpoint = credentials.accountId.use((id) =>
      cdpWebSocketUrl(id, config.browser.keepAliveMs),
    );
    const browser = await credentials.token.use((token) =>
      chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${token}` } }),
    );
    try {
      const context = await browser.newContext({ viewport: config.browser.viewport });
      try {
        const page = await context.newPage();
        await page.goto(PUBLIC_TARGET, { waitUntil: "domcontentloaded" });
        const snapshot = await page.ariaSnapshot({ mode: "ai" });
        assert.match(snapshot, /\[ref=e\d+\]/, "the ai snapshot mode emits refs");
        assert.equal(typeof (await page.title()), "string");
      } finally {
        await context.close();
      }
    } finally {
      // Always release the Cloudflare session rather than waiting for its idle timer.
      await browser.close();
    }
  });
});
