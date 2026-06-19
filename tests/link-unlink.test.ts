import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask } from "../src/models/task";
import { addDependency, removeDependency, isBlockedByDependencies } from "../src/models/dependency";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, setFlag } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

const TEST_DB = "/tmp/kdi-link-unlink-test.db";

function runKdi(args: string[], env: Record<string, string> = {}): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = execFileSync("bun", ["run", "src/index.ts", ...args], {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      env: { ...process.env, KDI_DB: TEST_DB, ...env },
    });
    return { ok: true, stdout: result, stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

describe("FF_LINK_UNLINK (kdi link / kdi unlink)", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("kdi link creates a dependency; child is blocked while parent is non-done", () => {
    const board = createBoard("b1", "/tmp/b1");
    const p = createTask({ board_id: board.id, title: "P", body: "p" });
    const c = createTask({ board_id: board.id, title: "C", body: "c" });
    promoteTask(p.id);
    promoteTask(c.id);
    expect(isBlockedByDependencies(c.id)).toBe(false);

    setFlag("FF_LINK_UNLINK" as any, true);
    const r = runKdi(["link", String(p.id), String(c.id)], { FF_LINK_UNLINK: "true", KDI_DB: TEST_DB });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain(`Linked ${p.id} -> ${c.id}`);

    expect(isBlockedByDependencies(c.id)).toBe(true);
  });

  it("kdi unlink removes the dependency", () => {
    const board = createBoard("b1", "/tmp/b1");
    const p = createTask({ board_id: board.id, title: "P", body: "p" });
    const c = createTask({ board_id: board.id, title: "C", body: "c" });
    addDependency(p.id, c.id);
    expect(isBlockedByDependencies(c.id)).toBe(true);

    setFlag("FF_LINK_UNLINK" as any, true);
    const r = runKdi(["unlink", String(p.id), String(c.id)], { FF_LINK_UNLINK: "true", KDI_DB: TEST_DB });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain(`Unlinked ${p.id} -> ${c.id}`);
    expect(isBlockedByDependencies(c.id)).toBe(false);
  });

  it("kdi link errors on self-dependency", () => {
    const board = createBoard("b1", "/tmp/b1");
    const p = createTask({ board_id: board.id, title: "P", body: "p" });
    setFlag("FF_LINK_UNLINK" as any, true);
    const r = runKdi(["link", String(p.id), String(p.id)], { FF_LINK_UNLINK: "true", KDI_DB: TEST_DB });
    expect(r.ok).toBe(false);
    expect(r.stdout + r.stderr).toContain("Self-dependency");
  });

  it("kdi link errors on circular dependency", () => {
    const board = createBoard("b1", "/tmp/b1");
    const a = createTask({ board_id: board.id, title: "A", body: "a" });
    const b = createTask({ board_id: board.id, title: "B", body: "b" });
    addDependency(a.id, b.id);
    setFlag("FF_LINK_UNLINK" as any, true);
    // Try b -> a, which would create a cycle.
    const r = runKdi(["link", String(b.id), String(a.id)], { FF_LINK_UNLINK: "true", KDI_DB: TEST_DB });
    expect(r.ok).toBe(false);
    expect(r.stdout + r.stderr).toContain("Circular");
  });

  it("kdi link / unlink without FF_LINK_UNLINK errors", () => {
    const r1 = runKdi(["link", "1", "2"]);
    expect(r1.ok).toBe(false);
    expect(r1.stdout + r1.stderr).toContain("Link/unlink feature is not enabled");
    const r2 = runKdi(["unlink", "1", "2"]);
    expect(r2.ok).toBe(false);
    expect(r2.stdout + r2.stderr).toContain("Link/unlink feature is not enabled");
  });
});
