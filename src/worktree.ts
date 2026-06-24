import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VALID_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validateId(label: string, value: string): void {
  if (!VALID_ID_RE.test(value)) {
    throw new Error(`${label} must be alphanumeric (may include hyphens/underscores). Got: ${value}`);
  }
}

export function createWorktree(
  repoDir: string,
  profile: string,
  taskId: string,
  baseRef = "origin/main",
): string {
  validateId("profile", profile);
  validateId("taskId", taskId);

  const branchName = `wt/${profile}/${taskId}`;

  // Determine the base ref to branch from
  let resolvedBaseRef: string;
  try {
    execFileSync("git", ["rev-parse", "--verify", baseRef], { cwd: repoDir, stdio: "pipe" });
    resolvedBaseRef = baseRef;
  } catch {
    resolvedBaseRef = "HEAD";
  }

  // Create the branch
  execFileSync("git", ["branch", branchName, resolvedBaseRef], { cwd: repoDir, stdio: "pipe" });

  // Create a temp directory for the worktree
  const worktreePath = mkdtempSync(join(tmpdir(), `kdi-${profile}-${taskId}-`));

  try {
    // Add the worktree
    execFileSync("git", ["worktree", "add", worktreePath, branchName], { cwd: repoDir, stdio: "pipe" });
  } catch (error) {
    // Clean up orphaned branch and temp directory if git worktree add fails
    try {
      execFileSync("git", ["branch", "-D", branchName], { cwd: repoDir, stdio: "pipe" });
    } catch {
      // ignore branch deletion errors
    }
    rmSync(worktreePath, { recursive: true, force: true });
    throw error;
  }

  return worktreePath;
}

export interface RemoveWorktreeResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  found: boolean;
}

export function removeWorktree(
  repoDir: string,
  profile: string,
  taskId: string,
  worktreePath?: string,
): RemoveWorktreeResult {
  validateId("profile", profile);
  validateId("taskId", taskId);

  const branchName = `wt/${profile}/${taskId}`;
  let found = false;
  let worktreeRemoved = false;
  let branchDeleted = false;

  // Determine the worktree path to remove
  let resolvedPath: string | null = worktreePath ?? null;
  if (!resolvedPath) {
    try {
      const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: "pipe",
      });

      const lines = output.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("worktree ")) {
          const path = lines[i].slice(9);
          // Scan forward within this worktree block for the branch ref
          let j = i + 1;
          while (j < lines.length && lines[j].trim() !== "" && !lines[j].startsWith("worktree ")) {
            if (lines[j].includes(`refs/heads/${branchName}`)) {
              resolvedPath = path;
              break;
            }
            j++;
          }
          if (resolvedPath) break;
        }
      }
    } catch {
      // Best effort: worktree list may fail if repo is in a bad state
    }
  }

  if (resolvedPath) {
    found = true;
    try {
      execFileSync("git", ["worktree", "remove", "--force", resolvedPath], { cwd: repoDir, stdio: "pipe" });
      worktreeRemoved = true;
    } catch {
      // Worktree removal failed — branch deletion below may still succeed
    }
  }

  // Always try to delete the branch, even if worktree was not found
  try {
    execFileSync("git", ["branch", "-D", branchName], { cwd: repoDir, stdio: "pipe" });
    branchDeleted = true;
  } catch {
    // Branch may not exist (already deleted or never created)
  }

  return { worktreeRemoved, branchDeleted, found };
}
