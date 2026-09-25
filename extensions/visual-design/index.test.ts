import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { DefaultResourceLoader, SettingsManager, type Extension } from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(import.meta.dirname, "index.ts");
const exampleUrl = new URL("../../designs/example.design.json", import.meta.url);

async function loadExtension(agentDir: string): Promise<Extension> {
  const loader = new DefaultResourceLoader({
    cwd: resolve(import.meta.dirname, "../.."),
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  return extensions[0]!;
}

test("/tree is vetoed while a question waits, so the tool result stays on the asking branch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-design-wiring-"));
  const extension = await loadExtension(root);
  const notices: Array<{ message: string; type?: string }> = [];
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    ui: { setStatus() {}, notify: (message: string, type?: string) => notices.push({ message, type }) },
    sessionManager: { getSessionId: () => "session-1", getLeafId: () => "leaf-1" },
  } as never;
  const emit = async (type: string, event: Record<string, unknown> = {}) => {
    const results = [];
    for (const handler of extension.handlers.get(type) ?? []) results.push(await handler({ type, ...event }, ctx));
    return results;
  };
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await rm(root, { recursive: true, force: true });
  });
  await copyFile(exampleUrl, join(root, "wiring.design.json"));

  await extension.commands.get("design")!.handler("wiring.design.json", ctx);
  assert.match(notices.at(-1)!.message, /relay ready/);
  assert.deepEqual(await emit("session_before_tree"), [undefined]);

  const controller = new AbortController();
  let settled = false;
  const asking = extension.tools.get("visual_design_ask")!.definition
    .execute("call-1", { question: "Tone?", anchorId: "hero-copy" }, controller.signal, undefined, ctx)
    .finally(() => { settled = true; });

  assert.deepEqual(await emit("session_before_tree"), [{ cancel: true }]);
  assert.deepEqual(notices.at(-1), {
    message: "A design question is waiting in the browser. Answer or dismiss it, or stop Pi, before using /tree.",
    type: "warning",
  });
  await emit("session_tree", { newLeafId: "leaf-2", oldLeafId: "leaf-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the question must not be resolved by tree events");

  controller.abort();
  const details = (await asking).details as { reason?: string; leafId?: string };
  assert.equal(details.reason, "aborted");
  assert.equal(details.leafId, "leaf-1");
  assert.deepEqual(await emit("session_before_tree"), [undefined]);
});
