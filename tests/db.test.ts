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
    
    // Verify tables exist
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: any) => t.name);
    expect(names).toContain("boards");
    expect(names).toContain("tasks");
    expect(names).toContain("comments");
    expect(names).toContain("dependencies");
  });

  it("returns the same instance on subsequent calls", () => {
    const db1 = initDb(TEST_DB);
    const db2 = getDb();
    expect(db1).toBe(db2);
  });
});
