/**
 * Agent Guard — Redaction Tests
 *
 * Covers:
 *   - Each redaction pattern replaces the matching span with [REDACTED:<label>].
 *   - `count` accurately reflects the number of replacements made.
 *   - Multiple occurrences of the same secret are all replaced (global flag).
 *   - Mixed output: only the secret span is replaced; surrounding text is intact.
 *   - Multiple different secrets in one block are all replaced.
 *   - Text with no secrets is returned unchanged with count === 0.
 *   - policy.secretGuard.enabled = false disables all redaction.
 *   - Empty string input returns unchanged with count === 0.
 *   - [REDACTED:…] placeholders are not re-matched by subsequent patterns.
 *   - Inline PCRE flag (?i) in pattern source is stripped before compilation.
 *   - Case-insensitive matching (gi flags) works correctly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { redactContent, type RedactionResult } from "./redaction.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function disabledPolicy(): GuardPolicy {
  return {
    ...DEFAULT_POLICY,
    secretGuard: { ...DEFAULT_POLICY.secretGuard, enabled: false },
  };
}

function assertRedacted(
  result: RedactionResult,
  label: string,
  expectedCount = 1,
): void {
  const placeholder = `[REDACTED:${label}]`;
  assert.ok(
    result.redacted.includes(placeholder),
    `Expected redacted output to contain "${placeholder}", got:\n${result.redacted}`,
  );
  assert.ok(
    result.count >= expectedCount,
    `Expected count >= ${expectedCount}, got ${result.count}`,
  );
}

function assertNotRedacted(result: RedactionResult, original: string): void {
  assert.equal(result.redacted, original);
  assert.equal(result.count, 0);
}

// ---------------------------------------------------------------------------
// AWS Access Key ID
// ---------------------------------------------------------------------------

test("redactContent: replaces AWS AKIA access key ID", () => {
  const text = "Your key is AKIAIOSFODNN7EXAMPLE and keep it safe.";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "aws-access-key-id");
  assert.ok(!result.redacted.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redactContent: replaces AWS ASIA (STS) access key ID", () => {
  // ASIA prefix + exactly 16 uppercase alphanumeric chars = 20 chars total
  const text = "STS key: ASIAIOSFODNN7EXAMPLE";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "aws-access-key-id");
});

test("redactContent: does NOT redact short AKIA-prefixed strings (< 20 chars)", () => {
  // AKIA + fewer than 16 chars is not a valid key ID
  const text = "AKIASHORT";
  const result = redactContent(text, DEFAULT_POLICY);
  assert.equal(result.count, 0);
});

test("redactContent: count reflects multiple AWS key IDs in one block", () => {
  // Both keys must be AKIA/ASIA + exactly 16 uppercase alphanumeric chars (20 total)
  const text = "key1=AKIAIOSFODNN7EXAMPLE  key2=AKIAIOSFODNN7EXAMPL2";
  const result = redactContent(text, DEFAULT_POLICY);
  assert.equal(result.count, 2);
  assert.ok(!result.redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!result.redacted.includes("AKIAIOSFODNN7EXAMPL2"));
});

// ---------------------------------------------------------------------------
// Anthropic API Key
// ---------------------------------------------------------------------------

test("redactContent: replaces Anthropic sk-ant- key", () => {
  const text = "export ANTHROPIC_API_KEY=sk-ant-api03-ABCDEF1234567890abcdef1234567890";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "anthropic-api-key");
  assert.ok(!result.redacted.includes("sk-ant-api03-ABCDEF"));
});

test("redactContent: replaces short but valid sk-ant- key (>= 20 chars after prefix)", () => {
  const text = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "anthropic-api-key");
});

test("redactContent: does NOT redact sk-ant- prefix alone (too short)", () => {
  const text = "sk-ant-x";  // fewer than 20 chars after prefix
  const result = redactContent(text, DEFAULT_POLICY);
  assert.equal(result.count, 0);
});

// ---------------------------------------------------------------------------
// OpenAI API Key
// ---------------------------------------------------------------------------

test("redactContent: replaces OpenAI sk- legacy key", () => {
  const text = "const apiKey = 'sk-ABCDEFGHIJKLMNOPQRST1234'";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "openai-api-key");
});

test("redactContent: replaces OpenAI sk-proj- project key", () => {
  const text = "apiKey: sk-proj-ABCDEFGHIJKLMNOPQRST12345678";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "openai-api-key");
});

// ---------------------------------------------------------------------------
// GitHub PAT
// ---------------------------------------------------------------------------

test("redactContent: replaces GitHub classic PAT (ghp_ prefix)", () => {
  const text = "GITHUB_TOKEN=ghp_16C7e42F292c6912E169C3S81F3GgSe1A39C4C2";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "github-pat");
  assert.ok(!result.redacted.includes("ghp_16C7e42F292c6912E169C3S81F3GgSe1A39C4C2"));
});

test("redactContent: replaces GitHub fine-grained token (github_pat_ prefix)", () => {
  const text = "token: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "github-pat");
});

test("redactContent: replaces GitHub OAuth token (gho_ prefix)", () => {
  const text = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "github-pat");
});

test("redactContent: replaces GitHub user-to-server token (ghu_ prefix)", () => {
  const text = "token: ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "github-pat");
});

// ---------------------------------------------------------------------------
// Generic API Key
// ---------------------------------------------------------------------------

test("redactContent: replaces 'api_key = <value>' pattern", () => {
  const text = "api_key = supersecretvalue12345678901234";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "generic-api-key");
  assert.ok(!result.redacted.includes("supersecretvalue12345678901234"));
});

test("redactContent: replaces 'secret_key: <value>' pattern", () => {
  const text = "secret_key: my_super_secret_value_here_1234";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "generic-api-key");
});

test("redactContent: replaces 'access_token = <value>' pattern", () => {
  const text = "access_token = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "generic-api-key");
});

test("redactContent: replaces 'auth_token: <value>' pattern", () => {
  const text = "auth_token: bearer_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "generic-api-key");
});

test("redactContent: generic-api-key is case-insensitive (API_KEY pattern)", () => {
  const text = "API_KEY=aBCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "generic-api-key");
});

test("redactContent: does NOT redact short values (< 16 chars) for generic-api-key", () => {
  const text = "api_key = short";  // only 5 chars — too short to match
  const result = redactContent(text, DEFAULT_POLICY);
  assert.equal(result.count, 0, "Short values should not be redacted");
});

// ---------------------------------------------------------------------------
// Mixed output
// ---------------------------------------------------------------------------

test("redactContent: only the secret span is redacted; surrounding text intact", () => {
  const text = [
    "Output from the build process:",
    "Step 1: Compile TypeScript",
    "Step 2: Authenticate — ANTHROPIC_API_KEY=sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    "Step 3: Deploy complete",
  ].join("\n");

  const result = redactContent(text, DEFAULT_POLICY);
  assert.ok(result.redacted.includes("Output from the build process:"));
  assert.ok(result.redacted.includes("Step 1: Compile TypeScript"));
  assert.ok(result.redacted.includes("Step 3: Deploy complete"));
  assert.ok(!result.redacted.includes("sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345"));
  assert.ok(result.redacted.includes("[REDACTED:anthropic-api-key]"));
});

// ---------------------------------------------------------------------------
// Multiple different secrets in one block
// ---------------------------------------------------------------------------

test("redactContent: replaces multiple different secrets; count equals total replacements", () => {
  const text = [
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890A",
    "GITHUB_TOKEN=ghp_16C7e42F292c6912E169C3S81F3GgSe1A39C4C2",
  ].join("\n");

  const result = redactContent(text, DEFAULT_POLICY);
  assert.ok(result.count >= 3, `Expected at least 3 redactions, got ${result.count}`);
  assert.ok(!result.redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!result.redacted.includes("sk-ant-api03-ABCDEF"));
  assert.ok(!result.redacted.includes("ghp_16C7e42F292c6912"));
});

// ---------------------------------------------------------------------------
// No secrets — unchanged output
// ---------------------------------------------------------------------------

test("redactContent: returns original text unchanged when no secrets present", () => {
  const text = "Hello world! Build successful in 2.3s.";
  assertNotRedacted(redactContent(text, DEFAULT_POLICY), text);
});

test("redactContent: count is 0 when no secrets present", () => {
  const result = redactContent("No secrets here.", DEFAULT_POLICY);
  assert.equal(result.count, 0);
});

test("redactContent: redacted equals input when count is 0", () => {
  const text = "Safe output text.";
  const result = redactContent(text, DEFAULT_POLICY);
  assert.equal(result.redacted, text);
});

// ---------------------------------------------------------------------------
// Disabled secretGuard
// ---------------------------------------------------------------------------

test("redactContent: returns unchanged text when secretGuard.enabled is false", () => {
  const text = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const result = redactContent(text, disabledPolicy());
  assert.equal(result.redacted, text);
  assert.equal(result.count, 0);
});

test("redactContent: count is 0 when secretGuard.enabled is false", () => {
  const text = "AKIAIOSFODNN7EXAMPLE12 and sk-ant-apikey-ABCDEF1234567890";
  const result = redactContent(text, disabledPolicy());
  assert.equal(result.count, 0);
});

// ---------------------------------------------------------------------------
// Empty / falsy input
// ---------------------------------------------------------------------------

test("redactContent: empty string returns { redacted: '', count: 0 }", () => {
  const result = redactContent("", DEFAULT_POLICY);
  assert.equal(result.redacted, "");
  assert.equal(result.count, 0);
});

// ---------------------------------------------------------------------------
// Non-recursive: [REDACTED:…] placeholders are not re-matched
// ---------------------------------------------------------------------------

test("redactContent: [REDACTED:aws-access-key-id] placeholder is not re-matched", () => {
  // If the placeholder somehow contained a key-like string, it should not be
  // redacted again. In practice placeholders contain only [, ], :, and label chars,
  // but we test the stability property explicitly.
  const placeholder = "[REDACTED:aws-access-key-id]";
  const result = redactContent(placeholder, DEFAULT_POLICY);
  // The placeholder should survive unchanged
  assert.equal(result.redacted, placeholder);
  assert.equal(result.count, 0);
});

test("redactContent: after one pass, output is stable (no double-redaction)", () => {
  const text = "key: AKIAIOSFODNN7EXAMPLE";
  const once = redactContent(text, DEFAULT_POLICY);
  const twice = redactContent(once.redacted, DEFAULT_POLICY);
  assert.equal(twice.redacted, once.redacted);
  assert.equal(twice.count, 0);
});

// ---------------------------------------------------------------------------
// Inline PCRE (?i) flag stripping
// ---------------------------------------------------------------------------

test("redactContent: (?i) prefix in pattern source is stripped without error", () => {
  // The generic-api-key pattern in DEFAULT_POLICY uses (?i) — ensure it compiles
  // and works correctly.
  const text = "API_KEY=aBCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  assert.doesNotThrow(() => redactContent(text, DEFAULT_POLICY));
  const result = redactContent(text, DEFAULT_POLICY);
  assertRedacted(result, "generic-api-key");
});

// ---------------------------------------------------------------------------
// Custom policy
// ---------------------------------------------------------------------------

test("redactContent: custom single-pattern policy redacts matching text", () => {
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    secretGuard: {
      ...DEFAULT_POLICY.secretGuard,
      redactionPatterns: [
        { label: "custom-secret", pattern: "MY_SECRET_[A-Z0-9]+" },
      ],
    },
  };
  const text = "value: MY_SECRET_ABC123DEF456";
  const result = redactContent(text, customPolicy);
  assert.ok(result.redacted.includes("[REDACTED:custom-secret]"));
  assert.equal(result.count, 1);
});

test("redactContent: custom policy does NOT redact AWS keys when patterns are replaced", () => {
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    secretGuard: {
      ...DEFAULT_POLICY.secretGuard,
      redactionPatterns: [{ label: "custom-only", pattern: "CUSTOM_TOKEN_[A-Z]+" }],
    },
  };
  const text = "AWS key: AKIAIOSFODNN7EXAMPLE";
  // The default AWS pattern is not in this custom list, so no redaction
  const result = redactContent(text, customPolicy);
  assert.equal(result.count, 0);
});

// ---------------------------------------------------------------------------
// Global flag: multiple occurrences are all replaced
// ---------------------------------------------------------------------------

test("redactContent: all occurrences of the same secret are replaced (global flag)", () => {
  const key = "AKIAIOSFODNN7EXAMPLE";
  const text = `key1=${key} and key2=${key} and also key3=${key}`;
  const result = redactContent(text, DEFAULT_POLICY);
  assert.equal(result.count, 3);
  assert.ok(!result.redacted.includes(key));
  // Three placeholders should appear
  const placeholders = (result.redacted.match(/\[REDACTED:aws-access-key-id\]/g) ?? []).length;
  assert.equal(placeholders, 3);
});
