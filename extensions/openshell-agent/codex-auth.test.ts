import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexCredentialKeys, readLocalCodexCredentials } from "./codex-auth.ts";

function jwt(account: string, expiry = Date.now() + 60 * 60 * 1000) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expiry / 1000), "https://api.openai.com/auth": { chatgpt_account_id: account } })}.synthetic`;
}

test("Codex auth import returns only the provider credential fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-auth-"));
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify({ ignored: "host-only", tokens: {
    access_token: jwt("account-a"), refresh_token: "refresh-value", account_id: "account-a", id_token: "ignored-id-token",
  } }), { mode: 0o600 });
  const credentials = await readLocalCodexCredentials(path);
  assert.deepEqual(Object.keys(credentials), codexCredentialKeys());
  assert.equal(credentials.CODEX_AUTH_ACCOUNT_ID, "account-a");
});

test("Codex auth import rejects permissive files, stale access tokens, and account mismatch without echoing values", async () => {
  for (const [name, mode, access, account] of [
    ["permissive", 0o644, jwt("account-a"), "account-a"],
    ["expired", 0o600, jwt("account-a", Date.now() - 1000), "account-a"],
    ["mismatch", 0o600, jwt("account-a"), "account-b"],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), `codex-auth-${name}-`));
    const path = join(dir, "auth.json");
    await writeFile(path, JSON.stringify({ tokens: {
      access_token: access, refresh_token: "secret-refresh-canary", account_id: account, id_token: "secret-id-canary",
    } }), { mode: 0o600 });
    await chmod(path, mode);
    await assert.rejects(readLocalCodexCredentials(path), (error: Error) => {
      assert.equal(error.message.includes("secret-refresh-canary"), false);
      assert.equal(error.message.includes("secret-id-canary"), false);
      return true;
    });
  }
});
