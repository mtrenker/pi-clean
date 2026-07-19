import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
