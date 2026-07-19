import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

let cachedAssets: Promise<{ clientScript: string; styleSheet: string }> | undefined;

export function buildClientAssets(): Promise<{ clientScript: string; styleSheet: string }> {
  cachedAssets ??= compileAssets().catch((error) => {
    cachedAssets = undefined;
    throw error;
  });
  return cachedAssets;
}

async function compileAssets(): Promise<{ clientScript: string; styleSheet: string }> {
  const clientPath = fileURLToPath(new URL("./client.tsx", import.meta.url));
  const stylePath = fileURLToPath(new URL("./styles.css", import.meta.url));
  const result = await build({
    entryPoints: [clientPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": "\"production\"" },
    minify: true,
    legalComments: "none",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Could not build the visual design browser client");
  return {
    clientScript: output.text,
    styleSheet: await readFile(stylePath, "utf8"),
  };
}
