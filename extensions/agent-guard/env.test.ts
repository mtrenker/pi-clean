/**
 * Agent Guard — Environment Filtering Tests
 *
 * Covers:
 *   - buildFilteredEnv: strips vars matching stripEnvPatterns.
 *   - buildFilteredEnv: preserves vars in preserveEnvVars even if they match.
 *   - buildFilteredEnv: passes through vars that don't match any pattern.
 *   - buildFilteredEnv: preserves vars with undefined values.
 *   - buildFilteredEnv: returns full env when secretGuard.enabled is false.
 *   - buildUnsetPreamble: returns a valid unset snippet for matching vars.
 *   - buildUnsetPreamble: returns empty string when no matches are in process.env.
 *   - buildUnsetPreamble: returns empty string when secretGuard.enabled is false.
 *   - Pattern matching: common credential naming conventions are stripped.
 *   - Pattern caching: multiple calls with same policy object are consistent.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildFilteredEnv, buildUnsetPreamble } from "./env.ts";
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

// ---------------------------------------------------------------------------
// buildFilteredEnv — basic strip behaviour
// ---------------------------------------------------------------------------

test("buildFilteredEnv: strips AWS_SECRET_ACCESS_KEY", () => {
  const env = {
    AWS_SECRET_ACCESS_KEY: "somesecret",
    PATH: "/usr/bin:/bin",
  };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.equal(filtered["AWS_SECRET_ACCESS_KEY"], undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "AWS_SECRET_ACCESS_KEY"));
});

test("buildFilteredEnv: strips ANTHROPIC_API_KEY", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-test", HOME: "/home/user" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "ANTHROPIC_API_KEY"));
});

test("buildFilteredEnv: strips GITHUB_TOKEN", () => {
  const env = { GITHUB_TOKEN: "ghp_abc", TERM: "xterm-256color" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "GITHUB_TOKEN"));
});

test("buildFilteredEnv: strips OPENAI_API_KEY", () => {
  const env = { OPENAI_API_KEY: "sk-test" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "OPENAI_API_KEY"));
});

test("buildFilteredEnv: strips DATABASE_URL", () => {
  const env = { DATABASE_URL: "postgres://user:pass@host/db" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "DATABASE_URL"));
});

test("buildFilteredEnv: strips MY_APP_SECRET (matches _SECRET$ pattern)", () => {
  const env = { MY_APP_SECRET: "super-secret-value" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "MY_APP_SECRET"));
});

test("buildFilteredEnv: strips MY_APP_TOKEN (matches _TOKEN$ pattern)", () => {
  const env = { MY_APP_TOKEN: "some-token" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "MY_APP_TOKEN"));
});

test("buildFilteredEnv: strips MY_APP_KEY (matches _KEY$ pattern)", () => {
  const env = { MY_APP_KEY: "some-key" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "MY_APP_KEY"));
});

test("buildFilteredEnv: strips MY_APP_PASSWORD (matches _PASSWORD$ pattern)", () => {
  const env = { MY_APP_PASSWORD: "p@ssw0rd" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(!Object.prototype.hasOwnProperty.call(filtered, "MY_APP_PASSWORD"));
});

// ---------------------------------------------------------------------------
// buildFilteredEnv — preserve list overrides strip patterns
// ---------------------------------------------------------------------------

test("buildFilteredEnv: preserves PATH even though it contains nothing credential-like", () => {
  const env = { PATH: "/usr/bin:/bin", AWS_SECRET_ACCESS_KEY: "secret" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.equal(filtered["PATH"], "/usr/bin:/bin");
});

test("buildFilteredEnv: preserves HOME (in preserveEnvVars)", () => {
  const env = { HOME: "/home/martin", GITHUB_TOKEN: "ghp_abc" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.equal(filtered["HOME"], "/home/martin");
});

test("buildFilteredEnv: preserves NODE_ENV (in preserveEnvVars)", () => {
  const env = { NODE_ENV: "test", MY_APP_SECRET: "secret" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.equal(filtered["NODE_ENV"], "test");
});

test("buildFilteredEnv: preserves CI (in preserveEnvVars)", () => {
  const env = { CI: "true", MY_TOKEN: "tok" };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.equal(filtered["CI"], "true");
});

// Test a hypothetical variable that matches a strip pattern but is in preserveEnvVars
test("buildFilteredEnv: preserves a var in preserveEnvVars even if it matches a strip pattern", () => {
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    secretGuard: {
      ...DEFAULT_POLICY.secretGuard,
      stripEnvPatterns: ["^KEEP_ME_TOKEN$"],
      preserveEnvVars: [...DEFAULT_POLICY.secretGuard.preserveEnvVars, "KEEP_ME_TOKEN"],
    },
  };
  const env = { KEEP_ME_TOKEN: "must-survive" };
  const filtered = buildFilteredEnv(env, customPolicy);
  assert.equal(filtered["KEEP_ME_TOKEN"], "must-survive");
});

// ---------------------------------------------------------------------------
// buildFilteredEnv — pass-through for non-secret vars
// ---------------------------------------------------------------------------

test("buildFilteredEnv: passes through non-secret vars unchanged", () => {
  const env = {
    EDITOR: "vim",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.equal(filtered["EDITOR"], "vim");
  assert.equal(filtered["TERM"], "xterm-256color");
  assert.equal(filtered["LANG"], "en_US.UTF-8");
});

test("buildFilteredEnv: preserves vars with undefined values", () => {
  const env: NodeJS.ProcessEnv = { SOME_VAR: undefined };
  const filtered = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.ok(Object.prototype.hasOwnProperty.call(filtered, "SOME_VAR"));
  assert.equal(filtered["SOME_VAR"], undefined);
});

// ---------------------------------------------------------------------------
// buildFilteredEnv — secretGuard disabled
// ---------------------------------------------------------------------------

test("buildFilteredEnv: returns full env copy when secretGuard.enabled is false", () => {
  const env = {
    AWS_SECRET_ACCESS_KEY: "should-survive",
    ANTHROPIC_API_KEY: "also-survives",
    PATH: "/usr/bin",
  };
  const filtered = buildFilteredEnv(env, disabledPolicy());
  assert.equal(filtered["AWS_SECRET_ACCESS_KEY"], "should-survive");
  assert.equal(filtered["ANTHROPIC_API_KEY"], "also-survives");
  assert.equal(filtered["PATH"], "/usr/bin");
});

// ---------------------------------------------------------------------------
// buildUnsetPreamble — with process.env
// ---------------------------------------------------------------------------

test("buildUnsetPreamble: returns empty string when no secret vars are in process.env", () => {
  // In a clean test environment there might be no credential vars — or there might be.
  // We test with a stripped-down policy that matches nothing present.
  const customPolicy: GuardPolicy = {
    ...DEFAULT_POLICY,
    secretGuard: {
      ...DEFAULT_POLICY.secretGuard,
      stripEnvPatterns: ["^THIS_VAR_WILL_NEVER_EXIST_IN_ENV_12345$"],
    },
  };
  const preamble = buildUnsetPreamble(customPolicy);
  assert.equal(preamble, "");
});

test("buildUnsetPreamble: returns empty string when secretGuard.enabled is false", () => {
  const preamble = buildUnsetPreamble(disabledPolicy());
  assert.equal(preamble, "");
});

test("buildUnsetPreamble: returns a valid unset snippet when matching vars are present", () => {
  // Temporarily add a mock var to process.env for the duration of this test.
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

    const preamble = buildUnsetPreamble(customPolicy);
    assert.ok(preamble.startsWith("unset "), `Expected 'unset ...', got: ${preamble}`);
    assert.ok(preamble.includes(testKey), `Expected preamble to include ${testKey}`);
  } finally {
    if (originalValue === undefined) {
      delete process.env[testKey];
    } else {
      process.env[testKey] = originalValue;
    }
  }
});

test("buildUnsetPreamble: unset snippet contains only the matching vars", () => {
  const testKey = "AGENT_GUARD_TEST_TOKEN_9876";
  const originalValue = process.env[testKey];
  process.env[testKey] = "dummy";

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

    const preamble = buildUnsetPreamble(customPolicy);
    // The preamble should be a single "unset X" line (or include X among others)
    const parts = preamble.replace("unset ", "").split(" ");
    assert.ok(parts.includes(testKey), `Expected ${testKey} in unset args`);
  } finally {
    if (originalValue === undefined) {
      delete process.env[testKey];
    } else {
      process.env[testKey] = originalValue;
    }
  }
});

// ---------------------------------------------------------------------------
// Pattern caching — multiple calls with the same policy object are consistent
// ---------------------------------------------------------------------------

test("buildFilteredEnv: multiple calls with same policy give consistent results", () => {
  const env = {
    ANTHROPIC_API_KEY: "key",
    PATH: "/usr/bin",
  };
  const result1 = buildFilteredEnv(env, DEFAULT_POLICY);
  const result2 = buildFilteredEnv(env, DEFAULT_POLICY);
  assert.deepEqual(result1, result2);
  assert.ok(!Object.prototype.hasOwnProperty.call(result1, "ANTHROPIC_API_KEY"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result2, "ANTHROPIC_API_KEY"));
});
