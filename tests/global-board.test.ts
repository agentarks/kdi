import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function runKdi(args: string[], env: Record<string, string> = {}): { ok: boolean; stdout: string; stderr: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
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

function runKdiWithDb(args: string[], env: Record<string, string>, db: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = execFileSync("bun", ["run", "src/index.ts", ...args], {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      env: { ...process.env, KDI_DB: db, ...env },
    });
    return { ok: true, stdout: result, stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

describe("FF_GLOBAL_BOARD (kdi --board ...)", () => {
  it("passes --board through to a subcommand that consumes it via env (KDI_BOARD)", () => {
    // Create a board, then run `kdi --board myproj list` and confirm the
    // subcommand resolves the board (it has to find the board, not error
    // with 'Board "default" not found' which would mean --board was ignored).
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      const r1 = runKdiWithDb(["boards", "create", "myproj", "--workdir", "/tmp/myproj"], { FF_GLOBAL_BOARD: "true" }, db);
      expect(r1.ok).toBe(true);
      const r2 = runKdiWithDb(["--board", "myproj", "list"], { FF_GLOBAL_BOARD: "true" }, db);
      expect(r2.ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("subcommand --board wins over global --board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      const r1 = runKdiWithDb(["boards", "create", "real", "--workdir", "/tmp/real"], { FF_GLOBAL_BOARD: "true" }, db);
      expect(r1.ok).toBe(true);
      // Global --board points at a nonexistent slug; subcommand --board points
      // at the real one. The subcommand must win (else we'd see "Board
      // 'nonexistent' not found").
      const r2 = runKdiWithDb(["--board", "nonexistent", "list", "--board", "real"], { FF_GLOBAL_BOARD: "true" }, db);
      expect(r2.ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("without FF_GLOBAL_BOARD, --board is rejected with a clear error", () => {
    const r = runKdi(["--board", "myproj", "boards", "list"]);
    expect(r.ok).toBe(false);
    expect(r.stderr + r.stdout).toContain("Global --board flag is not enabled");
  });
});
