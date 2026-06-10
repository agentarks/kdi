import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createWorktree(
  repoDir: string,
  profile: string,
  taskId: string,
  baseRef = "origin/main",
): string {
  const branchName = `wt/${profile}/${taskId}`;

  // Determine the base ref to branch from
  let resolvedBaseRef: string;
  try {
    execSync(`git rev-parse --verify ${baseRef}`, { cwd: repoDir, stdio: "pipe" });
    resolvedBaseRef = baseRef;
  } catch {
    resolvedBaseRef = "HEAD";
  }

  // Create the branch
  execSync(`git branch ${branchName} ${resolvedBaseRef}`, { cwd: repoDir });

  // Create a temp directory for the worktree
  const worktreePath = mkdtempSync(join(tmpdir(), `kdi-${profile}-${taskId}-`));

  // Add the worktree
  execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir });

  return worktreePath;
}

export function removeWorktree(
  repoDir: string,
  profile: string,
  taskId: string,
): void {
  const branchName = `wt/${profile}/${taskId}`;

  // Find the worktree path from the branch name
  let worktreePath: string | null = null;
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
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
    // No worktrees or git error
  }

  // Remove the worktree
  if (worktreePath) {
    try {
      execSync(`git worktree remove "${worktreePath}"`, { cwd: repoDir });
    } catch {
      // Worktree might already be removed or not exist
    }
  }

  // Delete the branch
  try {
    execSync(`git branch -D ${branchName}`, { cwd: repoDir });
  } catch {
    // Branch might already be deleted
  }
}
