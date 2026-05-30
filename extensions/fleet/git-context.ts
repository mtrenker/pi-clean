// Fleet extension — best-effort git project context capture

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitContext {
  /** Absolute path to the git repo root, or null if not in a git repo. */
  repoRoot: string | null;
  /** First remote URL (typically "origin"), or null if none / not a git repo. */
  remote: string | null;
  /** Current branch name, or null if detached HEAD / not a git repo. */
  branch: string | null;
  /** Absolute path to the current worktree, or null if not in a git worktree. */
  worktreePath: string | null;
  /** HEAD commit SHA (full 40-char), or null if not available. */
  headSha: string | null;
  /** Whether there were uncommitted changes at capture time. Null if undetermined. */
  dirtyAtStart: boolean | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function run(
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", args, { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Gather best-effort git metadata about the project at `cwd`.
 * Never throws; any field that cannot be determined is set to `null`.
 * Returns a `warnings` array for any partial failures.
 */
export async function captureGitContext(
  cwd: string,
): Promise<{ git: GitContext; warnings: string[] }> {
  const warnings: string[] = [];

  // First, verify we're inside a git work tree.
  const insideWorkTree = await run(["rev-parse", "--is-inside-work-tree"], cwd);
  if (insideWorkTree !== "true") {
    warnings.push(
      `[fleet/run] git context unavailable: "${cwd}" is not inside a git work tree. Run metadata will have null git fields.`,
    );
    return {
      git: {
        repoRoot: null,
        remote: null,
        branch: null,
        worktreePath: null,
        headSha: null,
        dirtyAtStart: null,
      },
      warnings,
    };
  }

  const [repoRoot, worktreePath, headSha, branchRaw, remoteRaw, statusRaw] =
    await Promise.all([
      run(["rev-parse", "--show-toplevel"], cwd),
      run(["rev-parse", "--show-toplevel"], cwd), // worktree path == repo root for non-linked worktrees
      run(["rev-parse", "HEAD"], cwd),
      run(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
      run(["remote", "get-url", "origin"], cwd),
      run(["status", "--porcelain"], cwd),
    ]);

  // "HEAD" means detached HEAD — report as null branch
  const branch = branchRaw === "HEAD" ? null : branchRaw;

  // statusRaw is null when git status returned nothing (clean) or git failed.
  // An empty string from git status --porcelain means clean; null means git error.
  let dirtyAtStart: boolean | null = null;
  if (statusRaw !== null) {
    dirtyAtStart = statusRaw.length > 0;
  } else {
    // Could not determine — git may have failed; check whether HEAD is valid
    if (headSha !== null) {
      // git is available but status failed; treat as unknown
      warnings.push("[fleet/run] Could not determine dirty state via git status --porcelain.");
    }
  }

  // Attempt to get the actual worktree path (for linked worktrees, git worktree list output differs)
  const worktreeListRaw = await run(["worktree", "list", "--porcelain"], cwd);
  let resolvedWorktreePath = worktreePath;
  if (worktreeListRaw) {
    // Parse the first worktree block — that's the main worktree. Current worktree
    // is the one whose "worktree" line matches the repoRoot or cwd.
    const lines = worktreeListRaw.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const candidate = line.slice("worktree ".length).trim();
        // Use the worktree whose path normalizes to cwd (linked worktree) or falls back to repoRoot
        if (candidate && cwd.startsWith(candidate)) {
          resolvedWorktreePath = candidate;
          break;
        }
      }
    }
  }

  return {
    git: {
      repoRoot,
      remote: remoteRaw,
      branch,
      worktreePath: resolvedWorktreePath,
      headSha,
      dirtyAtStart,
    },
    warnings,
  };
}
