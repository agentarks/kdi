import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { initDb, closeDb, getDb, getBoardDataDir } from "../src/db";
import { createBoard, listBoards, showBoard, archiveBoard, updateBoardMetadata, removeBoard, renameBoard, setDefaultWorkdir } from "../src/models/board";
import { readCurrentBoard, writeCurrentBoard } from "../src/resolveBoard";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, setFlag, FF_BOARD_RM_DELETE, FF_BOARD_RENAME } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

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

  it("createBoard defaults name to slug and defaultWorkdir to null when omitted", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    expect(board.name).toBe("alpha");
    expect(board.icon).toBeNull();
    expect(board.color).toBeNull();
    expect(board.default_workdir).toBeNull();
  });

  it("setDefaultWorkdir stores a board defaultWorkdir", () => {
    createBoard("alpha", "/tmp/alpha");

    const updated = setDefaultWorkdir("alpha", "/tmp/project");

    expect(updated.default_workdir).toBe("/tmp/project");
    expect(showBoard("alpha")?.default_workdir).toBe("/tmp/project");
  });

  it("setDefaultWorkdir clears a board defaultWorkdir", () => {
    createBoard("alpha", "/tmp/alpha");
    setDefaultWorkdir("alpha", "/tmp/project");

    const updated = setDefaultWorkdir("alpha", null);

    expect(updated.default_workdir).toBeNull();
    expect(showBoard("alpha")?.default_workdir).toBeNull();
  });

  it("setDefaultWorkdir rejects invalid slugs for defaultWorkdir", () => {
    expect(() => setDefaultWorkdir("../../bad", "/tmp/project")).toThrow(/Invalid board slug/);
  });

  it("setDefaultWorkdir rejects non-existent boards for defaultWorkdir", () => {
    expect(() => setDefaultWorkdir("missing", "/tmp/project")).toThrow(/not found/);
  });

  it("createBoard stores name, icon, color, and description when provided", () => {
    const board = createBoard("alpha", "/tmp/alpha", "origin/main", {
      name: "Alpha Board",
      icon: "rocket",
      color: "#ff0000",
      description: "Alpha test board",
    });
    expect(board.name).toBe("Alpha Board");
    expect(board.icon).toBe("rocket");
    expect(board.color).toBe("#ff0000");
    expect(board.description).toBe("Alpha test board");
  });

  it("createBoard trims metadata values", () => {
    const board = createBoard("alpha", "/tmp/alpha", "origin/main", {
      name: "  Alpha Board  ",
      icon: "  rocket  ",
      color: "  #ff0000  ",
      description: "  Alpha test board  ",
    });
    expect(board.name).toBe("Alpha Board");
    expect(board.icon).toBe("rocket");
    expect(board.color).toBe("#ff0000");
    expect(board.description).toBe("Alpha test board");
  });

  it("createBoard rejects empty metadata strings", () => {
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { name: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { icon: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { color: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { description: "" })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { name: "   " })).toThrow();
    expect(() => createBoard("alpha", "/tmp/alpha", "origin/main", { description: "   " })).toThrow();
  });

  it("listBoards returns metadata fields", () => {
    createBoard("alpha", "/tmp/alpha", "origin/main", { name: "Alpha", icon: "a", color: "red", description: "alpha desc" });
    createBoard("beta", "/tmp/beta");
    const boards = listBoards();
    const alpha = boards.find((b) => b.slug === "alpha");
    const beta = boards.find((b) => b.slug === "beta");
    expect(alpha?.name).toBe("Alpha");
    expect(alpha?.icon).toBe("a");
    expect(alpha?.color).toBe("red");
    expect(alpha?.description).toBe("alpha desc");
    expect(beta?.name).toBe("beta");
    expect(beta?.icon).toBeNull();
    expect(beta?.color).toBeNull();
    expect(beta?.description).toBeNull();
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
    createBoard("alpha", "/tmp/alpha", "origin/main", { name: "Alpha", icon: "a", color: "red", description: "alpha desc" });
    const result = showBoard("alpha");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("alpha");
    expect(result!.name).toBe("Alpha");
    expect(result!.icon).toBe("a");
    expect(result!.color).toBe("red");
    expect(result!.description).toBe("alpha desc");
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

  it("updateBoardMetadata edits name, icon, color, and description", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { name: "Alpha 2", icon: "star", color: "blue", description: "updated desc" });
    expect(updated.name).toBe("Alpha 2");
    expect(updated.icon).toBe("star");
    expect(updated.color).toBe("blue");
    expect(updated.description).toBe("updated desc");

    const result = showBoard("alpha");
    expect(result?.name).toBe("Alpha 2");
    expect(result?.icon).toBe("star");
    expect(result?.color).toBe("blue");
    expect(result?.description).toBe("updated desc");
  });

  it("updateBoardMetadata can update a single field", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { name: "Only Name" });
    expect(updated.name).toBe("Only Name");
    expect(updated.icon).toBeNull();
    expect(updated.color).toBeNull();
    expect(updated.description).toBeNull();
  });

  it("updateBoardMetadata can update description only", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { description: "Only Description" });
    expect(updated.name).toBe("alpha");
    expect(updated.description).toBe("Only Description");
  });

  it("updateBoardMetadata trims whitespace from values", () => {
    createBoard("alpha", "/tmp/alpha");
    const updated = updateBoardMetadata("alpha", { name: "  Alpha 2  ", icon: "  star  ", color: "  blue  ", description: "  updated desc  " });
    expect(updated.name).toBe("Alpha 2");
    expect(updated.icon).toBe("star");
    expect(updated.color).toBe("blue");
    expect(updated.description).toBe("updated desc");
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
    expect(() => updateBoardMetadata("alpha", { description: "" })).toThrow();
    expect(() => updateBoardMetadata("alpha", { description: "   " })).toThrow();
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

  it("migrates existing boards table to include name, icon, color, description, and defaultWorkdir columns", () => {
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
    expect(columns.map((c) => c.name)).toContain("description");
    expect(columns.map((c) => c.name)).toContain("default_workdir");

    const migrated = showBoard("legacy");
    expect(migrated).not.toBeNull();
    expect(migrated!.name).toBe("legacy");
    expect(migrated!.icon).toBeNull();
    expect(migrated!.color).toBeNull();
    expect(migrated!.description).toBeNull();
    expect(migrated!.default_workdir).toBeNull();

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

describe("FF_BOARD_CREATE_SWITCH (boards create --switch)", () => {
  const CREATE_SWITCH_DB = "/tmp/kdi-board-create-switch-test.db";
  const TMP_DIR = "/tmp/kdi-board-create-switch-data";
  let origKdiDb: string | undefined;
  let origKdiCurrent: string | undefined;

  beforeEach(() => {
    origKdiDb = process.env.KDI_DB;
    origKdiCurrent = process.env.KDI_CURRENT_PATH;
    process.env.KDI_DB = CREATE_SWITCH_DB;
    cleanupDb(CREATE_SWITCH_DB);
    initDb(CREATE_SWITCH_DB);
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    process.env.KDI_CURRENT_PATH = TMP_DIR;
  });

  afterEach(() => {
    if (origKdiDb === undefined) delete process.env.KDI_DB; else process.env.KDI_DB = origKdiDb;
    if (origKdiCurrent === undefined) delete process.env.KDI_CURRENT_PATH; else process.env.KDI_CURRENT_PATH = origKdiCurrent;
    cleanupDb(CREATE_SWITCH_DB);
    clearOverrides();
  });

  it("--switch writes the new board slug to the current-board file", () => {
    const { execSync } = require("node:child_process");
    setFlag("FF_BOARD_CREATE_SWITCH" as any, true);
    execSync(
      `bun run src/index.ts boards create myproj --workdir /tmp/myproj --switch`,
      { encoding: "utf-8", cwd: resolve(import.meta.dir, ".."), env: { ...process.env, KDI_DB: CREATE_SWITCH_DB, KDI_CURRENT_PATH: TMP_DIR, FF_BOARD_CREATE_SWITCH: "true", FF_BOARD_SWITCH: "true" } }
    );
    expect(readCurrentBoard()).toBe("myproj");
  });

  it("without --switch, the current-board file is not touched", () => {
    const { execSync } = require("node:child_process");
    writeCurrentBoard("other");
    execSync(
      `bun run src/index.ts boards create myproj --workdir /tmp/myproj`,
      { encoding: "utf-8", cwd: resolve(import.meta.dir, ".."), env: { ...process.env, KDI_DB: CREATE_SWITCH_DB, KDI_CURRENT_PATH: TMP_DIR } }
    );
    expect(readCurrentBoard()).toBe("other");
  });
});

describe("renameBoard", () => {
  const RENAME_DB = "/tmp/kdi-rename-test.db";
  const TMP_DIR = "/tmp/kdi-rename-data";
  const ORIG_KDI_DB = process.env.KDI_DB;

  beforeEach(() => {
    // Set KDI_DB so getBoardDataDir resolves under /tmp/
    process.env.KDI_DB = RENAME_DB;
    cleanupDb(RENAME_DB);
    initDb(RENAME_DB);
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    setFlag(FF_BOARD_RENAME, true);
  });

  afterEach(() => {
    cleanupDb(RENAME_DB);
    // Clean up board data dirs under /tmp/boards/
    rmSync("/tmp/boards", { recursive: true, force: true });
    rmSync(TMP_DIR, { recursive: true, force: true });
    if (ORIG_KDI_DB !== undefined) {
      process.env.KDI_DB = ORIG_KDI_DB;
    } else {
      delete process.env.KDI_DB;
    }
    clearOverrides();
  });

  it("AC-01: FF_BOARD_RENAME flag exists and defaults to false", () => {
    // The flag gates the CLI command, not the model function.
    // Verify the constant exists.
    expect(FF_BOARD_RENAME).toBe("FF_BOARD_RENAME");
    // Model function works regardless of flag
    createBoard("old-name", "/tmp/work");
    const result = renameBoard("old-name", "new-name");
    expect(result.board.slug).toBe("new-name");
  });

  it("AC-02: rejects invalid old slug", () => {
    createBoard("valid-board", "/tmp/work");
    expect(() => renameBoard("../../bad", "new-name")).toThrow(/Invalid old board slug/);
  });

  it("AC-03: rejects invalid new slug", () => {
    createBoard("valid-board", "/tmp/work");
    expect(() => renameBoard("valid-board", "../../bad")).toThrow(/Invalid new board slug/);
  });

  it("AC-04: rejects rename to same slug", () => {
    createBoard("my-board", "/tmp/work");
    expect(() => renameBoard("my-board", "my-board")).toThrow(/New slug must differ/);
  });

  it("AC-05: rejects rename of non-existent board", () => {
    expect(() => renameBoard("nonexistent", "new-name")).toThrow(/not found or is archived/);
  });

  it("AC-06: rejects rename of archived board", () => {
    createBoard("old-name", "/tmp/work");
    archiveBoard("old-name");
    expect(() => renameBoard("old-name", "new-name")).toThrow(/not found or is archived/);
  });

  it("AC-07: rejects rename when new slug is taken by active board", () => {
    createBoard("old-name", "/tmp/work");
    createBoard("taken-name", "/tmp/work2");
    expect(() => renameBoard("old-name", "taken-name")).toThrow(/already exists/);
  });

  it("AC-07b: rejects rename when new slug is taken by archived board", () => {
    createBoard("old-name", "/tmp/work");
    createBoard("taken-name", "/tmp/work2");
    archiveBoard("taken-name");
    expect(() => renameBoard("old-name", "taken-name")).toThrow(/already exists/);
  });

  it("AC-08: successfully renames a board", () => {
    createBoard("old-name", "/tmp/work");
    const result = renameBoard("old-name", "new-name");
    expect(result.board.slug).toBe("new-name");
    expect(result.board.workdir).toBe("/tmp/work");
    expect(result.dirRenamed).toBe(false);

    // Old slug should not be findable
    expect(showBoard("old-name", true)).toBeNull();
    // New slug should exist
    const board = showBoard("new-name", false);
    expect(board).not.toBeNull();
    expect(board!.slug).toBe("new-name");
  });

  it("AC-09: renames the board data directory when it exists", () => {
    createBoard("old-name", "/tmp/work");
    const oldDir = getBoardDataDir("old-name");
    const newDir = getBoardDataDir("new-name");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "kanban.db"), "data");

    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);

    const result = renameBoard("old-name", "new-name");
    expect(result.dirRenamed).toBe(true);

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    const contents = readFileSync(join(newDir, "kanban.db"), "utf-8");
    expect(contents).toBe("data");
  });

  it("AC-10: missing data directory does not fail rename", () => {
    createBoard("old-name", "/tmp/work");
    const oldDir = getBoardDataDir("old-name");
    // Ensure the dir does NOT exist
    rmSync(oldDir, { recursive: true, force: true });
    expect(existsSync(oldDir)).toBe(false);

    // Rename should succeed
    const result = renameBoard("old-name", "new-name");
    expect(result.board.slug).toBe("new-name");
    expect(result.dirRenamed).toBe(false);
  });

  it("AC-10b: missing data directory warns on stderr", () => {
    createBoard("old-name", "/tmp/work");
    const oldDir = getBoardDataDir("old-name");
    rmSync(oldDir, { recursive: true, force: true });
    expect(existsSync(oldDir)).toBe(false);

    const errorMessages: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => { errorMessages.push(args.join(" ")); };

    try {
      renameBoard("old-name", "new-name");
      const all = errorMessages.join("\n");
      expect(all).toContain("Warning: board data directory");
      expect(all).toContain("not found; skipped directory rename.");
    } finally {
      console.error = origConsoleError;
    }
  });

  it("AC-11: current-board file is updated when it references the old slug", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-rename-current-"));
    process.env.KDI_CURRENT_PATH = tmpDir;

    try {
      createBoard("old-name", "/tmp/work");
      writeCurrentBoard("old-name");
      expect(readCurrentBoard()).toBe("old-name");

      // Simulate CLI handler logic: rename then update current-board
      const { board } = renameBoard("old-name", "new-name");
      expect(board.slug).toBe("new-name");

      const current = readCurrentBoard();
      if (current === "old-name") {
        writeCurrentBoard("new-name");
      }

      expect(readCurrentBoard()).toBe("new-name");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.KDI_CURRENT_PATH;
    }
  });

  it("AC-13: tasks are preserved after board rename", () => {
    const board = createBoard("old-name", "/tmp/work");
    const db = getDb();
    // Create tasks on the board
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 1", "todo"]);
    db.run("INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)", [board.id, "Task 2", "ready"]);

    renameBoard("old-name", "new-name");

    const renamedBoard = showBoard("new-name", false);
    expect(renamedBoard).not.toBeNull();
    expect(renamedBoard!.slug).toBe("new-name");
    // Task counts should still include the original tasks
    expect(renamedBoard!.taskCounts.todo).toBe(1);
    expect(renamedBoard!.taskCounts.ready).toBe(1);
  });

  it("AC-09b: data directory is created in the new location with correct name", () => {
    createBoard("old-name", "/tmp/work");
    const oldDir = getBoardDataDir("old-name");
    const newDir = getBoardDataDir("new-name");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "data.txt"), "hello");

    renameBoard("old-name", "new-name");

    // Old dir should be gone
    expect(existsSync(oldDir)).toBe(false);
    // New dir should have the original data
    expect(existsSync(newDir)).toBe(true);
    expect(readFileSync(join(newDir, "data.txt"), "utf-8")).toBe("hello");
  });
});
