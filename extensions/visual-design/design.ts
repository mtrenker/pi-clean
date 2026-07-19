import { readFile, writeFile } from "node:fs/promises";

export const DESIGN_SCHEMA_VERSION = 1;
export const DESIGN_NODE_TYPES = [
  "viewport",
  "section",
  "stack",
  "grid",
  "surface",
  "text",
  "button",
] as const;

export type DesignNodeType = (typeof DESIGN_NODE_TYPES)[number];
export type DesignText = { text: string; [mark: string]: unknown };
export type DesignNode = {
  id: string;
  type: DesignNodeType;
  className?: string;
  children: Array<DesignNode | DesignText>;
  [property: string]: unknown;
};
export type DesignDocument = {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  title: string;
  root: DesignNode[];
};

export type DesignMutation =
  | { action: "add"; parentId?: string; index?: number; node: unknown }
  | { action: "move"; nodeId: string; parentId?: string; index?: number }
  | { action: "remove"; nodeId: string }
  | { action: "update_text"; nodeId: string; text: string }
  | { action: "update_properties"; nodeId: string; properties: Record<string, unknown> };

export type NodeSummary = {
  id: string;
  type: DesignNodeType;
  text?: string;
};

export type DesignContextPacket = {
  kind: "visual-design-request";
  instruction: string;
  designPath: string;
  selected: BoundedDesignNode;
  context: {
    ancestors: NodeSummary[];
    children: NodeSummary[];
    siblings: NodeSummary[];
  };
};

type BoundedDesignNode = Omit<DesignNode, "children"> & {
  children: Array<NodeSummary | DesignText>;
};

type LocatedNode = {
  node: DesignNode;
  parent: DesignNode | undefined;
  siblings: DesignNode[];
  index: number;
  ancestors: DesignNode[];
};

const NODE_TYPES = new Set<string>(DESIGN_NODE_TYPES);
const CONTAINER_TYPES = new Set<DesignNodeType>([
  "viewport",
  "section",
  "stack",
  "grid",
  "surface",
]);
const TEXT_TYPES = new Set<DesignNodeType>(["text", "button"]);
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,79}$/;
const CLASS_NAME_PATTERN = /^[a-zA-Z0-9_:\-/\s]+$/;
const RESERVED_NODE_KEYS = new Set(["id", "type", "children", "__proto__", "constructor", "prototype"]);
const RESERVED_TEXT_MARKS = new Set(["id", "type", "children", "className", "__proto__", "constructor", "prototype"]);

export function parseDesign(input: string | unknown): DesignDocument {
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    throw new Error(`Invalid design JSON: ${errorMessage(error)}`);
  }

  validateDesign(value);
  return value;
}

export function validateDesign(value: unknown): asserts value is DesignDocument {
  if (!isRecord(value)) throw new Error("Design must be a JSON object");
  if (value.schemaVersion !== DESIGN_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion; expected ${DESIGN_SCHEMA_VERSION}`);
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 120) {
    throw new Error("Design title must be a non-empty string of at most 120 characters");
  }
  if (!Array.isArray(value.root) || value.root.length === 0) {
    throw new Error("Design root must contain at least one node");
  }

  const ids = new Set<string>();
  value.root.forEach((node, index) => validateNode(node, `root[${index}]`, ids));
}

function validateNode(value: unknown, path: string, ids: Set<string>): asserts value is DesignNode {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error(`${path}.id must be a stable identifier matching ${ID_PATTERN}`);
  }
  if (ids.has(value.id)) throw new Error(`Duplicate node id: ${value.id}`);
  ids.add(value.id);

  if (typeof value.type !== "string" || !NODE_TYPES.has(value.type)) {
    throw new Error(`${path}.type must be one of: ${DESIGN_NODE_TYPES.join(", ")}`);
  }
  if (
    value.className !== undefined &&
    (typeof value.className !== "string" || value.className.length > 240 || !CLASS_NAME_PATTERN.test(value.className))
  ) {
    throw new Error(`${path}.className contains unsupported characters or is too long`);
  }
  if (!Array.isArray(value.children) || value.children.length === 0) {
    throw new Error(`${path}.children must be a non-empty array`);
  }

  const type = value.type as DesignNodeType;
  if (TEXT_TYPES.has(type)) {
    value.children.forEach((child, index) => validateText(child, `${path}.children[${index}]`));
  } else if (CONTAINER_TYPES.has(type)) {
    value.children.forEach((child, index) => validateNode(child, `${path}.children[${index}]`, ids));
  }
}

function validateText(value: unknown, path: string): asserts value is DesignText {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error(`${path} must be a Plate-compatible text leaf`);
  }
  if (value.text.length > 10_000) throw new Error(`${path}.text is too long`);
  for (const [key, mark] of Object.entries(value)) {
    if (RESERVED_TEXT_MARKS.has(key)) throw new Error(`${path}.${key} is reserved for design node structure`);
    if (key !== "text" && typeof mark !== "boolean") {
      throw new Error(`${path}.${key} must be a boolean text mark`);
    }
  }
}

export async function readDesign(path: string): Promise<DesignDocument> {
  return parseDesign(await readFile(path, "utf8"));
}

export function serializeDesign(document: DesignDocument): string {
  validateDesign(document);
  return `${JSON.stringify(orderValue(document), null, 2)}\n`;
}

export async function writeDesign(path: string, document: DesignDocument): Promise<void> {
  await writeFile(path, serializeDesign(document), "utf8");
}

export function applyDesignMutation(document: DesignDocument, mutation: DesignMutation): DesignDocument {
  const next = structuredClone(document);

  switch (mutation.action) {
    case "add": {
      const node = parseNewNode(mutation.node, next);
      const destination = childList(next, mutation.parentId);
      destination.splice(normalizeIndex(mutation.index, destination.length), 0, node);
      break;
    }
    case "move": {
      const source = findNode(next, mutation.nodeId);
      if (!source) throw new Error(`Node not found: ${mutation.nodeId}`);
      if (mutation.parentId === mutation.nodeId) throw new Error("A node cannot contain itself");
      if (mutation.parentId && containsNode(source.node, mutation.parentId)) {
        throw new Error("A node cannot be moved into one of its descendants");
      }
      source.siblings.splice(source.index, 1);
      const destination = childList(next, mutation.parentId);
      destination.splice(normalizeIndex(mutation.index, destination.length), 0, source.node);
      break;
    }
    case "remove": {
      const located = findNode(next, mutation.nodeId);
      if (!located) throw new Error(`Node not found: ${mutation.nodeId}`);
      if (!located.parent && next.root.length === 1) throw new Error("Cannot remove the only root node");
      if (located.parent && located.siblings.length === 1) {
        throw new Error(`Cannot remove the only child of ${located.parent.id}; remove or replace its parent instead`);
      }
      located.siblings.splice(located.index, 1);
      break;
    }
    case "update_text": {
      const located = requiredNode(next, mutation.nodeId);
      if (!TEXT_TYPES.has(located.node.type)) {
        throw new Error(`Node ${mutation.nodeId} does not contain editable text`);
      }
      if (mutation.text.length > 10_000) throw new Error("Text is too long");
      located.node.children = [{ text: mutation.text }];
      break;
    }
    case "update_properties": {
      const located = requiredNode(next, mutation.nodeId);
      for (const [key, value] of Object.entries(mutation.properties)) {
        if (RESERVED_NODE_KEYS.has(key)) throw new Error(`Property cannot be changed: ${key}`);
        if (value === null) delete located.node[key];
        else located.node[key] = value;
      }
      break;
    }
  }

  validateDesign(next);
  return next;
}

export function createContextPacket(
  document: DesignDocument,
  designPath: string,
  selectedId: string,
  instruction: string,
): DesignContextPacket {
  const selected = findNode(document, selectedId);
  if (!selected) throw new Error(`Selected node not found: ${selectedId}`);
  const trimmedInstruction = instruction.trim();
  if (!trimmedInstruction) throw new Error("Instruction must not be empty");
  if (trimmedInstruction.length > 4_000) throw new Error("Instruction is too long");

  return {
    kind: "visual-design-request",
    instruction: trimmedInstruction,
    designPath,
    selected: {
      ...withoutChildren(selected.node),
      children: selected.node.children.slice(0, 8).map((child) =>
        isDesignNode(child) ? summarizeNode(child) : { ...child, text: child.text.slice(0, 500) },
      ),
    },
    context: {
      ancestors: selected.ancestors.slice(-4).map(summarizeNode),
      children: selected.node.children.filter(isDesignNode).slice(0, 8).map(summarizeNode),
      siblings: selected.siblings
        .slice(Math.max(0, selected.index - 3), selected.index + 4)
        .filter((node) => node.id !== selectedId)
        .slice(0, 6)
        .map(summarizeNode),
    },
  };
}

export function summarizeNode(node: DesignNode): NodeSummary {
  const text = node.children.filter(isDesignText).map((child) => child.text).join("").trim();
  return { id: node.id, type: node.type, ...(text ? { text: text.slice(0, 160) } : {}) };
}

export function findNode(document: DesignDocument, id: string): LocatedNode | undefined {
  return findInSiblings(document.root, id, []);
}

function findInSiblings(siblings: DesignNode[], id: string, ancestors: DesignNode[]): LocatedNode | undefined {
  for (let index = 0; index < siblings.length; index += 1) {
    const node = siblings[index];
    if (node.id === id) {
      return { node, parent: ancestors.at(-1), siblings, index, ancestors };
    }
    const children = CONTAINER_TYPES.has(node.type) ? node.children as DesignNode[] : [];
    const found = findInSiblings(children, id, [...ancestors, node]);
    if (found) return found;
  }
  return undefined;
}

function parseNewNode(value: unknown, document: DesignDocument): DesignNode {
  const candidate = structuredClone(value);
  if (!isRecord(candidate)) throw new Error("New node must be an object");
  const wrapper: DesignDocument = { schemaVersion: 1, title: document.title, root: [candidate as DesignNode] };
  validateDesign(wrapper);
  for (const id of collectIds(candidate as DesignNode)) {
    if (findNode(document, id)) throw new Error(`Duplicate node id: ${id}`);
  }
  return candidate as DesignNode;
}

function childList(document: DesignDocument, parentId?: string): DesignNode[] {
  if (!parentId) return document.root;
  const parent = requiredNode(document, parentId).node;
  if (!CONTAINER_TYPES.has(parent.type)) throw new Error(`Node ${parentId} cannot contain design nodes`);
  return parent.children as DesignNode[];
}

function requiredNode(document: DesignDocument, id: string): LocatedNode {
  const located = findNode(document, id);
  if (!located) throw new Error(`Node not found: ${id}`);
  return located;
}

function normalizeIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  const maximum = length;
  if (!Number.isInteger(index) || index < 0 || index > maximum) {
    throw new Error(`index must be between 0 and ${maximum}`);
  }
  return index;
}

function containsNode(node: DesignNode, id: string): boolean {
  return node.children.filter(isDesignNode).some((child) => child.id === id || containsNode(child, id));
}

function collectIds(node: DesignNode): string[] {
  return [node.id, ...node.children.filter(isDesignNode).flatMap(collectIds)];
}

function withoutChildren(node: DesignNode): Omit<DesignNode, "children"> {
  const { children: _children, ...properties } = node;
  return properties;
}

function isDesignNode(value: DesignNode | DesignText): value is DesignNode {
  return "id" in value && "type" in value && Array.isArray(value.children);
}

function isDesignText(value: DesignNode | DesignText): value is DesignText {
  return "text" in value && !("id" in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderValue);
  if (!isRecord(value)) return value;
  const priority = ["schemaVersion", "title", "root", "id", "type", "className", "text"];
  const keys = Object.keys(value).sort((left, right) => {
    if (left === right) return 0;
    if (left === "children" || right === "children") return left === "children" ? 1 : -1;
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? priority.length : leftIndex) - (rightIndex === -1 ? priority.length : rightIndex);
    }
    return left.localeCompare(right);
  });
  return Object.fromEntries(keys.map((key) => [key, orderValue(value[key])]));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
