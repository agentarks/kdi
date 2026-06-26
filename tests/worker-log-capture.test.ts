import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask, showTask } from "../src/models/task";
import { setFlag, clearOverrides } from "../src/flags";
import { spawnHarness, tick } from "../src/dispatcher";
import { getTaskLogPath } from "../src/observability";
import { cleanupDb } from "./cleanupDb";

let testDbPath: string;
let originalHome: string | undefined;

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "kdi-log-home-"));
}

describe("worker log capture", () => {
  beforeEach(() => {
    testDbPath = join(tmpdir(), `kdi-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    originalHome = process.env.HOME;
    cleanupDb(testDbPath);
    initDb(testDbPath);
    setFlag("FF_ENABLE_KANBAN_DISPATCH", true);
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    clearOverrides();
    closeDb();
    cleanupDb(testDbPath);
  });

  it("spawnHarness writes combined stdout/stderr to log file", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const logPath = join(home, ".local", "share", "kdi", "logs", "myboard", "1.log");

    try {
      const result = await spawnHarness('echo "hello stdout" && echo "hello stderr" >&2', tmpdir(), logPath);
      expect(result.exitCode).toBe(0);
      expect(existsSync(logPath)).toBe(true);
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("hello stdout");
      expect(content).toContain("hello stderr");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("spawnHarness waits for log stream flush before resolving", async () => {
    const home = makeTempHome();
    const logPath = join(home, ".local", "share", "kdi", "logs", "myboard", "large.log");
    const bun = JSON.stringify(process.execPath);
    const command = `${bun} -e 'process.stdout.write("o".repeat(5000000) + "\\n"); process.stderr.write("e".repeat(5000000) + "\\n")'`;

    try {
      const result = await spawnHarness(command, tmpdir(), logPath);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(logPath, "utf-8");
      expect(content.length).toBe(result.stdout.length + result.stderr.length);
      expect(content).toContain("o".repeat(1000));
      expect(content).toContain("e".repeat(1000));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("spawnHarness does not fail when log directory is unwritable", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const logDir = join(home, ".local", "share", "kdi", "logs", "readonly");
    const logPath = join(logDir, "1.log");
    mkdirSync(logDir, { recursive: true });
    chmodSync(logDir, 0o555);

    try {
      const result = await spawnHarness('echo "best effort"', tmpdir(), logPath);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("best effort");
      expect(existsSync(logPath)).toBe(false);
    } finally {
      chmodSync(logDir, 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dispatcher passes logPath when FF_WORKER_LOG_CAPTURE is enabled", async () => {
    setFlag("FF_WORKER_LOG_CAPTURE", true);
    const board = createBoard("log-board", "/tmp/log-board");
    const task = createTask({ board_id: board.id, title: "Log me", assignee: "opencode" });
    promoteTask(task.id);

    let receivedLogPath: string | undefined;
    const mockHarness = (command: string, cwd: string, logPath?: string) => {
      receivedLogPath = logPath;
      return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    };

    await tick({
      spawnHarness: mockHarness as any,
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(receivedLogPath).toBeDefined();
    expect(receivedLogPath).toContain(`logs${sep}log-board${sep}${task.id}.log`);
    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
  });

  it("dispatcher passes undefined logPath when FF_WORKER_LOG_CAPTURE is disabled", async () => {
    setFlag("FF_WORKER_LOG_CAPTURE", false);
    const board = createBoard("nolog-board", "/tmp/nolog-board");
    const task = createTask({ board_id: board.id, title: "No log", assignee: "opencode" });
    promoteTask(task.id);

    let receivedLogPath: string | undefined = "unexpected";
    const mockHarness = (command: string, cwd: string, logPath?: string) => {
      receivedLogPath = logPath;
      return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    };

    await tick({
      spawnHarness: mockHarness as any,
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(receivedLogPath).toBeUndefined();
    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
  });

  it("getTaskLogPath rejects path-traversal board slugs", () => {
    expect(() => getTaskLogPath("../../etc", 1)).toThrow("Invalid boardSlug");
    expect(() => getTaskLogPath("board/../other", 1)).toThrow("Invalid boardSlug");
  });
});
