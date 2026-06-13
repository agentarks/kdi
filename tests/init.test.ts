import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, getDb, closeDb, defaultDbPath } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = "/tmp/kdi-test-init.db";

describe("init command unit tests", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("initDb creates a valid database at the default path", () => {
    const db = initDb(TEST_DB);
    expect(db).toBeDefined();
    expect(existsSync(TEST_DB)).toBe(true);

    // Verify getDb returns the same instance
    expect(getDb()).toBe(db);

    closeDb();
  });

  it("initDb is idempotent — calling twice does not error", () => {
    const db1 = initDb(TEST_DB);
    const db2 = initDb(TEST_DB);
    expect(db1).toBe(db2);
    closeDb();
  });

  it("initDb --force equivalent: close and re-init creates a fresh instance", () => {
    const db1 = initDb(TEST_DB);
    closeDb();

    // Simulate --force: close, delete, re-init
    cleanupDb(TEST_DB);

    const db2 = initDb(TEST_DB);
    expect(db2).toBeInstanceOf(db1.constructor);
    expect(db2).not.toBe(db1);
    closeDb();
  });

  it("initDb returning a Database instance and then getDb works on the same instance", () => {
    const db = initDb(TEST_DB);
    expect(getDb()).toBe(db);
    closeDb();
  });

  it("getDb throws a clear error suggesting kdi init when not initialized", () => {
    closeDb();
    expect(() => getDb()).toThrow(/Run 'kdi init' first/);
  });

  it("defaultDbPath returns a non-empty string", () => {
    const path = defaultDbPath();
    expect(path).toBeTruthy();
    expect(typeof path).toBe("string");
    expect(path.endsWith(".db")).toBe(true);
  });

  it("initDb at a custom path works", () => {
    const customDir = mkdtempSync(join(tmpdir(), "kdi-custom-path-"));
    const customPath = join(customDir, "custom.db");

    try {
      const db = initDb(customPath);
      expect(db).toBeDefined();
      expect(existsSync(customPath)).toBe(true);
      closeDb();

      const db2 = initDb(customPath);
      expect(db2).toBeDefined();
      closeDb();
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("initDb fails with clear error on unwritable path", () => {
    expect(() => initDb("/dev/null/kdi.db")).toThrow();
  });

  it("initDb init lock is released after successful init", () => {
    const lockFile = TEST_DB + ".init.lock";
    expect(existsSync(lockFile)).toBe(false);

    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(db.constructor);

    // Lock should be released after init completes
    expect(existsSync(lockFile)).toBe(false);

    closeDb();
  });

  it("initDb recovers from stale init lock", () => {
    const lockFile = TEST_DB + ".init.lock";
    // Simulate a stale lock from a non-existent PID
    const { writeFileSync } = require("node:fs");
    writeFileSync(lockFile, "999999");
    expect(existsSync(lockFile)).toBe(true);

    const db = initDb(TEST_DB);
    expect(db).toBeDefined();

    // Stale lock should be removed
    expect(existsSync(lockFile)).toBe(false);

    closeDb();
  });
});
