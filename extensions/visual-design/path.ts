import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveDesignPath(root: string, requestedPath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(resolve(canonicalRoot, requestedPath.replace(/^@/, "")));
  const relation = relative(canonicalRoot, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("Design path must stay inside the current repository");
  }
  if (!candidate.endsWith(".design.json")) throw new Error("Design path must end in .design.json");
  return candidate;
}
