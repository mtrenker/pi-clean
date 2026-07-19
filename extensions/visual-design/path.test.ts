import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { resolveDesignPath } from "./path.ts";

test("design paths must be existing .design.json files inside the canonical repository root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "visual-design-root-"));
  const outside = await mkdtemp(join(tmpdir(), "visual-design-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const valid = join(root, "valid.design.json");
  const dottedName = join(root, "..concept.design.json");
  const wrongExtension = join(root, "notes.json");
  const outsideFile = join(outside, "outside.design.json");
  await Promise.all([
    writeFile(valid, "{}", "utf8"),
    writeFile(dottedName, "{}", "utf8"),
    writeFile(wrongExtension, "{}", "utf8"),
    writeFile(outsideFile, "{}", "utf8"),
  ]);

  assert.equal(await resolveDesignPath(root, "valid.design.json"), valid);
  assert.equal(await resolveDesignPath(root, "@valid.design.json"), valid);
  assert.equal(await resolveDesignPath(root, "..concept.design.json"), dottedName);
  await assert.rejects(() => resolveDesignPath(root, "notes.json"), /must end in \.design\.json/);
  await assert.rejects(
    () => resolveDesignPath(root, `../${basename(outside)}/outside.design.json`),
    /must stay inside/,
  );
  await assert.rejects(() => resolveDesignPath(root, outsideFile), /must stay inside/);

  const escapedLink = join(root, "escaped.design.json");
  await symlink(outsideFile, escapedLink);
  await assert.rejects(() => resolveDesignPath(root, "escaped.design.json"), /must stay inside/);
});
