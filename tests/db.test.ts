import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, getDb, closeDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

const TEST_DB = "/tmp/kdi-test.db";

describe("db", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("creates schema and returns a Database instance", () => {
    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(Database);

    // Verify WAL mode
    const journal = db.query("PRAGMA journal_mode").get();
    expect(journal).toEqual({ journal_mode: "wal" });

    // Verify busy_timeout
    const timeout = db.query("PRAGMA busy_timeout").get();
    expect(timeout).toEqual({ timeout: 5000 });

    // Verify tables exist
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: any) => t.name);
    expect(names).toContain("boards");
    expect(names).toContain("tasks");
    expect(names).toContain("comments");
    expect(names).toContain("dependencies");
    expect(names).toContain("task_events");

    // Verify task_runs table exists
    expect(names).toContain("task_runs");

    // Verify scheduled status exists in CHECK constraint
    const tasksCreateSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get() as { sql: string };
    expect(tasksCreateSql.sql).toContain("'scheduled'");

    // Verify scheduled columns exist
    const taskColumns = db.query("PRAGMA table_info(tasks)").all() as any[];
    const columnNames = taskColumns.map((c) => c.name);
    expect(columnNames).toContain("scheduled_at");
    expect(columnNames).toContain("schedule_reason");
    expect(columnNames).toContain("created_by");
    expect(columnNames).toContain("model_override");

    // Verify indexes exist
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all();
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames).toContain("idx_tasks_board_status");
    expect(indexNames).toContain("idx_tasks_assignee");
    expect(indexNames).toContain("idx_tasks_scheduled_at");
    expect(indexNames).toContain("idx_tasks_created_by");
    expect(indexNames).toContain("idx_events_task");
    expect(indexNames).toContain("idx_events_run");
    expect(indexNames).toContain("idx_runs_task");
    expect(indexNames).toContain("idx_runs_status");
  });

  it("returns the same instance on subsequent calls, then creates a new instance after closeDb", () => {
    const db1 = initDb(TEST_DB);
    const db2 = initDb(TEST_DB);
    expect(db1).toBe(db2);

    closeDb();
    const db3 = initDb(TEST_DB);
    expect(db3).not.toBe(db1);
  });

  it("closeDb resets the singleton so initDb creates a fresh instance", () => {
    const db1 = initDb(TEST_DB);
    closeDb();
    const db2 = initDb(TEST_DB);
    expect(db2).toBeInstanceOf(Database);
    expect(db2).not.toBe(db1);
  });

  it("creates and releases init lock during schema setup", () => {
    const lockFile = TEST_DB + ".init.lock";
    expect(existsSync(lockFile)).toBe(false);

    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(Database);

    // Lock should be released after init completes
    expect(existsSync(lockFile)).toBe(false);

    closeDb();
  });

  it("recovers from stale init lock left by a dead process", () => {
    const lockFile = TEST_DB + ".init.lock";
    // Simulate a stale lock from a non-existent PID
    writeFileSync(lockFile, "999999");
    expect(existsSync(lockFile)).toBe(true);

    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(Database);

    // Stale lock should be removed and init should succeed
    expect(existsSync(lockFile)).toBe(false);

    closeDb();
  });

  it("recovers from stale init lock with non-numeric content", () => {
    const lockFile = TEST_DB + ".init.lock";
    writeFileSync(lockFile, "not-a-pid");
    expect(existsSync(lockFile)).toBe(true);

    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(Database);
    expect(existsSync(lockFile)).toBe(false);

    closeDb();
  });

  it("init lock is released after successful init", () => {
    const lockFile = TEST_DB + ".init.lock";
    expect(existsSync(lockFile)).toBe(false);

    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(Database);
    expect(existsSync(lockFile)).toBe(false);

    closeDb();
  });

  it("migrates a pre-created_by database by adding column and index", () => {
    cleanupDb(TEST_DB);
    // Create a database with all current tasks columns except created_by,
    // but with the legacy status CHECK constraint, so initDb takes the table
    // recreation path and populates created_by.
    const raw = new Database(TEST_DB);
    raw.exec(`
      CREATE TABLE boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        workdir TEXT NOT NULL,
        base_ref TEXT NOT NULL DEFAULT 'origin/main',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        archived_at INTEGER
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        title TEXT NOT NULL,
        body TEXT,
        assignee TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'ready', 'running', 'done', 'blocked')),
        priority INTEGER DEFAULT 0,
        workspace_kind TEXT DEFAULT 'worktree' CHECK (workspace_kind IN ('dir', 'worktree', 'scratch')),
        branch TEXT,
        result TEXT,
        summary TEXT,
        block_reason TEXT,
        schedule_reason TEXT,
        review_reason TEXT,
        scheduled_at INTEGER,
        tenant TEXT,
        skills TEXT,
        max_runtime_seconds INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER,
        archived_at INTEGER,
        current_run_id INTEGER,
        claim_lock TEXT,
        claim_expires INTEGER,
        last_heartbeat_at INTEGER,
        idempotency_key TEXT
      );
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        profile TEXT,
        step_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'blocked', 'crashed', 'timed_out', 'failed', 'released')),
        claim_lock TEXT,
        claim_expires INTEGER,
        worker_pid INTEGER,
        max_runtime_seconds INTEGER,
        last_heartbeat_at INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed')),
        summary TEXT,
        metadata TEXT,
        error TEXT
      );
    `);
    raw.exec("INSERT INTO boards (slug, workdir) VALUES ('legacy', '/tmp/legacy')");
    raw.exec("INSERT INTO tasks (board_id, title, status) VALUES (1, 'legacy task', 'todo')");
    raw.close();

    const db = initDb(TEST_DB);
    const columns = db.query("PRAGMA table_info(tasks)").all() as any[];
    expect(columns.map((c) => c.name)).toContain("created_by");

    const row = db.query("SELECT created_by FROM tasks WHERE id = 1").get() as { created_by: string };
    expect(row.created_by).toBe("unknown");

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as any[];
    expect(indexes.map((i) => i.name)).toContain("idx_tasks_created_by");

    closeDb();
  });

  it("migrates a pre-max_runtime database by adding task_runs.max_runtime_seconds", () => {
    cleanupDb(TEST_DB);
    const raw = new Database(TEST_DB);
    raw.exec(`
      CREATE TABLE boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        workdir TEXT NOT NULL,
        base_ref TEXT NOT NULL DEFAULT 'origin/main',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        archived_at INTEGER
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        title TEXT NOT NULL,
        body TEXT,
        assignee TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('triage', 'todo', 'scheduled', 'ready', 'running', 'done', 'blocked', 'review', 'archived')),
        priority INTEGER DEFAULT 0,
        workspace_kind TEXT DEFAULT 'worktree' CHECK (workspace_kind IN ('dir', 'worktree', 'scratch')),
        branch TEXT,
        result TEXT,
        summary TEXT,
        block_reason TEXT,
        schedule_reason TEXT,
        review_reason TEXT,
        scheduled_at INTEGER,
        created_by TEXT NOT NULL DEFAULT 'unknown',
        skills TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER,
        archived_at INTEGER,
        current_run_id INTEGER,
        claim_lock TEXT,
        claim_expires INTEGER,
        last_heartbeat_at INTEGER,
        max_runtime_seconds INTEGER,
        idempotency_key TEXT
      );
      CREATE INDEX idx_tasks_priority ON tasks(priority);
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        profile TEXT,
        step_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'blocked', 'crashed', 'timed_out', 'failed', 'released')),
        claim_lock TEXT,
        claim_expires INTEGER,
        worker_pid INTEGER,
        last_heartbeat_at INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed')),
        summary TEXT,
        metadata TEXT,
        error TEXT
      );
    `);
    raw.close();

    const db = initDb(TEST_DB);
    const columns = db.query("PRAGMA table_info(task_runs)").all() as any[];
    expect(columns.map((c) => c.name)).toContain("max_runtime_seconds");

    closeDb();
  });
});
