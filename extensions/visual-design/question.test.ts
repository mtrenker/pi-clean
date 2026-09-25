import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDesign } from "./design.ts";
import { answerBody } from "./answer.ts";
import { describeResponse, parseResponse, validateAsk, type PublicQuestion } from "./question.ts";

const design = parseDesign(await readFile(new URL("../../designs/example.design.json", import.meta.url), "utf8"));
const question: PublicQuestion = { requestId: "r1", revision: "abc", anchorId: "hero-copy", question: "Tone?", choices: ["Warm", "Plain"] };

test("questions anchor to existing containers with a small distinct choice set", () => {
  assert.deepEqual(validateAsk({ question: "  Tone? ", anchorId: "hero-copy" }, design), { question: "Tone?", anchorId: "hero-copy", choices: [] });
  assert.throws(() => validateAsk({ question: "Tone?", anchorId: "hero-title" }, design), /must reference a container/);
  assert.throws(() => validateAsk({ question: "Tone?", anchorId: "missing" }, design), /not found/);
  assert.throws(() => validateAsk({ question: "Tone?", anchorId: "site-viewport" }, design), /not a root node/);
  const nested = structuredClone(design);
  nested.root[0].children.push({ id: "inner-viewport", type: "viewport", children: [{ id: "inner-text", type: "text", children: [{ text: "Hi" }] }] });
  assert.equal(validateAsk({ question: "Tone?", anchorId: "inner-viewport" }, parseDesign(nested)).anchorId, "inner-viewport");
  assert.throws(() => validateAsk({ question: "Tone?", anchorId: "hero-copy", choices: ["Only"] }, design), /2-6/);
  assert.throws(() => validateAsk({ question: "Tone?", anchorId: "hero-copy", choices: ["A", "A"] }, design), /distinct/);
});

test("responses require substance for their outcome and never carry notes into a dismissal", () => {
  assert.throws(() => parseResponse({ outcome: "answered" }, question, design), /choice or answer/);
  assert.throws(() => parseResponse({ outcome: "answered", choice: "Loud" }, question, design), /offered choices/);
  assert.throws(() => parseResponse({ outcome: "revise", answer: "  " }, question, design), /guidance text or at least one note/);
  assert.throws(() => parseResponse({ outcome: "approve" }, question, design), /outcome must be/);
  assert.deepEqual(
    parseResponse({ outcome: "revise", notes: [{ nodeId: "hero-title", text: " Shorter " }] }, question, design),
    { outcome: "revise", notes: [{ nodeId: "hero-title", text: "Shorter" }] },
  );
  assert.deepEqual(
    parseResponse({ outcome: "cancelled", answer: "x", notes: [{ nodeId: "hero-title", text: "y" }] }, question, design),
    { outcome: "cancelled", reason: "operator", notes: [] },
  );
  const oversized = { answer: "x".repeat(4_001), notes: [{ nodeId: "nope", text: "y".repeat(1_001) }] };
  assert.deepEqual(parseResponse({ outcome: "cancelled", ...oversized }, question, design), { outcome: "cancelled", reason: "operator", notes: [] });
  assert.throws(() => parseResponse({ outcome: "answered", answer: "x".repeat(4_001) }, question, design), /answer must be at most 4000/);
  assert.throws(
    () => parseResponse({ outcome: "revise", notes: [{ nodeId: "hero-title", text: "y".repeat(1_001) }] }, question, design),
    /text must be at most 1000/,
  );
});

test("a dismissal request carries only identity and outcome, never the draft", () => {
  const draft = { choice: "Warm", answer: "x".repeat(4_000), notes: [{ nodeId: "hero-title", text: "Shorter" }] };
  assert.deepEqual(answerBody(question, "cancelled", draft), { requestId: "r1", revision: "abc", outcome: "cancelled" });
  assert.deepEqual(answerBody(question, "revise", draft), { requestId: "r1", revision: "abc", outcome: "revise", ...draft });
});

test("model-facing text marks feedback as non-authorizing and cancellation as no answer", () => {
  const answered = describeResponse(question, { outcome: "answered", choice: "Warm", notes: [] });
  assert.match(answered, /Choice: Warm/);
  assert.match(answered, /not authorization/);
  const cancelled = describeResponse(question, { outcome: "cancelled", reason: "document-changed", notes: [] });
  assert.match(cancelled, /No answer was given .*Do not treat this as agreement/);
});
