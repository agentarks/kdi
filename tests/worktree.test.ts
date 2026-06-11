import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree } from "../src/worktree";

let tempDir: string;
let repoDir: string;

function git(args: string[], cwd?: string) {
  execFileSync("git", args, { cwd: cwd || repoDir, stdio: "pipe" });
}

describe("worktree", () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kdi-worktree-test-"));
    repoDir = join(tempDir, "repo");

    // Create a temp git repo
    mkdirSync(repoDir, { recursive: true });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test User"]);
    git(["commit", "--allow-empty", "-m", "initial commit"]);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("createWorktree creates a worktree branch", () => {
    const worktreePath = createWorktree(repoDir, "default", "task-001");

    // Verify the worktree directory exists
    expect(existsSync(worktreePath)).toBe(true);

    // Verify .git is a file (not directory) for worktrees
    const gitPath = join(worktreePath, ".git");
    expect(existsSync(gitPath)).toBe(true);
    expect(lstatSync(gitPath).isFile()).toBe(true);

    // Clean up
    removeWorktree(repoDir, "default", "task-001");
  });

  it("branch name is wt/<profile>/<taskId>", () => {
    createWorktree(repoDir, "default", "task-002");

    const branches = execFileSync("git", ["branch", "-a"], { cwd: repoDir, encoding: "utf-8", stdio: "pipe" });
    expect(branches).toContain("wt/default/task-002");

    removeWorktree(repoDir, "default", "task-002");
  });

  it("removeWorktree cleans up branch and worktree", () => {
    const worktreePath = createWorktree(repoDir, "default", "task-003");

    // Verify it exists before removal
    expect(existsSync(worktreePath)).toBe(true);

    const result = removeWorktree(repoDir, "default", "task-003");
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.found).toBe(true);

    // Verify worktree directory is removed
    expect(existsSync(worktreePath)).toBe(false);

    // Verify branch is removed
    const branches = execFileSync("git", ["branch", "-a"], { cwd: repoDir, encoding: "utf-8", stdio: "pipe" });
    expect(branches).not.toContain("wt/default/task-003");
  });

  it("falls back to HEAD when base ref does not exist", () => {
    const worktreePath = createWorktree(repoDir, "default", "task-004", "nonexistent-branch");

    expect(existsSync(worktreePath)).toBe(true);
    expect(lstatSync(join(worktreePath, ".git")).isFile()).toBe(true);

    removeWorktree(repoDir, "default", "task-004");
  });

  it("creates worktree from custom base ref", () => {
    // Create a feature branch from the initial commit
    git(["checkout", "-b", "feature-branch"]);
    const featureFile = join(repoDir, "feature.txt");
    writeFileSync(featureFile, "feature content");
    git(["add", "feature.txt"]);
    git(["commit", "-m", "add feature"]);

    // Create worktree from the feature branch
    const worktreePath = createWorktree(repoDir, "default", "task-004b", "feature-branch");

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "feature.txt"))).toBe(true);

    // Verify the worktree branch points to the feature branch's commit
    const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" }).trim();
    const featureHead = execFileSync("git", ["rev-parse", "feature-branch"], { cwd: repoDir, encoding: "utf-8", stdio: "pipe" }).trim();
    expect(worktreeHead).toBe(featureHead);

    removeWorktree(repoDir, "default", "task-004b");

    // Clean up: go back to main branch and delete feature branch
    git(["checkout", "main"]);
    git(["branch", "-D", "feature-branch"]);
  });

  it("removeWorktree is idempotent (calling twice does not throw)", () => {
    createWorktree(repoDir, "default", "task-005");

    // First removal should succeed
    const firstResult = removeWorktree(repoDir, "default", "task-005");
    expect(firstResult.worktreeRemoved).toBe(true);
    expect(firstResult.branchDeleted).toBe(true);
    expect(firstResult.found).toBe(true);

    // Second removal should not throw and report nothing found
    const secondResult = removeWorktree(repoDir, "default", "task-005");
    expect(secondResult.worktreeRemoved).toBe(false);
    expect(secondResult.branchDeleted).toBe(false);
    expect(secondResult.found).toBe(false);
  });

  it("rejects invalid profile/taskId characters", () => {
    expect(() => createWorktree(repoDir, "bad;profile", "task-006")).toThrow("profile must be alphanumeric");
    expect(() => createWorktree(repoDir, "default", "bad task")).toThrow("taskId must be alphanumeric");
  });
});
