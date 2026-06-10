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

export function removeWorktree(
  repoDir: string,
  profile: string,
  taskId: string,
): boolean {
  validateId("profile", profile);
  validateId("taskId", taskId);

  const branchName = `wt/${profile}/${taskId}`;
  let success = true;

  // Find the worktree path from the branch name
  let worktreePath: string | null = null;
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
        // Check if the branch line contains our branch (as refs/heads/branchName)
        if (i + 2 < lines.length && lines[i + 2].includes(`refs/heads/${branchName}`)) {
          worktreePath = path;
          break;
        }
      }
    }
  } catch {
    success = false;
  }

  // Remove the worktree
  if (worktreePath) {
    try {
      execFileSync("git", ["worktree", "remove", worktreePath], { cwd: repoDir, stdio: "pipe" });
    } catch {
      success = false;
    }
  }

  // Delete the branch
  try {
    execFileSync("git", ["branch", "-D", branchName], { cwd: repoDir, stdio: "pipe" });
  } catch {
    success = false;
  }

  return success;
}
