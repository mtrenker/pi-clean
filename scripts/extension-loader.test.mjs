import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(import.meta.dirname, "..");
const extensionPaths = [
  "extensions/agent-guard/index.ts",
  "extensions/browser/index.ts",
  "extensions/flightdeck/index.ts",
  "extensions/harness-delegate/index.ts",
].map((path) => resolve(packageRoot, path));

test("all shipped extensions load with the current Pi extension loader", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-clean-extension-loader-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: packageRoot,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: extensionPaths,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      new Set(result.extensions.map((extension) => extension.resolvedPath)),
      new Set(extensionPaths),
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
