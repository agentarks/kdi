import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db";
import { createBoard, showBoard } from "../src/models/board";
import { createTask, listTasks } from "../src/models/task";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, setFlag } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function runKdi(args: string[], env: Record<string, string> = {}): { ok: boolean; stdout: string; stderr: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "kdi-specify-tenant-"));
  const testDb = join(tmpDir, "kdi.db");
  try {
    const result = execFileSync("bun", ["run", "src/index.ts", ...args], {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      env: { ...process.env, KDI_DB: testDb, ...env },
    });
    return { ok: true, stdout: result, stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const TEST_DB = "/tmp/kdi-specify-tenant-test.db";

describe("FF_TRIAGE_AUTOMATION (kdi specify --tenant sweep)", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
    setFlag("FF_TRIAGE_AUTOMATION" as any, true);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("kdi specify --tenant X (no --all, no task id) sweeps all triage in that tenant", () => {
    const board = createBoard("b1", "/tmp/b1");
    createTask({ board_id: board.id, title: "T1", body: "b1", triage: true });
    createTask({ board_id: board.id, title: "T2", body: "b2", triage: true, tenant: "backend" });
    createTask({ board_id: board.id, title: "T3", body: "b3", triage: true, tenant: "backend" });
    createTask({ board_id: board.id, title: "T4", body: "b4", triage: true, tenant: "frontend" });

    const r = runKdi(["specify", "--tenant", "backend", "--skip-llm", "--board", "b1"], { KDI_DB: TEST_DB, FF_TRIAGE_AUTOMATION: "true" });
    expect(r.ok).toBe(true);

    // Only tenant=backend tasks should be specified (promoted to todo)
    const todo = listTasks({ board_id: board.id, status: "todo" }).map(t => t.title).sort();
    expect(todo).toEqual(["T2", "T3"]);
    const triage = listTasks({ board_id: board.id, status: "triage" }).map(t => t.title).sort();
    expect(triage).toEqual(["T1", "T4"]);
  });
});
