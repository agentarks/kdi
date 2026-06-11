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

    // Verify indexes exist
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all();
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames).toContain("idx_tasks_board_status");
    expect(indexNames).toContain("idx_tasks_assignee");
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
});
