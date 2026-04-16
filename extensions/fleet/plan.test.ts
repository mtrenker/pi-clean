import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePlanMarkdown,
  parsePlanDocument,
  validatePlanDocument,
  type PlanDocument,
} from "./plan.ts";

function validPlanMarkdown(): string {
  return `# Plan: Improve Fleet Plan Quality

## Overview

This plan improves the quality and reliability of generated fleet plans by introducing deterministic rendering and strict validation rules. It targets malformed tasks, missing dependency links, and vague requirements that currently force follow-up clarification in worker chats.

The implementation keeps the existing fleet workflow, but introduces a canonical PLAN.md shape and guardrails that fail fast with actionable errors. Success means workers can execute tasks from PLAN.md alone, and /fleet:split can reject invalid plans before task folders are created.

## Tasks

### Task 001: Build canonical plan parser and renderer

- **engine**: codex
- **profile**: balanced
- **model**: gpt-5.3-codex
- **thinking**: medium
- **agent**: worker
- **depends**: none
- **description**: Update \`extensions/fleet/plan.ts\` to parse full plan structure and render a canonical PLAN.md document with deterministic field ordering. Done when unit tests verify stable output and section ordering across repeated normalization runs.

### Task 002: Enforce validation guardrails in fleet split

- **engine**: codex
- **profile**: balanced
- **model**: gpt-5.3-codex
- **thinking**: medium
- **agent**: worker
- **depends**: 001
- **description**: Wire \`extensions/fleet/index.ts\` to validate dependencies, reject malformed tasks, and normalize PLAN.md before creating folders. Acceptance requires /fleet:split to fail with explicit errors for bad plans and proceed successfully for valid plans.
`;
}

test("validatePlanDocument accepts a concrete, well-formed plan", () => {
  const doc = parsePlanDocument(validPlanMarkdown());
  assert.doesNotThrow(() => validatePlanDocument(doc));
});

test("normalizePlanMarkdown returns canonical fleet plan output", () => {
  const normalized = normalizePlanMarkdown(validPlanMarkdown());
  assert.match(normalized, /^# Plan: Improve Fleet Plan Quality/m);
  assert.match(normalized, /^## Overview$/m);
  assert.match(normalized, /^## Tasks$/m);
  assert.match(normalized, /^### Task 001: Build canonical plan parser and renderer$/m);
});

test("validatePlanDocument accepts a task without model when profile provides defaults", () => {
  const markdown = validPlanMarkdown().replace("- **model**: gpt-5.3-codex\n", "");
  const doc = parsePlanDocument(markdown);
  assert.doesNotThrow(() => validatePlanDocument(doc));

  const normalized = normalizePlanMarkdown(markdown);
  assert.match(
    normalized,
    /### Task 001: Build canonical plan parser and renderer[\s\S]*?- \*\*profile\*\*: balanced\n- \*\*thinking\*\*: medium\n- \*\*agent\*\*: worker/,
  );
});

test("validatePlanDocument rejects duplicate task IDs", () => {
  const markdown = validPlanMarkdown().replace("### Task 002", "### Task 001");
  const doc = parsePlanDocument(markdown);
  assert.throws(() => validatePlanDocument(doc), /Duplicate task ID '001'/);
});

test("validatePlanDocument rejects broken dependency chains", () => {
  const markdown = validPlanMarkdown().replace("- **depends**: 001", "- **depends**: 999");
  const doc = parsePlanDocument(markdown);
  assert.throws(() => validatePlanDocument(doc), /dependency '999' does not exist/);
});

test("validatePlanDocument rejects vague task descriptions", () => {
  const markdown = validPlanMarkdown().replace(
    "- **description**: Update `extensions/fleet/plan.ts` to parse full plan structure and render a canonical PLAN.md document with deterministic field ordering. Done when unit tests verify stable output and section ordering across repeated normalization runs.",
    "- **description**: Implement this as needed.",
  );
  const doc = parsePlanDocument(markdown);
  assert.throws(() => validatePlanDocument(doc), /description is too vague/);
});

test("validatePlanDocument rejects dependency ordering violations", () => {
  const parsed = parsePlanDocument(validPlanMarkdown());
  const swapped: PlanDocument = {
    ...parsed,
    tasks: [parsed.tasks[1]!, parsed.tasks[0]!],
  };

  assert.throws(
    () => validatePlanDocument(swapped),
    /depends on 001, but appears before it in PLAN\.md/,
  );
});
