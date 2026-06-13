import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initDb, closeDb, getDb, getBoardDataDir } from "../src/db";
import { createBoard, listBoards, showBoard, archiveBoard, updateBoardMetadata, removeBoard } from "../src/models/board";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, setFlag, FF_BOARD_RM_DELETE } from "../src/flags";

const TEST_DB = "/tmp/kdi-board-test.db";
const MIGRATION_DB = "/tmp/kdi-board-migration-test.db";

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

  it("createBoard rejects path traversal slugs", () => {
    expect(() => createBoard("../../bad", "/tmp/bad")).toThrow(/Invalid board slug/);
  });

  it("getBoardDataDir rejects path traversal slugs", () => {
    expect(() => getBoardDataDir("../")).toThrow(/Invalid board slug/);
  });

  it("createBoard defaults name to slug when omitted", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    expect(board.name).toBe("alpha");
    expect(board.icon).toBeNull();
    expect(board.color).toBeNull();
  });

  it("createBoard stores name, icon, and color when provided", () => {
    const board = createBoard("alpha", "/tmp/alpha", "origin/main", {
      name: "Alpha Board",
      icon: "rocket",
      color: "#ff0000",
    });
    expect(board.name).toBe("Alpha Board");
    expect(board.icon).toBe("rocket");
    expect(board.color).toBe("#ff0000");
  });

  it("createBoard trims metadata values", () => {
    const board = createBoard("alpha", "/tmp/alpha", "origin/main", {
      name: "  Alpha Board  ",
      icon: "  rocket  ",
      color: "  #ff0000  ",
    });
    expect(board.name).toBe("Alpha Board");
    expect(board.icon).toBe("rocket");
    expect(board.color).toBe("#ff0000");
  });

  it("createBoard rejects empty metadata strings", () => {
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { name: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { icon: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { color: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { name: "   " })).toThrow();
  });

  it("listBoards returns metadata fields", () => {
    createBoard("alpha", "/tmp/alpha", "origin/main", { name: "Alpha", icon: "a", color: "red" });
    createBoard("beta", "/tmp/beta");
    const boards = listBoards();
    const alpha = boards.find((b) => b.slug === "alpha");
    const beta = boards.find((b) => b.slug === "beta");
    expect(alpha?.name).toBe("Alpha");
    expect(alpha?.icon).toBe("a");
    expect(alpha?.color).toBe("red");
    expect(beta?.name).toBe("beta");
    expect(beta?.icon).toBeNull();
    expect(beta?.color).toBeNull();
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

  it("showBoard returns board details with metadata", () => {
    createBoard("alpha", "/tmp/alpha", "origin/main", { name: "Alpha", icon: "a", color: "red" });
    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("alpha");
    expect(result!.name).toBe("Alpha");
    expect(result!.icon).toBe("a");
    expect(result!.color).toBe("red");
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

  it("updateBoardMetadata edits name, icon, and color", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { name: "Alpha 2", icon: "star", color: "blue" });
    expect(updated.name).toBe("Alpha 2");
    expect(updated.icon).toBe("star");
    expect(updated.color).toBe("blue");

    const result = showBoard("alpha");
    expect(result?.name).toBe("Alpha 2");
    expect(result?.icon).toBe("star");
    expect(result?.color).toBe("blue");
  });

  it("updateBoardMetadata can update a single field", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { name: "Only Name" });
    expect(updated.name).toBe("Only Name");
    expect(updated.icon).toBeNull();
    expect(updated.color).toBeNull();
  });

  it("updateBoardMetadata trims whitespace from values", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { name: "  Alpha 2  ", icon: "  star  ", color: "  blue  " });
    expect(updated.name).toBe("Alpha 2");
    expect(updated.icon).toBe("star");
    expect(updated.color).toBe("blue");
  });

  it("updateBoardMetadata throws when no fields are provided", () => {
    createBoard("alpha", "/tmp/alpha");
    expect(() => updateBoardMetadata("alpha", {})).toThrow();
  });

  it("updateBoardMetadata throws for empty string values", () => {
    createBoard("alpha", "/tmp/alpha");
    expect(() => updateBoardMetadata("alpha", { name: "" })).toThrow();
    expect(() => updateBoardMetadata("alpha", { icon: "" })).toThrow();
    expect(() => updateBoardMetadata("alpha", { color: "" })).toThrow();
  });

  it("updateBoardMetadata throws for non-existent board", () => {
    expect(() => updateBoardMetadata("nonexistent", { name: "X" })).toThrow();
  });

  it("updateBoardMetadata throws for archived board", () => {
    createBoard("alpha", "/tmp/alpha");
    archiveBoard("alpha");
    expect(() => updateBoardMetadata("alpha", { name: "X" })).toThrow();
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

  it("migrates existing boards table to include name, icon, and color columns", () => {
    cleanupDb(MIGRATION_DB);
    // Create a raw database with the pre-metadata boards schema.
    const raw = new Database(MIGRATION_DB);
    raw.exec(`
      CREATE TABLE boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        workdir TEXT NOT NULL,
        base_ref TEXT NOT NULL DEFAULT 'origin/main',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        archived_at INTEGER
      )
    `);
    raw.exec("INSERT INTO boards (slug, workdir) VALUES ('legacy', '/tmp/legacy')");
    raw.close();

    const db = initDb(MIGRATION_DB);
    const columns = db.query("PRAGMA table_info(boards)").all() as any[];
    expect(columns.map((c) => c.name)).toContain("name");
    expect(columns.map((c) => c.name)).toContain("icon");
    expect(columns.map((c) => c.name)).toContain("color");

    const migrated = showBoard("legacy");
    expect(migrated).not.toBeNull();
    expect(migrated!.name).toBe("legacy");
    expect(migrated!.icon).toBeNull();
    expect(migrated!.color).toBeNull();

    closeDb();
    cleanupDb(MIGRATION_DB);
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
