import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, getDb, closeDb } from "../src/db";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-test.db";

describe("db", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
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

    // Verify indexes exist
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all();
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames).toContain("idx_tasks_board_status");
    expect(indexNames).toContain("idx_tasks_assignee");
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
});
