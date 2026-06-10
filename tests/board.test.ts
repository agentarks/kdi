import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard, listBoards, showBoard, archiveBoard } from "../src/models/board";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-board-test.db";

describe("board model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("createBoard returns board with id, slug, workdir, archived_at=null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    expect(board.id).toBeNumber();
    expect(board.slug).toBe("alpha");
    expect(board.workdir).toBe("/tmp/alpha");
    expect(board.archived_at).toBeNull();
    expect(board.created_at).toBeNumber();
  });

  it("listBoards excludes archived boards", () => {
    createBoard("alpha", "/tmp/alpha");
    createBoard("beta", "/tmp/beta");
    const gamma = createBoard("gamma", "/tmp/gamma");
    archiveBoard("beta");

    const boards = listBoards();
    const slugs = boards.map(b => b.slug);
    expect(slugs).toContain("alpha");
    expect(slugs).not.toContain("beta");
    expect(slugs).toContain("gamma");
  });

  it("showBoard returns null for non-existent slug", () => {
    const result = showBoard("nonexistent");
    expect(result).toBeNull();
  });

  it("showBoard returns empty task counts on fresh board", () => {
    createBoard("alpha", "/tmp/alpha");
    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.taskCounts.todo).toBe(0);
    expect(result!.taskCounts.ready).toBe(0);
    expect(result!.taskCounts.running).toBe(0);
    expect(result!.taskCounts.done).toBe(0);
    expect(result!.taskCounts.blocked).toBe(0);
  });

  it("showBoard returns board details with task counts per status", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const db = initDb(TEST_DB);
    // Insert tasks with different statuses
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 1", "todo"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 2", "ready"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 3", "running"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 4", "done"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 5", "blocked"]);

    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("alpha");
    expect(result!.taskCounts.todo).toBe(1);
    expect(result!.taskCounts.ready).toBe(1);
    expect(result!.taskCounts.running).toBe(1);
    expect(result!.taskCounts.done).toBe(1);
    expect(result!.taskCounts.blocked).toBe(1);
  });

  it("showBoard excludes archived tasks from counts", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const db = initDb(TEST_DB);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Active", "todo"]);
    db.run("INSERT INTO tasks (board_id, title, status, archived_at) VALUES (?, ?, ?, unixepoch())", [board.id, "Archived", "done"]);

    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.taskCounts.todo).toBe(1);
    expect(result!.taskCounts.done).toBe(0);
  });

  it("archiveBoard sets archived_at", () => {
    createBoard("alpha", "/tmp/alpha");
    archiveBoard("alpha");
    const result = showBoard("alpha");
    expect(result).toBeNull();
  });
});
