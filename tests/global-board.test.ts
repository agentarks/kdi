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

describe("FF_GLOBAL_BOARD (kdi --board ...)", () => {
  it("passes --board through to the subcommand when no per-subcommand --board", () => {
    const r = runKdi(["--board", "myproj", "boards", "list"], { FF_GLOBAL_BOARD: "true" });
    expect(r.ok).toBe(true);
  });

  it("subcommand --board wins over global --board", () => {
    // Use a shared tmpDir so the board persists across the two kdi calls.
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const testDb = join(tmpDir, "kdi.db");
    try {
      const r1 = runKdi(
        ["boards", "create", "real", "--workdir", "/tmp/real"],
        { FF_GLOBAL_BOARD: "true", KDI_DB: testDb }
      );
      expect(r1.ok).toBe(true);
      const r2 = runKdi(
        ["--board", "nonexistent", "boards", "show", "real"],
        { FF_GLOBAL_BOARD: "true", KDI_DB: testDb }
      );
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
