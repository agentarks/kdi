import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initDb, closeDb, getDb, getBoardDataDir } from "../src/db";
import { createBoard, listBoards, showBoard, archiveBoard, removeBoard } from "../src/models/board";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, setFlag, FF_BOARD_RM_DELETE } from "../src/flags";

const TEST_DB = "/tmp/kdi-board-test.db";

describe("board model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("createBoard returns board with id, slug, workdir, base_ref, archived_at=null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    expect(board.id).toBeNumber();
    expect(board.slug).toBe("alpha");
    expect(board.workdir).toBe("/tmp/alpha");
    expect(board.base_ref).toBe("origin/main");
    expect(board.archived_at).toBeNull();
    expect(board.created_at).toBeNumber();
  });

  it("createBoard accepts custom base_ref", () => {
    const board = createBoard("beta", "/tmp/beta", "origin/develop");
    expect(board.base_ref).toBe("origin/develop");
  });

  it("listBoards excludes archived boards by default", () => {
    createBoard("alpha", "/tmp/alpha");
    createBoard("beta", "/tmp/beta");
    createBoard("gamma", "/tmp/gamma");
    archiveBoard("beta");

    const boards = listBoards();
    const slugs = boards.map(b => b.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).not.toContain("beta");
    expect(slugs).toContain("gamma");
  });

  it("listBoards includes archived boards when includeArchived=true", () => {
    createBoard("alpha", "/tmp/alpha");
    createBoard("beta", "/tmp/beta");
    archiveBoard("beta");

    const boards = listBoards(true);
    const slugs = boards.map(b => b.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).toContain("beta");
  });

  it("showBoard returns null for non-existent slug", () => {
    const result = showBoard("nonexistent");
    expect(result).toBeNull();
  });

  it("showBoard returns empty task counts on fresh board", () => {
    createBoard("alpha", "/tmp/alpha");
    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.taskCounts.triage).toBe(0);
    expect(result!.taskCounts.todo).toBe(0);
    expect(result!.taskCounts.ready).toBe(0);
    expect(result!.taskCounts.running).toBe(0);
    expect(result!.taskCounts.done).toBe(0);
    expect(result!.taskCounts.blocked).toBe(0);
    expect(result!.taskCounts.archived).toBe(0);
  });

  it("showBoard returns board details with task counts per status", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const db = getDb();
    // Insert tasks with different statuses
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 1", "triage"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 2", "todo"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 3", "ready"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 4", "running"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 5", "done"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 6", "blocked"]);

    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("alpha");
    expect(result!.taskCounts.triage).toBe(1);
    expect(result!.taskCounts.todo).toBe(1);
    expect(result!.taskCounts.ready).toBe(1);
    expect(result!.taskCounts.running).toBe(1);
    expect(result!.taskCounts.done).toBe(1);
    expect(result!.taskCounts.blocked).toBe(1);
  });

  it("showBoard excludes archived tasks from status counts but reports archived count", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const db = getDb();
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Active", "todo"]);
    db.run("INSERT INTO tasks (board_id, title, status, archived_at) VALUES (?, ?, ?, unixepoch())", [board.id, "Archived", "done"]);

    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.taskCounts.todo).toBe(1);
    expect(result!.taskCounts.done).toBe(0);
    expect(result!.taskCounts.archived).toBe(1);
  });

  it("archiveBoard sets archived_at", () => {
    createBoard("alpha", "/tmp/alpha");
    archiveBoard("alpha");
    const result = showBoard("alpha");
    expect(result).toBeNull();
  });

  it("createBoard throws on duplicate slug", () => {
    createBoard("alpha", "/tmp/alpha");
    expect(() => createBoard("alpha", "/tmp/alpha2")).toThrow();
  });

  it("archiveBoard throws on non-existent slug", () => {
    expect(() => archiveBoard("nonexistent")).toThrow();
  });

  it("removeBoard soft-archives a board by default", () => {
    createBoard("alpha", "/tmp/alpha");
    removeBoard("alpha", false);

    expect(showBoard("alpha")).toBeNull();
    const archived = listBoards(true);
    expect(archived.map(b => b.slug)).toContain("alpha");
  });

  it("removeBoard hard-deletes a board and its data directory", () => {
    setFlag(FF_BOARD_RM_DELETE, true);
    createBoard("alpha", "/tmp/alpha");
    const boardDir = getBoardDataDir("alpha");
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(join(boardDir, "kanban.db"), "dummy");

    removeBoard("alpha", true);

    expect(showBoard("alpha")).toBeNull();
    expect(listBoards(true).map(b => b.slug)).not.toContain("alpha");
    expect(existsSync(boardDir)).toBe(false);
  });

  it("removeBoard hard-delete throws on non-existent slug", () => {
    setFlag(FF_BOARD_RM_DELETE, true);
    expect(() => removeBoard("nonexistent", true)).toThrow(/not found/);
  });

  it("removeBoard hard-delete cascades to tasks and related rows", () => {
    setFlag(FF_BOARD_RM_DELETE, true);
    const board = createBoard("alpha", "/tmp/alpha");
    const db = getDb();

    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 1", "todo"]);
    const task = db.query("SELECT id FROM tasks WHERE board_id = ?").get(board.id) as { id: number };
    db.run("INSERT INTO comments (task_id, text) VALUES (?, ?)", [task.id, "comment"]);
    db.run("INSERT INTO task_runs (task_id, status, started_at) VALUES (?, ?, ?)", [task.id, "done", Date.now()]);
    const run = db.query("SELECT id FROM task_runs WHERE task_id = ?").get(task.id) as { id: number };
    db.run("INSERT INTO task_events (task_id, run_id, kind) VALUES (?, ?, ?)", [task.id, run.id, "created"]);

    removeBoard("alpha", true);

    expect(showBoard("alpha")).toBeNull();
    expect(db.query("SELECT COUNT(*) as c FROM tasks WHERE board_id = ?").get(board.id) as { c: number }).toEqual({ c: 0 });
    expect(db.query("SELECT COUNT(*) as c FROM comments WHERE task_id = ?").get(task.id) as { c: number }).toEqual({ c: 0 });
    expect(db.query("SELECT COUNT(*) as c FROM task_runs WHERE task_id = ?").get(task.id) as { c: number }).toEqual({ c: 0 });
    expect(db.query("SELECT COUNT(*) as c FROM task_events WHERE task_id = ?").get(task.id) as { c: number }).toEqual({ c: 0 });
  });
});
