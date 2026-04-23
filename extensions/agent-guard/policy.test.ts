/**
 * Agent Guard — Policy Module Tests
 *
 * Covers:
 *   - DEFAULT_POLICY shape: all required fields present and correctly typed.
 *   - loadPolicy returns DEFAULT_POLICY when no config files exist.
 *   - loadPolicy merges a project-level override (arrays replace, primitives win).
 *   - Malformed / missing JSON files are silently ignored.
 *   - deepMerge semantics: nested objects merge, arrays replace, undefined skipped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_POLICY, loadPolicy, type GuardPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// DEFAULT_POLICY shape
// ---------------------------------------------------------------------------

test("DEFAULT_POLICY has all top-level fields", () => {
  assert.ok(typeof DEFAULT_POLICY.auditLogPath === "string");
  assert.ok(DEFAULT_POLICY.secretGuard !== undefined);
  assert.ok(DEFAULT_POLICY.actionGuard !== undefined);
});

test("DEFAULT_POLICY.secretGuard has required fields with correct types", () => {
  const sg = DEFAULT_POLICY.secretGuard;
  assert.equal(typeof sg.enabled, "boolean");
  assert.ok(Array.isArray(sg.stripEnvPatterns));
  assert.ok(Array.isArray(sg.preserveEnvVars));
  assert.ok(Array.isArray(sg.hardBlockPaths));
  assert.ok(Array.isArray(sg.warnOnlyPaths));
  assert.ok(Array.isArray(sg.redactionPatterns));
});

test("DEFAULT_POLICY.actionGuard has required fields with correct types", () => {
  const ag = DEFAULT_POLICY.actionGuard;
  assert.equal(typeof ag.enabled, "boolean");
  assert.ok(Array.isArray(ag.catastrophicPatterns));
});

test("DEFAULT_POLICY.secretGuard.enabled is true", () => {
  assert.equal(DEFAULT_POLICY.secretGuard.enabled, true);
});

test("DEFAULT_POLICY.actionGuard.enabled is true", () => {
  assert.equal(DEFAULT_POLICY.actionGuard.enabled, true);
});

test("DEFAULT_POLICY.secretGuard.stripEnvPatterns is non-empty", () => {
  assert.ok(DEFAULT_POLICY.secretGuard.stripEnvPatterns.length > 0);
});

test("DEFAULT_POLICY.secretGuard.preserveEnvVars includes PATH and HOME", () => {
  assert.ok(DEFAULT_POLICY.secretGuard.preserveEnvVars.includes("PATH"));
  assert.ok(DEFAULT_POLICY.secretGuard.preserveEnvVars.includes("HOME"));
});

test("DEFAULT_POLICY.secretGuard.hardBlockPaths includes SSH private key patterns", () => {
  const patterns = DEFAULT_POLICY.secretGuard.hardBlockPaths;
  assert.ok(patterns.some((p) => p.includes(".ssh")));
});

test("DEFAULT_POLICY.secretGuard.hardBlockPaths includes .env and .env.local", () => {
  const patterns = DEFAULT_POLICY.secretGuard.hardBlockPaths;
  assert.ok(patterns.some((p) => p.includes(".env")));
  assert.ok(patterns.some((p) => p.includes(".env.local")));
});

test("DEFAULT_POLICY.secretGuard.warnOnlyPaths includes .aws/config and .ssh/config", () => {
  const patterns = DEFAULT_POLICY.secretGuard.warnOnlyPaths;
  assert.ok(patterns.some((p) => p.includes(".aws/config")));
  assert.ok(patterns.some((p) => p.includes(".ssh/config")));
});

test("DEFAULT_POLICY.actionGuard.catastrophicPatterns covers all documented labels", () => {
  const labels = DEFAULT_POLICY.actionGuard.catastrophicPatterns.map((p) => p.label);
  const expected = [
    "rm-rf-root",
    "rm-rf-home",
    "fork-bomb",
    "dd-to-block-device",
    "stdout-to-block-device",
    "mkfs",
    "format-disk-mac",
    "shred-root",
    "chmod-777-root",
  ];
  for (const label of expected) {
    assert.ok(labels.includes(label), `Missing catastrophic pattern: ${label}`);
  }
});

test("DEFAULT_POLICY.secretGuard.redactionPatterns covers all documented labels", () => {
  const labels = DEFAULT_POLICY.secretGuard.redactionPatterns.map((p) => p.label);
  const expected = [
    "aws-access-key-id",
    "aws-secret-access-key",
    "anthropic-api-key",
    "openai-api-key",
    "github-pat",
    "generic-api-key",
  ];
  for (const label of expected) {
    assert.ok(labels.includes(label), `Missing redaction pattern: ${label}`);
  }
});

test("DEFAULT_POLICY.auditLogPath points inside .pi directory", () => {
  assert.ok(DEFAULT_POLICY.auditLogPath.startsWith(".pi/"));
});

// ---------------------------------------------------------------------------
// loadPolicy — no config files (pure defaults)
// ---------------------------------------------------------------------------

test("loadPolicy returns DEFAULT_POLICY when no config files exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-policy-test-"));
  try {
    const policy = loadPolicy(tmpDir);
    // Structural check: key counts should match
    assert.equal(
      policy.secretGuard.stripEnvPatterns.length,
      DEFAULT_POLICY.secretGuard.stripEnvPatterns.length,
    );
    assert.equal(
      policy.actionGuard.catastrophicPatterns.length,
      DEFAULT_POLICY.actionGuard.catastrophicPatterns.length,
    );
    assert.equal(policy.secretGuard.enabled, true);
    assert.equal(policy.actionGuard.enabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// loadPolicy — project-level override merging
// ---------------------------------------------------------------------------

test("loadPolicy merges project-level override: primitives from override win", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-policy-test-"));
  try {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    const override: Partial<GuardPolicy> = {
      secretGuard: {
        ...DEFAULT_POLICY.secretGuard,
        enabled: false,
      },
    };
    fs.writeFileSync(
      path.join(piDir, "agent-guard.json"),
      JSON.stringify(override),
      "utf8",
    );

    const policy = loadPolicy(tmpDir);
    assert.equal(policy.secretGuard.enabled, false);
    // actionGuard should still be default
    assert.equal(policy.actionGuard.enabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("loadPolicy merges project-level override: arrays replace (not concatenate)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-policy-test-"));
  try {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    const customPatterns = [{ label: "custom", pattern: "custom-pattern" }];
    const override: Partial<GuardPolicy> = {
      actionGuard: {
        ...DEFAULT_POLICY.actionGuard,
        catastrophicPatterns: customPatterns,
      },
    };
    fs.writeFileSync(
      path.join(piDir, "agent-guard.json"),
      JSON.stringify(override),
      "utf8",
    );

    const policy = loadPolicy(tmpDir);
    // The custom list should REPLACE the default, not extend it
    assert.equal(policy.actionGuard.catastrophicPatterns.length, 1);
    assert.equal(policy.actionGuard.catastrophicPatterns[0]!.label, "custom");
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("loadPolicy merges project-level override: nested object fields merge", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-policy-test-"));
  try {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    // Override only actionGuard.enabled; secretGuard should remain default
    const override = {
      actionGuard: { enabled: false },
    };
    fs.writeFileSync(
      path.join(piDir, "agent-guard.json"),
      JSON.stringify(override),
      "utf8",
    );

    const policy = loadPolicy(tmpDir);
    assert.equal(policy.actionGuard.enabled, false);
    // secretGuard should be unchanged
    assert.equal(policy.secretGuard.enabled, true);
    assert.ok(policy.secretGuard.stripEnvPatterns.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// loadPolicy — malformed / missing config resilience
// ---------------------------------------------------------------------------

test("loadPolicy silently ignores a malformed project config file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-policy-test-"));
  try {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "agent-guard.json"), "NOT VALID JSON", "utf8");

    // Should not throw and should return defaults
    const policy = loadPolicy(tmpDir);
    assert.equal(policy.secretGuard.enabled, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test("loadPolicy silently ignores an empty project config directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-policy-test-"));
  try {
    // No .pi directory at all
    assert.doesNotThrow(() => loadPolicy(tmpDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});
