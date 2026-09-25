import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDesign, serializeDesign, type DesignContextPacket } from "./design.ts";
import { VisualDesignServer, type BrowserPrompt } from "./server.ts";

const exampleUrl = new URL("../../designs/example.design.json", import.meta.url);

async function fixture(t: test.TestContext, onPrompt: (prompt: BrowserPrompt) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-design-server-"));
  const designPath = join(root, "example.design.json");
  await copyFile(exampleUrl, designPath);
  const server = new VisualDesignServer({
    root,
    designPath,
    token: "test-capability",
    clientScript: "console.log('client')",
    styleSheet: "body{}",
    onPrompt,
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = (path: string, authorized = true) => {
    const url = new URL(path, server.url);
    if (authorized) url.searchParams.set("token", server.token);
    return url;
  };
  return { root, designPath, server, endpoint };
}

test("server binds to loopback and protects every browser resource with a capability", async (t) => {
  const { server, endpoint } = await fixture(t);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

  const forbidden = await fetch(endpoint("/api/design", false));
  assert.equal(forbidden.status, 403);

  const page = await fetch(endpoint("/"));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /styles\.css\?token=test-capability/);

  const payload = await fetch(endpoint("/api/design")).then((response) => response.json()) as { path: string };
  assert.equal(payload.path, "example.design.json");
});

test("browser request carries selected structural context and explicit busy behavior", async (t) => {
  let received: BrowserPrompt | undefined;
  const { endpoint } = await fixture(t, (prompt) => { received = prompt; });

  const response = await fetch(endpoint("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedId: "hero-title",
      instruction: "Make the headline more neighborly",
      behavior: "steer",
    }),
  });

  assert.equal(response.status, 202);
  assert.equal(received?.behavior, "steer");
  const packet = received?.packet as DesignContextPacket;
  assert.equal(packet.selected.id, "hero-title");
  assert.equal(packet.instruction, "Make the headline more neighborly");
  assert.equal(packet.context.ancestors.at(-1)?.id, "hero-copy");

  const controller = new AbortController();
  const events = await fetch(endpoint("/events"), { signal: controller.signal });
  const replay = await readUntil(events.body!.getReader(), '"type":"history"');
  controller.abort();
  assert.match(replay, /Make the headline more neighborly/);
  assert.match(replay, /steer request accepted/);
});

test("SSE client observes validated mutations persisted through the single store path", async (t) => {
  const { server, designPath, endpoint } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(endpoint("/events"), { signal: controller.signal });
  const reader = response.body!.getReader();
  await readUntil(reader, '"source":"initial"');

  await server.store.mutate({ action: "update_text", nodeId: "hero-title", text: "The table is set nearby." });
  const update = await readUntil(reader, '"source":"mutation"');
  controller.abort();

  assert.match(update, /The table is set nearby/);
  assert.match(await readFile(designPath, "utf8"), /The table is set nearby/);
});

test("external file changes refresh clients and malformed edits report an error without stopping the server", async (t) => {
  const { designPath, endpoint } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(endpoint("/events"), { signal: controller.signal });
  const reader = response.body!.getReader();
  await readUntil(reader, '"source":"initial"');

  await writeFile(designPath, "{ not-json", "utf8");
  const error = await readUntil(reader, '"type":"design-error"', 2_000);
  assert.match(error, /Invalid design JSON/);

  const recovered = parseDesign(await readFile(exampleUrl, "utf8"));
  recovered.title = "Recovered design";
  await writeFile(designPath, serializeDesign(recovered), "utf8");
  const update = await readUntil(reader, '"source":"external"', 2_000);
  controller.abort();

  assert.match(update, /Recovered design/);
  const designResponse = await fetch(endpoint("/api/design"));
  assert.equal(designResponse.status, 200);
});

function answerRequest(server: VisualDesignServer, endpoint: (path: string) => URL, body: unknown, headers: Record<string, string> = {}) {
  return fetch(endpoint("/api/answer"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(server.url).origin, ...headers },
    body: JSON.stringify(body),
  });
}

test("an inline answer with anchored notes resolves only the asking call, once", async (t) => {
  const { server, endpoint } = await fixture(t);
  const controller = new AbortController();
  const events = await fetch(endpoint("/events"), { signal: controller.signal });
  const reader = events.body!.getReader();
  await readUntil(reader, '"type":"history"');

  const asked = server.ask({ question: "Which date card tone?", anchorId: "next-table-card", choices: ["Paper", "Signal"] });
  const shown = await readUntil(reader, '"status":"waiting"');
  const state = JSON.parse(shown.split("data: ").find((line) => line.includes('"status":"waiting"'))!).state;
  controller.abort();

  const wrongRequest = await answerRequest(server, endpoint, { ...state, requestId: "guess", outcome: "answered", choice: "Paper" });
  assert.equal(wrongRequest.status, 409);

  const response = await answerRequest(server, endpoint, {
    requestId: state.requestId,
    revision: state.revision,
    outcome: "answered",
    choice: "Signal",
    answer: "Keep it loud",
    notes: [{ nodeId: "next-date", text: "Bigger date" }],
  });
  assert.equal(response.status, 200);
  const { question, response: result } = await asked;
  assert.equal(question.requestId, state.requestId);
  assert.deepEqual(result, { outcome: "answered", choice: "Signal", answer: "Keep it loud", notes: [{ nodeId: "next-date", text: "Bigger date" }] });

  const duplicate = await answerRequest(server, endpoint, { requestId: state.requestId, revision: state.revision, outcome: "answered", choice: "Paper" });
  assert.equal(duplicate.status, 409);
});

test("answer endpoint requires same-origin JSON and rejects invalid responses without resolving", async (t) => {
  const { server, endpoint } = await fixture(t);
  let settled = false;
  const asked = server.ask({ question: "Ship this?", anchorId: "hero-copy" }).then((value) => { settled = true; return value; });
  const { requestId, revision } = currentQuestion(server);

  const noOrigin = await fetch(endpoint("/api/answer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, revision, outcome: "answered", answer: "yes" }),
  });
  assert.equal(noOrigin.status, 403);
  const crossOrigin = await answerRequest(server, endpoint, { requestId, revision, outcome: "answered", answer: "yes" }, { Origin: "http://evil.test" });
  assert.equal(crossOrigin.status, 403);
  const rebound = await new Promise<number>((resolve, reject) => {
    const target = endpoint("/api/answer");
    const outgoing = request(target, {
      method: "POST",
      headers: { Host: "attacker.test", Origin: "http://attacker.test", "Content-Type": "application/json" },
    }, (incoming) => { incoming.resume(); resolve(incoming.statusCode ?? 0); });
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify({ requestId, revision, outcome: "answered", answer: "yes" }));
  });
  assert.equal(rebound, 403);
  const wrongType = await answerRequest(server, endpoint, { requestId, revision, outcome: "answered", answer: "yes" }, { "Content-Type": "text/plain" });
  assert.equal(wrongType.status, 415);
  const unknownNode = await answerRequest(server, endpoint, { requestId, revision, outcome: "revise", notes: [{ nodeId: "nope", text: "x" }] });
  assert.equal(unknownNode.status, 400);
  const empty = await answerRequest(server, endpoint, { requestId, revision, outcome: "answered" });
  assert.equal(empty.status, 400);
  const chat = await fetch(endpoint("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedId: "hero-title", instruction: "Change it", behavior: "followUp" }),
  });
  assert.equal(chat.status, 409);
  assert.equal(settled, false);

  // A dismissal succeeds even when a stale client still sends an oversized, invalid draft.
  const dismissed = await answerRequest(server, endpoint, {
    requestId,
    revision,
    outcome: "cancelled",
    answer: "x".repeat(8_000),
    notes: [{ nodeId: "nope", text: "y" }],
  });
  assert.equal(dismissed.status, 200);
  assert.deepEqual((await asked).response, { outcome: "cancelled", reason: "operator", notes: [] });
});

test("external edits, mutations, abort, and stop cancel a waiting question and make answers stale", async (t) => {
  const { server, designPath, endpoint } = await fixture(t);

  const external = server.ask({ question: "Like it?", anchorId: "hero-copy" });
  const stale = currentQuestion(server);
  const edited = parseDesign(await readFile(designPath, "utf8"));
  edited.title = "Edited elsewhere";
  await writeFile(designPath, serializeDesign(edited), "utf8");
  assert.equal((await external).response.reason, "document-changed");
  const late = await answerRequest(server, endpoint, { ...stale, outcome: "answered", answer: "yes" });
  assert.equal(late.status, 409);

  const mutated = server.ask({ question: "Like it?", anchorId: "hero-copy" });
  await server.store.mutate({ action: "update_text", nodeId: "hero-title", text: "Changed by a parallel call" });
  assert.equal((await mutated).response.reason, "document-changed");

  const controller = new AbortController();
  const aborted = server.ask({ question: "Like it?", anchorId: "hero-copy" }, controller.signal);
  assert.throws(() => server.ask({ question: "Second?", anchorId: "hero-copy" }), /already waiting/);
  controller.abort();
  assert.equal((await aborted).response.reason, "aborted");

  const stopped = server.ask({ question: "Like it?", anchorId: "hero-copy" });
  await server.stop();
  assert.equal((await stopped).response.reason, "relay-stopped");
});

function currentQuestion(server: VisualDesignServer): { requestId: string; revision: string } {
  const state = (server as unknown as { questionState?: { requestId: string; revision: string } }).questionState;
  assert.ok(state, "question should be waiting");
  return { requestId: state.requestId, revision: state.revision };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  match: string,
  timeout = 1_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let content = "";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${match}`)), remaining)),
    ]);
    if (result.done) break;
    content += new TextDecoder().decode(result.value);
    if (content.includes(match)) return content;
  }
  throw new Error(`Stream ended before ${match}: ${content}`);
}
