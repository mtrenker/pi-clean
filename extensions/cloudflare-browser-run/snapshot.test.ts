/**
 * Snapshot and ref tests - DESIGN.md section 8.3.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRunError } from "./errors.ts";
import {
  assertRef,
  extractRefs,
  formatOrientation,
  interactiveLines,
  orientationExcerpt,
  refSelector,
} from "./snapshot.ts";

const SNAPSHOT = [
  "- generic:",
  '  - heading "Jobs" [level=1]',
  '  - searchbox "Query" [ref=e1]',
  '  - button "Search" [ref=e2]',
  '  - link "Result one" [ref=e3]',
  '  - link "Result two" [ref=e4]',
  '  - link "Result three" [ref=e5]',
  "  - text: no refs here",
].join("\n");

test("refs are validated before they reach a selector", () => {
  assert.equal(assertRef("e12"), "e12");
  assert.equal(assertRef("  e3  "), "e3");
  assert.equal(refSelector("e3"), "aria-ref=e3");

  for (const bad of ["", "e", "e-1", "button", "e1 >> nth=0", "*", "e1'", "E1"]) {
    assert.throws(
      () => assertRef(bad),
      (error: unknown) =>
        error instanceof BrowserRunError &&
        error.errorClass === "invalid_request" &&
        /is not a snapshot ref/.test(error.detail),
      JSON.stringify(bad),
    );
  }
});

test("refs and interactive lines are extracted in document order", () => {
  assert.deepEqual(extractRefs(SNAPSHOT), ["e1", "e2", "e3", "e4", "e5"]);
  assert.equal(interactiveLines(SNAPSHOT).length, 5);
  assert.deepEqual(extractRefs("- text: nothing"), []);
});

test("orientation centers the excerpt on the acted-on element", () => {
  const many = Array.from({ length: 40 }, (_, index) => `- link "Item ${index}" [ref=e${index}]`).join("\n");

  const around = orientationExcerpt(many, { aroundRef: "e20" });
  const refs = extractRefs(around);
  assert.equal(refs.length, 12);
  assert.ok(refs.includes("e20"), "the acted-on element is present");
  assert.equal(refs[0], "e14");

  const head = orientationExcerpt(many);
  assert.deepEqual(extractRefs(head).slice(0, 3), ["e0", "e1", "e2"]);

  // An anchor near the end stays inside the list rather than running past it.
  const tail = orientationExcerpt(many, { aroundRef: "e39" });
  assert.equal(extractRefs(tail).length, 12);
  assert.ok(extractRefs(tail).includes("e39"));
});

test("a short page returns every interactive line and no excerpt for a plain page", () => {
  assert.equal(orientationExcerpt(SNAPSHOT).split("\n").length, 5);
  assert.equal(orientationExcerpt("- text: nothing"), "");
  assert.equal(orientationExcerpt("", { aroundRef: "e1" }), "");
});

test("an unknown anchor falls back to the head of the list", () => {
  const many = Array.from({ length: 30 }, (_, index) => `- link "Item ${index}" [ref=e${index}]`).join("\n");
  assert.deepEqual(extractRefs(orientationExcerpt(many, { aroundRef: "e999" }))[0], "e0");
});

test("formatted orientation states the page, navigation, and element count", () => {
  const text = formatOrientation({
    url: "https://example.com/jobs",
    title: "Jobs",
    navigated: true,
    excerpt: '- button "Search" [ref=e2]',
    refCount: 5,
  });
  assert.match(text, /^url: https:\/\/example\.com\/jobs$/m);
  assert.match(text, /^title: Jobs$/m);
  assert.match(text, /^navigated: yes$/m);
  assert.match(text, /^interactive elements: 5$/m);
  assert.match(text, /\[ref=e2\]/);

  const untitled = formatOrientation({
    url: "about:blank",
    title: "",
    navigated: false,
    excerpt: "",
    refCount: 0,
  });
  assert.match(untitled, /title: \(untitled\)/);
  assert.match(untitled, /navigated: no/);
});
