import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDispatcherPidPath, isDispatcherPresent } from "../src/dispatcherPresence";
import { initDb, closeDb, getBoardDataDir } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { createBoard } from "../src/models/board";

const TEST_DB = "/tmp/kdi-dispatcher-presence-test.db";
const TEST_SLUG = "presence-board";

function writePid(slug: string, body: string): string {
  const dir = getBoardDataDir(slug);
  mkdirSync(dir, { recursive: true });
  const path = getDispatcherPidPath(slug);
  writeFileSync(path, body, "utf8");
  return path;
}

describe("dispatcherPresence", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origDb: string | undefined;
  let origDbPath: string | undefined;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-dispatcher-presence-"));
    origHome = process.env.HOME;
    origDb = process.env.KDI_DB;
    origDbPath = process.env.KDI_DB_PATH;
    process.env.HOME = tmpHome;
    process.env.KDI_DB = TEST_DB;
    delete process.env.KDI_DB_PATH;
    initDb(TEST_DB);
    // Ensure board data directory exists for a known board and starts empty
    rmSync(getBoardDataDir(TEST_SLUG), { recursive: true, force: true });
    mkdirSync(getBoardDataDir(TEST_SLUG), { recursive: true });
  });

  afterEach(() => {
    closeDb();
    cleanupDb(TEST_DB);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.KDI_DB;
    else process.env.KDI_DB = origDb;
    if (origDbPath === undefined) delete process.env.KDI_DB_PATH;
    else process.env.KDI_DB_PATH = origDbPath;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    try { rmSync(getBoardDataDir(TEST_SLUG), { recursive: true, force: true }); } catch {}
  });

  it("getDispatcherPidPath returns a path under the board data directory", () => {
    const path = getDispatcherPidPath(TEST_SLUG);
    expect(path).toBe(join(getBoardDataDir(TEST_SLUG), "dispatcher.pid"));
  });

  it("isDispatcherPresent returns false when the PID file is missing", () => {
    expect(existsSync(getDispatcherPidPath(TEST_SLUG))).toBe(false);
    expect(isDispatcherPresent(TEST_SLUG)).toBe(false);
  });

  it("isDispatcherPresent returns false when the PID file is empty", () => {
    writePid(TEST_SLUG, "");
    expect(isDispatcherPresent(TEST_SLUG)).toBe(false);
  });

  it("isDispatcherPresent returns false when the PID file contains non-numeric text", () => {
    writePid(TEST_SLUG, "not-a-pid\n");
    expect(isDispatcherPresent(TEST_SLUG)).toBe(false);
  });

  it("isDispatcherPresent returns false when the PID file contains a negative number", () => {
    writePid(TEST_SLUG, "-42\n");
    expect(isDispatcherPresent(TEST_SLUG)).toBe(false);
  });

  it("isDispatcherPresent returns false when the PID file contains zero", () => {
    writePid(TEST_SLUG, "0\n");
    expect(isDispatcherPresent(TEST_SLUG)).toBe(false);
  });

  it("isDispatcherPresent returns false when the PID file contains a dead PID", () => {
    // 0x7ffffff0 is large, almost certainly unused; fall back to a large positive int
    const deadPid = 2_000_000_000;
    writePid(TEST_SLUG, `${deadPid}\n`);
    expect(isDispatcherPresent(TEST_SLUG)).toBe(false);
  });

  it("isDispatcherPresent returns true when the PID file contains the current process PID", () => {
    writePid(TEST_SLUG, `${process.pid}\n`);
    expect(isDispatcherPresent(TEST_SLUG)).toBe(true);
  });

  it("isDispatcherPresent returns false for a non-existent board slug", () => {
    // The board data dir was never created, so the PID file is missing.
    expect(isDispatcherPresent("ghost-board")).toBe(false);
  });
});
