#!/usr/bin/env node

import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const outputRoot = mkdtempSync(join(tmpdir(), "pi-clean-flightdeck-tests-"));

try {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [
    tsc,
    "--project",
    join(root, "tsconfig.flightdeck-tests.json"),
    "--outDir",
    outputRoot,
  ]);

  // The project intentionally keeps CommonJS .github scripts. Scope ESM only
  // to the temporary compiled test tree.
  writeFileSync(join(outputRoot, "package.json"), '{"type":"module"}\n', "utf8");
  symlinkSync(join(root, "node_modules"), join(outputRoot, "node_modules"), "dir");

  const testDir = join(outputRoot, "flightdeck");
  const tests = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(testDir, name));
  if (tests.length === 0) throw new Error("no compiled Flightdeck tests found");
  run(process.execPath, ["--test", ...tests]);
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
