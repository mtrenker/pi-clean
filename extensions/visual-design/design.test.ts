import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyDesignMutation,
  createContextPacket,
  findNode,
  parseDesign,
  serializeDesign,
  type DesignDocument,
  type DesignNode,
} from "./design.ts";

const exampleUrl = new URL("../../designs/example.design.json", import.meta.url);

async function example(): Promise<DesignDocument> {
  return parseDesign(await readFile(exampleUrl, "utf8"));
}

function textNode(id: string, text: string): DesignNode {
  return { id, type: "text", children: [{ text }] };
}

test("the example is valid Plate-compatible JSON and serializes deterministically", async () => {
  const design = await example();
  const first = serializeDesign(design);
  const second = serializeDesign(parseDesign(first));

  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.equal(findNode(design, "hero-title")?.node.type, "text");
});

test("validation rejects duplicate IDs, malformed leaves, and unknown classes", async () => {
  const design = await example();
  const duplicate = structuredClone(design);
  (findNode(duplicate, "hero-body")!.node as DesignNode).id = "hero-title";
  assert.throws(() => parseDesign(duplicate), /Duplicate node id/);

  const malformed = structuredClone(design);
  findNode(malformed, "hero-title")!.node.children = [{ text: 42 } as never];
  assert.throws(() => parseDesign(malformed), /Plate-compatible text leaf/);

  const badClass = structuredClone(design);
  findNode(badClass, "hero-section")!.node.className = "safe<script>";
  assert.throws(() => parseDesign(badClass), /className contains unsupported/);

  const structuralMark = structuredClone(design);
  findNode(structuralMark, "hero-title")!.node.children = [{ text: "hello", id: true }];
  assert.throws(() => parseDesign(structuralMark), /reserved for design node structure/);
});

test("add preserves existing IDs and rejects duplicate IDs", async () => {
  const design = await example();
  const next = applyDesignMutation(design, {
    action: "add",
    parentId: "hero-copy",
    index: 1,
    node: textNode("hero-note", "One night only"),
  });

  assert.equal(findNode(next, "hero-note")?.index, 1);
  assert.equal(findNode(next, "hero-title")?.node.id, "hero-title");
  assert.throws(
    () => applyDesignMutation(next, { action: "add", parentId: "hero-copy", node: textNode("hero-title", "Duplicate") }),
    /Duplicate node id/,
  );
});

test("move resolves stable IDs at mutation time and prevents cycles", async () => {
  const design = await example();
  const next = applyDesignMutation(design, {
    action: "move",
    nodeId: "hero-action",
    parentId: "next-table-card",
    index: 1,
  });

  assert.equal(findNode(next, "hero-action")?.parent?.id, "next-table-card");
  assert.equal(findNode(next, "hero-action")?.index, 1);
  assert.throws(
    () => applyDesignMutation(next, { action: "move", nodeId: "hero-layout", parentId: "hero-copy" }),
    /descendants/,
  );
});

test("remove, text change, and property change validate the resulting document", async () => {
  let design = await example();
  design = applyDesignMutation(design, { action: "remove", nodeId: "principle-return" });
  assert.equal(findNode(design, "principle-return"), undefined);
  assert.throws(
    () => applyDesignMutation(design, { action: "remove", nodeId: "principles-stack" }),
    /Cannot remove the only child of principles-section/,
  );

  design = applyDesignMutation(design, { action: "update_text", nodeId: "hero-title", text: "Dinner starts nearby." });
  assert.deepEqual(findNode(design, "hero-title")?.node.children, [{ text: "Dinner starts nearby." }]);

  design = applyDesignMutation(design, {
    action: "update_properties",
    nodeId: "hero-section",
    properties: { tone: "paper", className: "pad-none" },
  });
  assert.equal(findNode(design, "hero-section")?.node.tone, "paper");
  assert.equal(findNode(design, "hero-section")?.node.className, "pad-none");
  design = applyDesignMutation(design, {
    action: "update_properties",
    nodeId: "hero-section",
    properties: { className: "pad-lg bg-gradient-ink-signal" },
  });
  assert.equal(findNode(design, "hero-section")?.node.className, "pad-lg bg-gradient-ink-signal");
  assert.throws(
    () => applyDesignMutation(design, {
      action: "update_properties",
      nodeId: "hero-section",
      properties: { className: "invented-gradient" },
    }),
    /Unsupported className: invented-gradient/,
  );
  assert.throws(
    () => applyDesignMutation(design, { action: "update_properties", nodeId: "hero-title", properties: { id: "new-id" } }),
    /cannot be changed/,
  );
  const unsafeProperties = Object.create(null) as Record<string, unknown>;
  unsafeProperties.__proto__ = { polluted: true };
  assert.throws(
    () => applyDesignMutation(design, { action: "update_properties", nodeId: "hero-title", properties: unsafeProperties }),
    /cannot be changed/,
  );
});

test("context packets include bounded structural context rather than Slate paths", async () => {
  const design = await example();
  const packet = createContextPacket(design, "designs/example.design.json", "principle-share", "Make this warmer");

  assert.equal(packet.selected.id, "principle-share");
  assert.equal(packet.designPath, "designs/example.design.json");
  assert.deepEqual(packet.context.ancestors.map((node) => node.id), [
    "site-viewport",
    "principles-section",
    "principles-stack",
    "principles-grid",
  ]);
  assert.deepEqual(packet.context.children.map((node) => node.id), ["principle-share-title", "principle-share-copy"]);
  assert.equal(packet.context.siblings.some((node) => node.id === "principle-bring"), true);
  assert.equal("path" in packet.selected, false);
});
