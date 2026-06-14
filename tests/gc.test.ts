import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { initDb, getDb, getBoardDataDir } from "../src/db";
import { createBoard, archiveBoard } from "../src/models/board";
import { createTask, archiveTask } from "../src/models/task";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, FF_GC } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const TEST_DB = "/tmp/kdi-gc-test.db";

function runKdi(args: string, env: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: { ...process.env, KDI_DB: TEST_DB, FF_GC: "true", ...env },
  }).trim();
}

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "kdi-gc-home-"));
}

function insertOldEvent(taskId: number, kind: string, secondsAgo: number): void {
  const db = getDb();
  const createdAt = Math.floor(Date.now() / 1000) - secondsAgo;
  db.run("INSERT INTO task_events (task_id, kind, created_at) VALUES (?, ?, ?)", [taskId, kind, createdAt]);
}

describe("gc model", () => {
  beforeEach(() => {
    process.env.KDI_DB = TEST_DB;
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("deletes old events for a board", async () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "task" });
    insertOldEvent(task.id, "created", 2 * 24 * 60 * 60);
    insertOldEvent(task.id, "promoted", 2 * 24 * 60 * 60);

    const { runGarbageCollection } = await import("../src/models/gc");
    const result = runGarbageCollection("myproj", { eventRetentionDays: 1 });
    expect(result.deletedEvents).toBe(2);
  });

  it("keeps recent events when retention is large", async () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "task" });
    insertOldEvent(task.id, "created", 60);

    const { runGarbageCollection } = await import("../src/models/gc");
    const result = runGarbageCollection("myproj", { eventRetentionDays: 365 });
    expect(result.deletedEvents).toBe(0);
  });

  it("cleans KDI-owned archived task workspaces", async () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const boardDir = getBoardDataDir("myproj");
    const workspaceDir = join(boardDir, "workspaces", "1");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "file.txt"), "hello");

    const task = createTask({ board_id: board.id, title: "archived task", workspace: workspaceDir });
    archiveTask(task.id);

    const { runGarbageCollection } = await import("../src/models/gc");
    const result = runGarbageCollection("myproj", {});
    expect(result.cleanedWorkspaces).toBe(1);
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it("skips user-owned archived task workspaces", async () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const userDir = mkdtempSync(join(tmpdir(), "user-workspace-"));
    writeFileSync(join(userDir, "file.txt"), "hello");

    const task = createTask({ board_id: board.id, title: "archived task", workspace: userDir });
    archiveTask(task.id);

    const { runGarbageCollection } = await import("../src/models/gc");
    const result = runGarbageCollection("myproj", {});
    expect(result.cleanedWorkspaces).toBe(0);
    expect(existsSync(userDir)).toBe(true);

    rmSync(userDir, { recursive: true, force: true });
  });

  it("throws when board is archived", async () => {
    createBoard("myproj", "/tmp/myproj");
    archiveBoard("myproj");

    const { runGarbageCollection } = await import("../src/models/gc");
    expect(() => runGarbageCollection("myproj", {})).toThrow(/not found or is archived/);
  });

  it("throws when board does not exist", async () => {
    const { runGarbageCollection } = await import("../src/models/gc");
    expect(() => runGarbageCollection("missing", {})).toThrow(/not found or is archived/);
  });
});

describe("gc CLI", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    process.env.KDI_DB = TEST_DB;
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("rejects gc when flag is disabled", () => {
    expect(() => runKdi("gc", { FF_GC: "false" })).toThrow(/GC feature is not enabled/);
  });

  it("deletes old logs and reports count", () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const logDir = join(home, ".local", "share", "kdi", "logs", "myproj");
    mkdirSync(logDir, { recursive: true });
    const oldLog = join(logDir, "1.log");
    writeFileSync(oldLog, "old log");

    // Set mtime to 8 days ago
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    utimesSync(oldLog, eightDaysAgo / 1000, eightDaysAgo / 1000);

    runKdi("boards create myproj --workdir /tmp/myproj");
    const output = runKdi("gc --board myproj --log-retention-days 7");
    expect(output).toContain("Deleted logs: 1");
    expect(existsSync(oldLog)).toBe(false);
  });

  it("resolves board via standard chain", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    const output = runKdi("gc", { KDI_BOARD: "myproj" });
    expect(output).toContain("Garbage collection complete for board myproj");
  });

  it("errors for an archived board", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi("boards archive myproj");
    expect(() => runKdi("gc --board myproj")).toThrow(/not found or is archived/);
  });

  it("cleans archived workspaces via CLI", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const workspaceDir = join(getBoardDataDir("myproj"), "workspaces", "1");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "file.txt"), "hello");

    const task = createTask({ board_id: board.id, title: "archived task", workspace: workspaceDir });
    archiveTask(task.id);

    const output = runKdi("gc --board myproj");
    expect(output).toContain("Cleaned archived workspaces: 1");
    expect(existsSync(workspaceDir)).toBe(false);
  });
});
