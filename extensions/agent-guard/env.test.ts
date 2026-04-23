/**
 * Agent Guard — Environment Filtering Tests
 *
 * Temporary simplified mode:
 *   Env stripping is intentionally disabled for now.
 *
 * Covers:
 *   - buildFilteredEnv returns a shallow copy unchanged for secret-looking vars.
 *   - buildFilteredEnv preserves ordinary vars and undefined values.
 *   - buildFilteredEnv behaves the same regardless of secretGuard.enabled.
 *   - buildUnsetPreamble always returns an empty string.
 *   - multiple calls with the same policy are consistent.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildFilteredEnv, buildUnsetPreamble } from "./env.ts";
import { DEFAULT_POLICY, type GuardPolicy } from "./policy.ts";

function disabledPolicy(): GuardPolicy {
  return {
    ...DEFAULT_POLICY,
    secretGuard: { ...DEFAULT_POLICY.secretGuard, enabled: false },
  };
}

test("buildFilteredEnv: leaves secret-looking vars unchanged", () => {
  const env = {
    AWS_SECRET_ACCESS_KEY: "somesecret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    GITHUB_TOKEN: "ghp_abc",
    OPENAI_API_KEY: "sk-test",
    DATABASE_URL: "postgres://user:pass@host/db",
    MY_APP_SECRET: "super-secret-value",
    MY_APP_TOKEN: "some-token",
    MY_APP_KEY: "some-key",
    MY_APP_PASSWORD: "p@ssw0rd",
    PATH: "/usr/bin:/bin",
  };

  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.deepEqual(filtered, env);
  assert.notEqual(filtered, env, "Expected a shallow copy, not the same object reference");
});

test("buildFilteredEnv: preserves ordinary vars unchanged", () => {
  const env = {
    EDITOR: "vim",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  };

  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.deepEqual(filtered, env);
});

test("buildFilteredEnv: preserves vars with undefined values", () => {
  const env: NodeJS.ProcessEnv = { SOME_VAR: undefined };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(Object.prototype.hasOwnProperty.call(filtered, "SOME_VAR"));
  assert.equal(filtered["SOME_VAR"], undefined);
});

test("buildFilteredEnv: returns full env copy when secretGuard.enabled is false", () => {
  const env = {
    AWS_SECRET_ACCESS_KEY: "should-survive",
    ANTHROPIC_API_KEY: "also-survives",
    PATH: "/usr/bin",
  };

  const filtered = buildFilteredEnv(env, disabledPolicy());
  assert.deepEqual(filtered, env);
  assert.notEqual(filtered, env, "Expected a shallow copy, not the same object reference");
});

test("buildFilteredEnv: custom strip patterns currently have no effect", () => {
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    secretGuard: {
      ...DEFAULT_POLICY.secretGuard,
      stripEnvPatterns: ["^KEEP_ME_TOKEN$"],
      preserveEnvVars: [],
    },
  };

  const env = { KEEP_ME_TOKEN: "must-survive" };
  const filtered = buildFilteredEnv(env, customPolicy);
  assert.deepEqual(filtered, env);
});

test("buildUnsetPreamble: always returns empty string with default policy", () => {
  assert.equal(buildUnsetPreamble(DEFAULT_POLICY), "");
});

test("buildUnsetPreamble: always returns empty string when secretGuard.enabled is false", () => {
  assert.equal(buildUnsetPreamble(disabledPolicy()), "");
});

test("buildUnsetPreamble: returns empty string even when matching vars are present", () => {
  const testKey = "TEST_SECRET_KEY_AGENT_GUARD_UNIT";
  const originalValue = process.env[testKey];
  process.env[testKey] = "test-value";

  try {
    const customPolicy: GuardPolicy = {
      ...DEFAULT_POLICY,
      secretGuard: {
        ...DEFAULT_POLICY.secretGuard,
        stripEnvPatterns: [`^${testKey}$`],
        preserveEnvVars: DEFAULT_POLICY.secretGuard.preserveEnvVars.filter(
          (v) => v !== testKey,
        ),
      },
    };

    assert.equal(buildUnsetPreamble(customPolicy), "");
  } finally {
    if (originalValue === undefined) {
      delete process.env[testKey];
    } else {
      process.env[testKey] = originalValue;
    }
  }
});

test("buildFilteredEnv: multiple calls with same policy give consistent results", () => {
  const env = {
    ANTHROPIC_API_KEY: "key",
    PATH: "/usr/bin",
  };

  const result1 = buildFilteredEnv(env, DEFAULT_POLICY);
  const result2 = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.deepEqual(result1, result2);
  assert.deepEqual(result1, env);
});
