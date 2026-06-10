import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createWorktree, removeWorktree } from "../src/worktree";

let tempDir: string;
let repoDir: string;

function git(args: string, cwd?: string) {
  execSync(`git ${args}`, { cwd: cwd || repoDir });
}

describe("worktree", () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kdi-worktree-test-"));
    repoDir = join(tempDir, "repo");

    // Create a temp git repo
    execSync(`mkdir -p ${repoDir}`);
    git("init");
    git("config user.email 'test@test.com'");
    git("config user.name 'Test User'");
    git("commit --allow-empty -m 'initial commit'");
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("createWorktree creates a worktree branch", () => {
    const worktreePath = createWorktree(repoDir, "default", "task-001");

    // Verify the worktree directory exists
    expect(existsSync(worktreePath)).toBe(true);

    // Verify .git file exists in worktree (not a directory)
    expect(existsSync(join(worktreePath, ".git"))).toBe(true);

    // Clean up
    removeWorktree(repoDir, "default", "task-001");
  });

  it("branch name is wt/<profile>/<taskId>", () => {
    createWorktree(repoDir, "default", "task-002");

    const branches = execSync("git branch -a", { cwd: repoDir, encoding: "utf-8" });
    expect(branches).toContain("wt/default/task-002");

    removeWorktree(repoDir, "default", "task-002");
  });

  it("removeWorktree cleans up branch and worktree", () => {
    const worktreePath = createWorktree(repoDir, "default", "task-003");

    // Verify it exists before removal
    expect(existsSync(worktreePath)).toBe(true);

    removeWorktree(repoDir, "default", "task-003");

    // Verify worktree directory is removed
    expect(existsSync(worktreePath)).toBe(false);

    // Verify branch is removed
    const branches = execSync("git branch -a", { cwd: repoDir, encoding: "utf-8" });
    expect(branches).not.toContain("wt/default/task-003");
  });
});
