/**
 * Credential tests - DESIGN.md acceptance criteria AC-C1, AC-C3, AC-C4, AC-C5.
 *
 * Every value here is synthetic. No test resolves a real credential.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { parseConfig } from "./config.ts";
import {
  ACCOUNT_ID_ENV,
  buildResolverArgv,
  CredentialStore,
  parseFieldOutput,
  Secret,
  TOKEN_ENV,
  type ExecFn,
} from "./credentials.ts";
import { BrowserRunError } from "./errors.ts";
import { SecretRegistry, redact } from "./redact.ts";
import { FIXTURE_ACCOUNT_ID, FIXTURE_TOKEN } from "./test-support.ts";

const PROTON_CONFIG = parseConfig({
  credentials: {
    source: "proton-pass",
    vault: "hub",
    item: "cloudflare",
    accountIdField: "Account ID",
    tokenField: "browser-run-voyager token",
  },
});

function store(exec: ExecFn, env: NodeJS.ProcessEnv = {}, registry = new SecretRegistry()) {
  return { store: new CredentialStore({ exec, env, now: () => 1_000, registry }), registry };
}

test("AC-C4 a Secret never renders its value", () => {
  const secret = new Secret(FIXTURE_TOKEN);
  assert.equal(String(secret), "[redacted]");
  assert.equal(`${secret}`, "[redacted]");
  assert.equal(JSON.stringify({ token: secret }), '{"token":"[redacted]"}');
  assert.equal(inspect(secret), "[redacted]");
  assert.equal(inspect({ token: secret }, { depth: 5 }), "{ token: [redacted] }");
  assert.equal(secret.use((value) => value), FIXTURE_TOKEN);
  assert.equal(secret.length, FIXTURE_TOKEN.length);
});

test("AC-C1 with no environment and no locator, resolution fails without spawning a resolver", async () => {
  let spawned = 0;
  const exec: ExecFn = async () => {
    spawned += 1;
    return { stdout: "", stderr: "", code: 0 };
  };
  const { store: credentials } = store(exec, {});
  await assert.rejects(
    () => credentials.resolve(parseConfig({})),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "not_configured" &&
      error.detail.includes(ACCOUNT_ID_ENV) &&
      error.detail.includes(TOKEN_ENV),
  );
  assert.equal(spawned, 0);
  assert.equal(credentials.getState(), "unconfigured");
});

test("AC-C3 the resolver argv carries only the locator", () => {
  const accountArgv = buildResolverArgv(PROTON_CONFIG.credentials, "Account ID");
  assert.equal(accountArgv.command, "pass-cli");
  assert.deepEqual(accountArgv.args, [
    "item",
    "view",
    "--vault-name",
    "hub",
    "--item-title",
    "cloudflare",
    "--field",
    "Account ID",
    "--output",
    "json",
  ]);
  const joined = [accountArgv.command, ...accountArgv.args].join(" ");
  assert.ok(!joined.includes(FIXTURE_TOKEN));
  assert.ok(!joined.includes(FIXTURE_ACCOUNT_ID));

  const commandConfig = parseConfig({
    credentials: {
      source: "command",
      argv: ["secret-get", "--name", "cloudflare/{field}"],
      accountIdField: "account",
      tokenField: "token",
    },
  });
  const built = buildResolverArgv(commandConfig.credentials, "token");
  assert.deepEqual(built, { command: "secret-get", args: ["--name", "cloudflare/token"] });
});

test("AC-C3 a proton-pass resolution records only locator arguments", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
    const field = args[args.indexOf("--field") + 1];
    const value = field === "Account ID" ? FIXTURE_ACCOUNT_ID : FIXTURE_TOKEN;
    return { stdout: JSON.stringify(value), stderr: "", code: 0 };
  };
  const { store: credentials, registry } = store(exec);
  const resolved = await credentials.resolve(PROTON_CONFIG);

  assert.equal(credentials.getState(), "ready");
  assert.equal(resolved.accountId.use((value) => value), FIXTURE_ACCOUNT_ID);
  assert.equal(resolved.token.use((value) => value), FIXTURE_TOKEN);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const joined = [call.command, ...call.args].join(" ");
    assert.ok(!joined.includes(FIXTURE_TOKEN), "argv must not carry the token");
    assert.ok(!joined.includes(FIXTURE_ACCOUNT_ID), "argv must not carry the account id");
  }
  // Resolved values are registered so redact can scrub them out of error text.
  assert.equal(registry.size, 2);
  assert.equal(redact(`token=${FIXTURE_TOKEN}`, registry), "token=[redacted]");
});

test("a second resolve inside the TTL does not spawn the resolver again", async () => {
  let spawned = 0;
  const exec: ExecFn = async (_command, args) => {
    spawned += 1;
    const field = args[args.indexOf("--field") + 1];
    return {
      stdout: field === "Account ID" ? FIXTURE_ACCOUNT_ID : FIXTURE_TOKEN,
      stderr: "",
      code: 0,
    };
  };
  const { store: credentials } = store(exec);
  await credentials.resolve(PROTON_CONFIG);
  await credentials.resolve(PROTON_CONFIG);
  assert.equal(spawned, 2, "one call per field, not per resolve");
  assert.equal(credentials.isFresh(), true);
});

test("environment credentials resolve without any subprocess", async () => {
  let spawned = 0;
  const exec: ExecFn = async () => {
    spawned += 1;
    return { stdout: "", stderr: "", code: 0 };
  };
  const { store: credentials } = store(exec, {
    [ACCOUNT_ID_ENV]: ` ${FIXTURE_ACCOUNT_ID} `,
    [TOKEN_ENV]: FIXTURE_TOKEN,
  });
  const resolved = await credentials.resolve(parseConfig({}));
  assert.equal(spawned, 0);
  assert.equal(resolved.accountId.use((value) => value), FIXTURE_ACCOUNT_ID);
});

test("AC-C5 markRejected drops the cache and reports the rejected state", async () => {
  const exec: ExecFn = async (_command, args) => {
    const field = args[args.indexOf("--field") + 1];
    return {
      stdout: field === "Account ID" ? FIXTURE_ACCOUNT_ID : FIXTURE_TOKEN,
      stderr: "",
      code: 0,
    };
  };
  const { store: credentials } = store(exec);
  await credentials.resolve(PROTON_CONFIG);
  credentials.markRejected();
  assert.equal(credentials.getState(), "rejected");
  assert.equal(credentials.isFresh(), false);
});

test("a resolver failure reports stderr only, never stdout", async () => {
  const exec: ExecFn = async () => ({
    stdout: FIXTURE_TOKEN,
    stderr: `vault is locked\nsecond line ${FIXTURE_TOKEN}`,
    code: 3,
  });
  const { store: credentials } = store(exec);
  await assert.rejects(
    () => credentials.resolve(PROTON_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRunError);
      assert.equal(error.errorClass, "credentials_unavailable");
      assert.match(error.detail, /exited 3 reading field "Account ID": vault is locked/);
      assert.ok(!error.message.includes(FIXTURE_TOKEN), "stdout must not appear in the message");
      return true;
    },
  );
  assert.equal(credentials.getState(), "unavailable");
});

test("a missing resolver binary is reported as a missing tool", async () => {
  const exec: ExecFn = async () => {
    throw new Error("spawn pass-cli ENOENT");
  };
  const { store: credentials } = store(exec);
  await assert.rejects(
    () => credentials.resolve(PROTON_CONFIG),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "credentials_unavailable" &&
      /pass-cli is not installed or not on PATH/.test(error.detail),
  );
});

test("describe reports configuration shape without resolving anything", () => {
  let spawned = 0;
  const exec: ExecFn = async () => {
    spawned += 1;
    return { stdout: "", stderr: "", code: 0 };
  };
  const { store: envStore } = store(exec, {});
  const unset = envStore.describe(parseConfig({}));
  assert.equal(unset.configured, false);
  assert.match(unset.how, /not set/);

  const { store: locatorStore } = store(exec, {});
  const located = locatorStore.describe(PROTON_CONFIG);
  assert.equal(located.configured, true);
  assert.match(located.how, /Proton Pass vault "hub", item "cloudflare"/);
  assert.equal(spawned, 0);
});

test("field output parsing accepts the shapes a field read can take", () => {
  assert.equal(parseFieldOutput(JSON.stringify(FIXTURE_TOKEN), "token"), FIXTURE_TOKEN);
  assert.equal(parseFieldOutput(`  ${FIXTURE_TOKEN}  `, "token"), FIXTURE_TOKEN);
  assert.equal(parseFieldOutput(JSON.stringify({ value: FIXTURE_TOKEN }), "token"), FIXTURE_TOKEN);
  assert.equal(parseFieldOutput(JSON.stringify({ content: FIXTURE_TOKEN }), "token"), FIXTURE_TOKEN);
  assert.equal(parseFieldOutput(JSON.stringify({ other: FIXTURE_TOKEN }), "token"), FIXTURE_TOKEN);
  assert.equal(parseFieldOutput(`token: ${FIXTURE_TOKEN}`, "token"), FIXTURE_TOKEN);
  assert.equal(parseFieldOutput("Account ID: abc123def456", "Account ID"), "abc123def456");

  assert.throws(() => parseFieldOutput("   ", "token"), /resolved to an empty value/);
  assert.throws(() => parseFieldOutput('["a","b"]', "token"), /returned a list/);
  assert.throws(() => parseFieldOutput('{"a":"x","b":"y"}', "token"), /no single value/);
  assert.throws(() => parseFieldOutput("line one\nline two", "token"), /returned 2 lines/);
});
