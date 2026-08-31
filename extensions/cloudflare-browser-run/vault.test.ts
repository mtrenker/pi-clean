/**
 * Vault tests - DESIGN.md acceptance criteria AC-P4, AC-P6, AC-P7.
 *
 * Every key here is synthetic and every backend is a double. No test touches the
 * real keyring or a real secret manager.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureStateDir, statePaths } from "./config.ts";
import { BrowserRunError } from "./errors.ts";
import {
  createEnvBackend,
  createKeyringBackend,
  createSecretManagerBackend,
  deriveProfileKey,
  KEY_BYTES,
  KEYRING_SERVICE,
  ProfileVault,
  PROFILE_KEY_ENV,
  resolveKeyBackend,
  seal,
  unseal,
  type CommandRunner,
  type RunResult,
} from "./vault.ts";

const KEY = randomBytes(KEY_BYTES);
const MASTER = randomBytes(48).toString("base64");

interface RecordedRun {
  command: string;
  args: string[];
  input?: string;
}

function recordingRunner(
  responses: (call: RecordedRun) => RunResult | Promise<RunResult>,
): { run: CommandRunner; calls: RecordedRun[] } {
  const calls: RecordedRun[] = [];
  return {
    calls,
    run: async (command, args, input) => {
      const call: RecordedRun = { command, args, ...(input === undefined ? {} : { input }) };
      calls.push(call);
      return responses(call);
    },
  };
}

async function scratchPaths(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "cfbr-vault-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const paths = statePaths(dir);
  await ensureStateDir(paths);
  return paths;
}

test("AC-P4 sealed bytes decrypt only with the matching profile name", () => {
  const blob = seal(JSON.stringify({ cookies: [] }), KEY, "example-site");
  assert.equal(unseal(blob, KEY, "example-site"), '{"cookies":[]}');

  assert.throws(
    () => unseal(blob, KEY, "other-site"),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_unreadable" &&
      /could not be decrypted/.test(error.detail),
  );
  assert.throws(() => unseal(blob, randomBytes(KEY_BYTES), "example-site"), /could not be decrypted/);
  assert.throws(
    () => unseal({ ...blob, version: 99 }, KEY, "example-site"),
    /format version 99/,
  );
});

test("sealing never stores the plaintext and uses a fresh nonce each time", () => {
  const plaintext = JSON.stringify({ cookies: [{ name: "session", value: "s3cret" }] });
  const first = seal(plaintext, KEY, "p");
  const second = seal(plaintext, KEY, "p");
  const serialized = JSON.stringify([first, second]);

  assert.ok(!serialized.includes("s3cret"));
  assert.ok(!serialized.includes("session"));
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("derived profile keys are independent and stable", () => {
  const master = Buffer.from(MASTER, "base64");
  const a = deriveProfileKey(master, "site-a");
  const b = deriveProfileKey(master, "site-b");
  assert.equal(a.byteLength, KEY_BYTES);
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, deriveProfileKey(master, "site-a"));
  assert.throws(() => deriveProfileKey(Buffer.alloc(8), "site-a"), /at least 32 bytes/);
});

test("the keyring backend passes the key on stdin, never in argv", async () => {
  const stored: Record<string, string> = {};
  const { run, calls } = recordingRunner((call) => {
    if (call.args[0] === "store") {
      stored[call.args.at(-1) as string] = call.input ?? "";
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call.args[0] === "lookup") {
      const key = stored[call.args.at(-1) as string];
      return key
        ? { stdout: `${key}\n`, stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 1 };
    }
    return { stdout: "", stderr: "", code: 0 };
  });

  const backend = createKeyringBackend(run);
  assert.equal(await backend.get("example-site"), null);
  await backend.set("example-site", KEY);
  assert.deepEqual(await backend.get("example-site"), KEY);

  const storeCall = calls.find((call) => call.args[0] === "store");
  assert.ok(storeCall);
  assert.equal(storeCall.input, KEY.toString("base64"));
  assert.ok(
    !storeCall.args.join(" ").includes(KEY.toString("base64")),
    "the key must not appear in argv",
  );
  assert.deepEqual(storeCall.args.slice(-4), ["service", KEYRING_SERVICE, "profile", "example-site"]);
});

test("AC-P6 a locked keyring is an error, not a downgrade", async () => {
  const { run } = recordingRunner((call) => {
    if (call.args[0] === "--version") return { stdout: "secret-tool 0.21", stderr: "", code: 0 };
    return { stdout: "", stderr: "Cannot create an item in a locked collection", code: 1 };
  });

  const backend = createKeyringBackend(run);
  await assert.rejects(
    () => backend.get("example-site"),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      error.errorClass === "profile_unreadable" &&
      /the OS keyring is unavailable/.test(error.detail) &&
      /locked collection/.test(error.detail),
  );

  // Resolution still selects the keyring rather than quietly choosing something
  // weaker; the failure surfaces at use, naming the keyring.
  const resolved = await resolveKeyBackend({
    preferred: "auto",
    run,
    env: { [PROFILE_KEY_ENV]: MASTER },
  });
  assert.equal(resolved.backend.id, "keyring");
});

test("backend resolution follows the documented order and refuses to guess", async () => {
  const withKeyring = recordingRunner(() => ({ stdout: "", stderr: "", code: 0 })).run;
  const withoutKeyring = recordingRunner(() => ({ stdout: "", stderr: "not found", code: 127 })).run;

  assert.equal(
    (await resolveKeyBackend({ preferred: "auto", run: withKeyring, env: {} })).backend.id,
    "keyring",
  );
  assert.equal(
    (
      await resolveKeyBackend({
        preferred: "auto",
        run: withoutKeyring,
        env: {},
        secretManager: { command: "pass-cli", args: ["item", "view"] },
      })
    ).backend.id,
    "secret-manager",
  );
  assert.equal(
    (
      await resolveKeyBackend({
        preferred: "auto",
        run: withoutKeyring,
        env: { [PROFILE_KEY_ENV]: MASTER },
      })
    ).backend.id,
    "env",
  );

  await assert.rejects(
    () => resolveKeyBackend({ preferred: "auto", run: withoutKeyring, env: {} }),
    (error: unknown) =>
      error instanceof BrowserRunError &&
      /no profile key backend is available/.test(error.detail) &&
      /never stored in plaintext/.test(error.detail),
  );

  await assert.rejects(
    () => resolveKeyBackend({ preferred: "keyring", run: withoutKeyring, env: {} }),
    /secret-tool is not installed/,
  );
  await assert.rejects(
    () => resolveKeyBackend({ preferred: "secret-manager", run: withKeyring, env: {} }),
    /needs profileVault.secretManager/,
  );
});

test("derived backends cannot destroy one profile's key and say so", async () => {
  const env = createEnvBackend({ [PROFILE_KEY_ENV]: MASTER });
  await assert.rejects(() => env.clear("p"), /Rotate the variable/);

  const secretManager = createSecretManagerBackend(
    recordingRunner(() => ({ stdout: MASTER, stderr: "", code: 0 })).run,
    { command: "pass-cli", args: ["item", "view"] },
  );
  await assert.rejects(() => secretManager.clear("p"), /Rotate the master key/);
  assert.deepEqual(
    await secretManager.get("p"),
    deriveProfileKey(Buffer.from(MASTER, "base64"), "p"),
  );
});

test("a vault round-trips through a sealed file with owner-only permissions", async (t) => {
  const paths = await scratchPaths(t);
  const stored: Record<string, string> = {};
  const { run } = recordingRunner((call) => {
    if (call.args[0] === "store") {
      stored[call.args.at(-1) as string] = call.input ?? "";
      return { stdout: "", stderr: "", code: 0 };
    }
    if (call.args[0] === "lookup") {
      const key = stored[call.args.at(-1) as string];
      return key ? { stdout: key, stderr: "", code: 0 } : { stdout: "", stderr: "", code: 1 };
    }
    if (call.args[0] === "clear") {
      delete stored[call.args.at(-1) as string];
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  });

  const vault = new ProfileVault(paths, { backend: createKeyringBackend(run), canMintKeys: true });
  const plaintext = JSON.stringify({ cookies: [{ name: "sid", value: "top-secret" }] });
  await vault.save("example-site", plaintext);

  const onDisk = await readFile(vault.sealedPath("example-site"), "utf8");
  assert.ok(!onDisk.includes("top-secret"));
  assert.ok(!onDisk.includes("sid"));
  assert.equal((await stat(vault.sealedPath("example-site"))).mode & 0o777, 0o600);
  assert.equal(await vault.load("example-site"), plaintext);
});

test("AC-P7 deletion clears the key first and keeps the file when that fails", async (t) => {
  const paths = await scratchPaths(t);
  const order: string[] = [];
  let clearFails = true;
  const { run } = recordingRunner((call) => {
    order.push(call.args[0] as string);
    if (call.args[0] === "lookup") return { stdout: KEY.toString("base64"), stderr: "", code: 0 };
    if (call.args[0] === "clear") {
      return clearFails
        ? { stdout: "", stderr: "dbus error", code: 1 }
        : { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  });

  const vault = new ProfileVault(paths, { backend: createKeyringBackend(run), canMintKeys: true });
  await vault.save("example-site", "{}");

  await assert.rejects(
    () => vault.destroy("example-site"),
    (error: unknown) =>
      error instanceof BrowserRunError && /The sealed file was left in place/.test(error.detail),
  );
  await stat(vault.sealedPath("example-site"));

  clearFails = false;
  order.length = 0;
  await vault.destroy("example-site");
  assert.equal(order[0], "clear", "the key is destroyed before the ciphertext");
  await assert.rejects(() => stat(vault.sealedPath("example-site")), /ENOENT/);
});

test("a vault with a derived backend refuses to mint a key it cannot store", async (t) => {
  const paths = await scratchPaths(t);
  const vault = new ProfileVault(paths, {
    backend: {
      id: "secret-manager",
      describe: () => "double",
      async get() {
        return null;
      },
      async set() {
        return undefined;
      },
      async clear() {
        return undefined;
      },
    },
    canMintKeys: false,
  });
  await assert.rejects(() => vault.save("p", "{}"), /has no key for profile p/);
});

test("loading a profile with no sealed file reports profile_missing", async (t) => {
  const paths = await scratchPaths(t);
  const vault = new ProfileVault(paths, {
    backend: createEnvBackend({ [PROFILE_KEY_ENV]: MASTER }),
    canMintKeys: false,
  });
  await assert.rejects(
    () => vault.load("absent"),
    (error: unknown) => error instanceof BrowserRunError && error.errorClass === "profile_missing",
  );

  await writeFile(vault.sealedPath("corrupt"), "not json", "utf8");
  await assert.rejects(
    () => vault.load("corrupt"),
    (error: unknown) =>
      error instanceof BrowserRunError && error.errorClass === "profile_unreadable",
  );
});
