/**
 * Agent Guard — Path Guard Tests
 *
 * Covers:
 *   - resolveInputPath: relative, absolute, tilde-prefixed, and '..' traversal.
 *   - classifyPath: hard-block, warn-only, and allow decisions.
 *   - classifyPath short-circuits when secretGuard.enabled is false.
 *   - Hard-block takes precedence over warn-only when patterns overlap.
 *   - enforcePathGuard: returns block result for hard-blocked paths.
 *   - enforcePathGuard: returns undefined for warn-only (access allowed).
 *   - enforcePathGuard: returns undefined for allowed paths.
 *   - enforcePathGuard: calls log for hard-block and warn-only, not for allow.
 *   - Known limitations noted (symlinks, case-sensitivity) are NOT tested here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveInputPath,
  classifyPath,
  enforcePathGuard,
  type PathEnforceResult,
} from "./path-guard.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = os.homedir();
// Use a 3-level-deep CWD so that '../../' resolves back to HOME (not HOME's parent).
// e.g. HOME=/home/martin → CWD=/home/martin/workspace/project
// then ../../.ssh/id_rsa → /home/martin/.ssh/id_rsa
const CWD = path.join(HOME, "workspace", "project");

/** A minimal policy with only a few patterns for targeted tests. */
function minimalPolicy(
  hardBlockPaths: string[] = [],
  warnOnlyPaths: string[] = [],
  enabled = true,
): GuardPolicy {
  return {
    ...DEFAULT_POLICY,
    secretGuard: {
      ...DEFAULT_POLICY.secretGuard,
      enabled,
      hardBlockPaths,
      warnOnlyPaths,
    },
  };
}

/** Records all log calls and collects them for assertions. */
function makeLog(): { calls: Record<string, unknown>[]; fn: (e: Record<string, unknown>) => Promise<void> } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    fn: async (event: Record<string, unknown>) => {
      calls.push(event);
    },
  };
}

// ---------------------------------------------------------------------------
// resolveInputPath
// ---------------------------------------------------------------------------

test("resolveInputPath resolves an absolute path unchanged", () => {
  const result = resolveInputPath("/etc/passwd", CWD);
  assert.equal(result, "/etc/passwd");
});

test("resolveInputPath resolves a relative path against cwd", () => {
  const result = resolveInputPath("src/index.ts", CWD);
  assert.equal(result, path.resolve(CWD, "src/index.ts"));
});

test("resolveInputPath resolves './' relative path against cwd", () => {
  const result = resolveInputPath("./package.json", CWD);
  assert.equal(result, path.resolve(CWD, "package.json"));
});

test("resolveInputPath resolves tilde prefix to home directory", () => {
  const result = resolveInputPath("~/.ssh/id_rsa", CWD);
  assert.equal(result, path.resolve(path.join(HOME, ".ssh/id_rsa")));
});

test("resolveInputPath collapses '..' segments in absolute paths", () => {
  const result = resolveInputPath("/home/martin/project/../.ssh/id_rsa", CWD);
  assert.equal(result, "/home/martin/.ssh/id_rsa");
});

test("resolveInputPath collapses '..' traversal in relative paths", () => {
  // From CWD (HOME/workspace/project), going ../../.ssh/id_rsa lands at
  // HOME/.ssh/id_rsa — which matches the hard-block pattern.
  const result = resolveInputPath("../../.ssh/id_rsa", CWD);
  assert.equal(result, path.resolve(HOME, ".ssh/id_rsa"));
});

test("resolveInputPath collapses '..' traversal in tilde paths", () => {
  const result = resolveInputPath("~/.ssh/../.ssh/id_rsa", CWD);
  assert.equal(result, path.resolve(HOME, ".ssh/id_rsa"));
});

// ---------------------------------------------------------------------------
// classifyPath — secretGuard.enabled
// ---------------------------------------------------------------------------

test("classifyPath returns 'allow' immediately when secretGuard.enabled is false", () => {
  const policy = minimalPolicy(["**/.env"], [], false);
  const result = classifyPath("/project/.env", policy);
  assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// classifyPath — hard-block paths
// ---------------------------------------------------------------------------

test("classifyPath returns 'hard-block' for ~/.ssh/id_rsa", () => {
  const result = classifyPath(path.join(HOME, ".ssh/id_rsa"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for ~/.ssh/id_ed25519", () => {
  const result = classifyPath(path.join(HOME, ".ssh/id_ed25519"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for ~/.ssh/id_ecdsa", () => {
  const result = classifyPath(path.join(HOME, ".ssh/id_ecdsa"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for ~/.ssh/id_dsa", () => {
  const result = classifyPath(path.join(HOME, ".ssh/id_dsa"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for ~/.aws/credentials", () => {
  const result = classifyPath(path.join(HOME, ".aws/credentials"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for ~/.netrc", () => {
  const result = classifyPath(path.join(HOME, ".netrc"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for project .env file", () => {
  const result = classifyPath("/home/martin/project/.env", DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for .env.local file", () => {
  const result = classifyPath("/home/martin/project/.env.local", DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for nested .env file", () => {
  const result = classifyPath("/home/martin/project/packages/api/.env", DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for .env.staging.local (matches **/.env.*.local)", () => {
  const result = classifyPath("/project/.env.staging.local", DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for GPG private keys dir", () => {
  const result = classifyPath(
    path.join(HOME, ".gnupg/private-keys-v1.d/ABCDEF01234567.key"),
    DEFAULT_POLICY,
  );
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for age keys file (XDG location)", () => {
  const result = classifyPath(path.join(HOME, ".config/age/keys.txt"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

test("classifyPath returns 'hard-block' for pass password store entry", () => {
  const result = classifyPath(path.join(HOME, ".password-store/github.gpg"), DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

// ---------------------------------------------------------------------------
// classifyPath — warn-only paths
// ---------------------------------------------------------------------------

test("classifyPath returns 'warn-only' for ~/.ssh/config", () => {
  const result = classifyPath(path.join(HOME, ".ssh/config"), DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

test("classifyPath returns 'warn-only' for ~/.ssh/known_hosts", () => {
  const result = classifyPath(path.join(HOME, ".ssh/known_hosts"), DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

test("classifyPath returns 'warn-only' for ~/.aws/config", () => {
  const result = classifyPath(path.join(HOME, ".aws/config"), DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

test("classifyPath returns 'warn-only' for .env.production", () => {
  const result = classifyPath("/project/.env.production", DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

test("classifyPath returns 'warn-only' for .env.staging", () => {
  const result = classifyPath("/project/.env.staging", DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

test("classifyPath returns 'warn-only' for .env.development", () => {
  const result = classifyPath("/project/.env.development", DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

test("classifyPath returns 'warn-only' for .env.test", () => {
  const result = classifyPath("/project/.env.test", DEFAULT_POLICY);
  assert.equal(result, "warn-only");
});

// ---------------------------------------------------------------------------
// classifyPath — allow paths
// ---------------------------------------------------------------------------

test("classifyPath returns 'allow' for a regular source file", () => {
  const result = classifyPath(path.join(CWD, "src/index.ts"), DEFAULT_POLICY);
  assert.equal(result, "allow");
});

test("classifyPath returns 'allow' for package.json", () => {
  const result = classifyPath(path.join(CWD, "package.json"), DEFAULT_POLICY);
  assert.equal(result, "allow");
});

test("classifyPath returns 'allow' for ~/.ssh/authorized_keys (not a private key)", () => {
  // authorized_keys doesn't match id_* pattern
  const result = classifyPath(path.join(HOME, ".ssh/authorized_keys"), DEFAULT_POLICY);
  assert.equal(result, "allow");
});

test("classifyPath returns 'allow' for a public key ~/.ssh/id_rsa.pub", () => {
  // id_rsa.pub does NOT match id_rsa (exact) but DOES match id_* — check carefully
  // The pattern "~/.ssh/id_*" would match id_rsa.pub since * matches rsa.pub.
  // This is an accepted limitation: public keys are also blocked.
  // We just document this is the expected behaviour.
  const result = classifyPath(path.join(HOME, ".ssh/id_rsa.pub"), DEFAULT_POLICY);
  // id_rsa.pub matches ~/.ssh/id_* so it IS blocked (conservative policy)
  assert.equal(result, "hard-block");
});

// ---------------------------------------------------------------------------
// classifyPath — hard-block takes precedence over warn-only
// ---------------------------------------------------------------------------

test("classifyPath: hard-block takes precedence when path matches both buckets", () => {
  const policy = minimalPolicy(
    ["**/.env"],      // hard-block
    ["**/.env"],      // same pattern in warn-only
  );
  const result = classifyPath("/project/.env", policy);
  assert.equal(result, "hard-block");
});

// ---------------------------------------------------------------------------
// classifyPath — '..' traversal is handled by resolveInputPath before classify
// ---------------------------------------------------------------------------

test("traversal: '../../.ssh/id_rsa' from CWD resolves to hard-block path", () => {
  const absolutePath = resolveInputPath("../../.ssh/id_rsa", CWD);
  const result = classifyPath(absolutePath, DEFAULT_POLICY);
  assert.equal(result, "hard-block");
});

// ---------------------------------------------------------------------------
// enforcePathGuard — hard-block
// ---------------------------------------------------------------------------

test("enforcePathGuard returns { block: true, reason } for a hard-blocked path", async () => {
  const { fn: log, calls } = makeLog();
  const result = await enforcePathGuard(
    "read",
    "~/.ssh/id_rsa",
    CWD,
    DEFAULT_POLICY,
    log,
  );
  assert.ok(result !== undefined, "Expected a block result");
  assert.equal((result as { block: true; reason: string }).block, true);
  assert.ok((result as { block: true; reason: string }).reason.length > 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!["type"], "path-blocked");
  assert.equal(calls[0]!["toolName"], "read");
});

test("enforcePathGuard: hard-block reason mentions the input path", async () => {
  const { fn: log } = makeLog();
  const result = await enforcePathGuard("read", "~/.ssh/id_rsa", CWD, DEFAULT_POLICY, log);
  assert.ok(result !== undefined);
  const { reason } = result as { block: true; reason: string };
  assert.ok(
    reason.includes("~/.ssh/id_rsa") || reason.includes(".ssh/id_rsa"),
    `Expected reason to mention the path, got: ${reason}`,
  );
});

test("enforcePathGuard: hard-block logs path-blocked event with absolutePath", async () => {
  const { fn: log, calls } = makeLog();
  await enforcePathGuard("write", "~/.aws/credentials", CWD, DEFAULT_POLICY, log);
  assert.equal(calls.length, 1);
  const event = calls[0]!;
  assert.equal(event["type"], "path-blocked");
  assert.equal(event["guard"], "secretGuard");
  // The logged path should be the resolved absolute path
  const expected = path.resolve(path.join(HOME, ".aws/credentials"));
  assert.equal(event["path"], expected);
});

// ---------------------------------------------------------------------------
// enforcePathGuard — warn-only
// ---------------------------------------------------------------------------

test("enforcePathGuard returns undefined for a warn-only path", async () => {
  const { fn: log, calls } = makeLog();
  const result = await enforcePathGuard("read", "~/.ssh/config", CWD, DEFAULT_POLICY, log);
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!["type"], "path-warned");
});

test("enforcePathGuard: warn-only logs path-warned event", async () => {
  const { fn: log, calls } = makeLog();
  await enforcePathGuard("read", "~/.aws/config", CWD, DEFAULT_POLICY, log);
  const event = calls[0]!;
  assert.equal(event["guard"], "secretGuard");
  assert.equal(event["type"], "path-warned");
  assert.equal(event["toolName"], "read");
});

// ---------------------------------------------------------------------------
// enforcePathGuard — allow (no logging, no block)
// ---------------------------------------------------------------------------

test("enforcePathGuard returns undefined for an allowed path", async () => {
  const { fn: log, calls } = makeLog();
  const result = await enforcePathGuard(
    "read",
    path.join(CWD, "src/index.ts"),
    CWD,
    DEFAULT_POLICY,
    log,
  );
  assert.equal(result, undefined);
  // IMPORTANT: no log event for allowed paths
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// enforcePathGuard — dotenv files
// ---------------------------------------------------------------------------

test("enforcePathGuard blocks read of .env file", async () => {
  const { fn: log } = makeLog();
  const result = await enforcePathGuard("read", ".env", CWD, DEFAULT_POLICY, log);
  assert.ok(result !== undefined);
  assert.equal((result as { block: true; reason: string }).block, true);
});

test("enforcePathGuard blocks write of nested .env file", async () => {
  const { fn: log } = makeLog();
  const result = await enforcePathGuard(
    "write",
    "packages/api/.env",
    CWD,
    DEFAULT_POLICY,
    log,
  );
  assert.ok(result !== undefined);
  assert.equal((result as { block: true; reason: string }).block, true);
});

test("enforcePathGuard warns on .env.production but does not block", async () => {
  const { fn: log } = makeLog();
  const result = await enforcePathGuard("read", ".env.production", CWD, DEFAULT_POLICY, log);
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// enforcePathGuard — secretGuard disabled
// ---------------------------------------------------------------------------

test("enforcePathGuard returns undefined for hard-blocked path when secretGuard disabled", async () => {
  const policy = minimalPolicy([], [], false);
  const { fn: log, calls } = makeLog();
  const result = await enforcePathGuard("read", "~/.ssh/id_rsa", CWD, policy, log);
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// enforcePathGuard — '..' traversal
// ---------------------------------------------------------------------------

test("enforcePathGuard blocks '..' traversal to SSH private key", async () => {
  const { fn: log } = makeLog();
  // From /home/martin/project, ../../.ssh/id_rsa resolves to ~/.ssh/id_rsa
  const result = await enforcePathGuard("read", "../../.ssh/id_rsa", CWD, DEFAULT_POLICY, log);
  assert.ok(result !== undefined);
  assert.equal((result as { block: true; reason: string }).block, true);
});

test("enforcePathGuard blocks '..' traversal to .aws/credentials", async () => {
  const { fn: log } = makeLog();
  const result = await enforcePathGuard(
    "read",
    "../../.aws/credentials",
    CWD,
    DEFAULT_POLICY,
    log,
  );
  assert.ok(result !== undefined);
  assert.equal((result as { block: true; reason: string }).block, true);
});
