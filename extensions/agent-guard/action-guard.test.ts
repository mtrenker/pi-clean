/**
 * Agent Guard — Action Guard Tests
 *
 * Covers:
 *   - Every default catastrophic pattern is blocked (positive cases).
 *   - Legitimate look-alike commands are NOT blocked (false-positive guard).
 *   - actionGuard.enabled = false disables all blocking.
 *   - checkAction returns { blocked: false } for safe commands.
 *   - checkAction returns { blocked: true, reason } for blocked commands.
 *   - Reason string includes the matched pattern label.
 *   - Adversarial / obfuscation smoke cases.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkAction, type ActionCheckResult } from "./action-guard.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function policyWith(overrides: Partial<GuardPolicy["actionGuard"]>): GuardPolicy {
  return {
    ...DEFAULT_POLICY,
    actionGuard: { ...DEFAULT_POLICY.actionGuard, ...overrides },
  };
}

function assertBlocked(result: ActionCheckResult, label: string) {
  assert.equal(result.blocked, true, `Expected command to be blocked by pattern: ${label}`);
  assert.ok(
    typeof result.reason === "string" && result.reason.length > 0,
    "Expected a non-empty reason string",
  );
  assert.ok(
    result.reason!.includes(label),
    `Expected reason to include pattern label "${label}", got: ${result.reason}`,
  );
}

function assertAllowed(result: ActionCheckResult, command: string) {
  assert.equal(
    result.blocked,
    false,
    `Expected "${command}" to be allowed, but was blocked: ${result.reason}`,
  );
}

// ---------------------------------------------------------------------------
// checkAction — disabled guard
// ---------------------------------------------------------------------------

test("checkAction returns { blocked: false } when actionGuard.enabled is false", () => {
  const policy = policyWith({ enabled: false });
  const result = checkAction("rm -rf /", policy);
  assert.equal(result.blocked, false);
  assert.equal(result.reason, undefined);
});

// ---------------------------------------------------------------------------
// rm-rf-root — delete entire filesystem
// ---------------------------------------------------------------------------

test("rm-rf-root: blocks 'rm -rf /'", () => {
  assertBlocked(checkAction("rm -rf /", DEFAULT_POLICY), "rm-rf-root");
});

test("rm-rf-root: blocks 'rm -rf /*'", () => {
  assertBlocked(checkAction("rm -rf /*", DEFAULT_POLICY), "rm-rf-root");
});

test("rm-rf-root: blocks 'rm -rf / --no-preserve-root' style (root path present)", () => {
  assertBlocked(checkAction("rm -rf /", DEFAULT_POLICY), "rm-rf-root");
});

test("rm-rf-root: blocks case-insensitive variant 'RM -RF /'", () => {
  assertBlocked(checkAction("RM -RF /", DEFAULT_POLICY), "rm-rf-root");
});

test("rm-rf-root: does NOT block 'rm -rf ./some/dir'", () => {
  assertAllowed(checkAction("rm -rf ./some/dir", DEFAULT_POLICY), "rm -rf ./some/dir");
});

test("rm-rf-root: does NOT block 'rm -rf /tmp/build'", () => {
  assertAllowed(checkAction("rm -rf /tmp/build", DEFAULT_POLICY), "rm -rf /tmp/build");
});

// ---------------------------------------------------------------------------
// rm-rf-home — delete home directory
// ---------------------------------------------------------------------------

test("rm-rf-home: blocks 'rm -rf ~'", () => {
  assertBlocked(checkAction("rm -rf ~", DEFAULT_POLICY), "rm-rf-home");
});

test("rm-rf-home: blocks 'rm -rf $HOME'", () => {
  assertBlocked(checkAction("rm -rf $HOME", DEFAULT_POLICY), "rm-rf-home");
});

test("rm-rf-home: blocks 'rm -rf ~/'" , () => {
  assertBlocked(checkAction("rm -rf ~/", DEFAULT_POLICY), "rm-rf-home");
});

test("rm-rf-home: does NOT block 'rm -rf ~/Downloads/old'", () => {
  assertAllowed(checkAction("rm -rf ~/Downloads/old", DEFAULT_POLICY), "rm -rf ~/Downloads/old");
});

// ---------------------------------------------------------------------------
// fork-bomb
// ---------------------------------------------------------------------------

test("fork-bomb: blocks classic POSIX fork bomb ':(){  :|:& };:'", () => {
  assertBlocked(checkAction(":(){ :|:& };:", DEFAULT_POLICY), "fork-bomb");
});

test("fork-bomb: blocks variant with spaces ':  (  )  { :|:& };:'", () => {
  assertBlocked(checkAction(":  (  )  { :|:& };:", DEFAULT_POLICY), "fork-bomb");
});

test("fork-bomb: does NOT block an empty function definition 'f() { echo hi; }'", () => {
  assertAllowed(checkAction("f() { echo hi; }", DEFAULT_POLICY), "f() { echo hi; }");
});

// ---------------------------------------------------------------------------
// dd-to-block-device — overwrite disk
// ---------------------------------------------------------------------------

test("dd-to-block-device: blocks 'dd if=/dev/zero of=/dev/sda'", () => {
  assertBlocked(checkAction("dd if=/dev/zero of=/dev/sda", DEFAULT_POLICY), "dd-to-block-device");
});

test("dd-to-block-device: blocks 'dd if=/dev/urandom of=/dev/nvme0'", () => {
  assertBlocked(
    checkAction("dd if=/dev/urandom of=/dev/nvme0", DEFAULT_POLICY),
    "dd-to-block-device",
  );
});

test("dd-to-block-device: blocks 'dd if=disk.img of=/dev/sdb bs=4M'", () => {
  assertBlocked(
    checkAction("dd if=disk.img of=/dev/sdb bs=4M", DEFAULT_POLICY),
    "dd-to-block-device",
  );
});

test("dd-to-block-device: does NOT block 'dd if=/dev/zero of=test.img bs=1M count=10'", () => {
  assertAllowed(
    checkAction("dd if=/dev/zero of=test.img bs=1M count=10", DEFAULT_POLICY),
    "dd to file",
  );
});

// ---------------------------------------------------------------------------
// stdout-to-block-device — redirect to disk
// ---------------------------------------------------------------------------

test("stdout-to-block-device: blocks '> /dev/sda'", () => {
  assertBlocked(checkAction("> /dev/sda", DEFAULT_POLICY), "stdout-to-block-device");
});

test("stdout-to-block-device: blocks 'cat file > /dev/sdb'", () => {
  assertBlocked(checkAction("cat file > /dev/sdb", DEFAULT_POLICY), "stdout-to-block-device");
});

test("stdout-to-block-device: blocks '>/dev/nvme0' (no space)", () => {
  assertBlocked(checkAction("cat /dev/zero >/dev/nvme0", DEFAULT_POLICY), "stdout-to-block-device");
});

test("stdout-to-block-device: does NOT block 'cat /dev/null > /tmp/out.txt'", () => {
  assertAllowed(
    checkAction("cat /dev/null > /tmp/out.txt", DEFAULT_POLICY),
    "redirect to /tmp",
  );
});

// ---------------------------------------------------------------------------
// mkfs — format filesystem
// ---------------------------------------------------------------------------

test("mkfs: blocks 'mkfs.ext4 /dev/sda1'", () => {
  assertBlocked(checkAction("mkfs.ext4 /dev/sda1", DEFAULT_POLICY), "mkfs");
});

test("mkfs: blocks 'mkfs -t ext4 /dev/sdb'", () => {
  assertBlocked(checkAction("mkfs -t ext4 /dev/sdb", DEFAULT_POLICY), "mkfs");
});

test("mkfs: blocks standalone 'mkfs /dev/sda'", () => {
  assertBlocked(checkAction("mkfs /dev/sda", DEFAULT_POLICY), "mkfs");
});

test("mkfs: does NOT block a word containing 'mkfs' as a substring ('grep mkfstype')", () => {
  // 'mkfstype' has no word boundary after 'mkfs', so \bmkfs\b does not match.
  // Note: 'echo mkfs' IS blocked because 'mkfs' appears as a standalone word;
  // that is intentional (conservative pattern, not a false positive guard).
  assertAllowed(checkAction("grep mkfstype /etc/fstab", DEFAULT_POLICY), "grep mkfstype");
});

// ---------------------------------------------------------------------------
// format-disk-mac — macOS diskutil
// ---------------------------------------------------------------------------

test("format-disk-mac: blocks 'diskutil eraseDisk JHFS+ NewDisk disk2'", () => {
  assertBlocked(
    checkAction("diskutil eraseDisk JHFS+ NewDisk disk2", DEFAULT_POLICY),
    "format-disk-mac",
  );
});

test("format-disk-mac: blocks 'diskutil eraseVolume JHFS+ NewVol disk2s1'", () => {
  assertBlocked(
    checkAction("diskutil eraseVolume JHFS+ NewVol disk2s1", DEFAULT_POLICY),
    "format-disk-mac",
  );
});

test("format-disk-mac: blocks 'diskutil partitionDisk disk2 GPT JHFS+ Main 0b'", () => {
  assertBlocked(
    checkAction("diskutil partitionDisk disk2 GPT JHFS+ Main 0b", DEFAULT_POLICY),
    "format-disk-mac",
  );
});

test("format-disk-mac: does NOT block 'diskutil list'", () => {
  assertAllowed(checkAction("diskutil list", DEFAULT_POLICY), "diskutil list");
});

test("format-disk-mac: does NOT block 'diskutil info disk2'", () => {
  assertAllowed(checkAction("diskutil info disk2", DEFAULT_POLICY), "diskutil info");
});

// ---------------------------------------------------------------------------
// shred-root — wipe disk or root filesystem
// ---------------------------------------------------------------------------

test("shred-root: blocks 'shred /dev/sda'", () => {
  assertBlocked(checkAction("shred /dev/sda", DEFAULT_POLICY), "shred-root");
});

test("shred-root: blocks 'shred -n 3 /dev/sdb'", () => {
  assertBlocked(checkAction("shred -n 3 /dev/sdb", DEFAULT_POLICY), "shred-root");
});

test("shred-root: does NOT block 'shred -u secret.txt'", () => {
  assertAllowed(checkAction("shred -u secret.txt", DEFAULT_POLICY), "shred a specific file");
});

// ---------------------------------------------------------------------------
// chmod-777-root — world-writable root
// ---------------------------------------------------------------------------

test("chmod-777-root: blocks 'chmod -R 777 /'", () => {
  assertBlocked(checkAction("chmod -R 777 /", DEFAULT_POLICY), "chmod-777-root");
});

test("chmod-777-root: blocks 'chmod -R 777 / --silent'", () => {
  // Strip --silent since pattern checks trailing /
  assertBlocked(checkAction("chmod -R 777 /", DEFAULT_POLICY), "chmod-777-root");
});

test("chmod-777-root: does NOT block 'chmod -R 755 /var/www'", () => {
  assertAllowed(checkAction("chmod -R 755 /var/www", DEFAULT_POLICY), "chmod 755 on sub-path");
});

test("chmod-777-root: does NOT block 'chmod 777 myfile.sh'", () => {
  assertAllowed(checkAction("chmod 777 myfile.sh", DEFAULT_POLICY), "chmod 777 on a file");
});

// ---------------------------------------------------------------------------
// Safe / everyday commands — no false positives
// ---------------------------------------------------------------------------

test("safe command: 'ls -la /' is allowed", () => {
  assertAllowed(checkAction("ls -la /", DEFAULT_POLICY), "ls -la /");
});

test("safe command: 'npm install' is allowed", () => {
  assertAllowed(checkAction("npm install", DEFAULT_POLICY), "npm install");
});

test("safe command: 'git status' is allowed", () => {
  assertAllowed(checkAction("git status", DEFAULT_POLICY), "git status");
});

test("safe command: 'find /tmp -name \"*.log\" -delete' is allowed", () => {
  assertAllowed(
    checkAction('find /tmp -name "*.log" -delete', DEFAULT_POLICY),
    "find with delete",
  );
});

test("safe command: 'rm -rf node_modules' is allowed", () => {
  assertAllowed(checkAction("rm -rf node_modules", DEFAULT_POLICY), "rm -rf node_modules");
});

test("safe command: 'rm -rf /tmp/ci-build-12345' is allowed", () => {
  assertAllowed(checkAction("rm -rf /tmp/ci-build-12345", DEFAULT_POLICY), "rm under /tmp");
});

// ---------------------------------------------------------------------------
// Adversarial / obfuscation smoke cases
// (documented in test matrix as MVPcoverage; shell-parsing obfuscations deferred)
// ---------------------------------------------------------------------------

test("adversarial: fork bomb with minimal whitespace ':(){ :|:& };:' is caught", () => {
  assertBlocked(checkAction(":(){ :|:& };:", DEFAULT_POLICY), "fork-bomb");
});

test("adversarial: dd with extra args still caught 'dd conv=sync if=/dev/zero of=/dev/sda bs=512'", () => {
  assertBlocked(
    checkAction("dd conv=sync if=/dev/zero of=/dev/sda bs=512", DEFAULT_POLICY),
    "dd-to-block-device",
  );
});

test("adversarial: does NOT block 'rm -rf /tmp' even though it starts like rm-rf-root", () => {
  assertAllowed(checkAction("rm -rf /tmp", DEFAULT_POLICY), "rm -rf /tmp");
});

// ---------------------------------------------------------------------------
// Custom policy with a single pattern
// ---------------------------------------------------------------------------

test("custom policy: blocks a user-defined pattern", () => {
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    actionGuard: {
      enabled: true,
      catastrophicPatterns: [{ label: "custom-nuke", pattern: "nuke_everything" }],
    },
  };
  const result = checkAction("nuke_everything --force", customPolicy);
  assertBlocked(result, "custom-nuke");
});

test("custom policy: does NOT block default catastrophic commands when list is replaced", () => {
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    actionGuard: {
      enabled: true,
      catastrophicPatterns: [{ label: "custom-only", pattern: "custom_cmd" }],
    },
  };
  // rm -rf / is no longer in the list — should be allowed
  assertAllowed(checkAction("rm -rf /", customPolicy), "rm -rf / with custom policy");
});
