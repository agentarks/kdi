import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Create a temporary git repo with an empty initial commit and an
 * origin/main ref so worktree base-ref resolution matches real cloned repos.
 */
export function setupTempGitRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "kdi-test-repo-"));
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir, stdio: "pipe" });
  return repoDir;
}
