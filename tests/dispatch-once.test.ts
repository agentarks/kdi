import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { initDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

const TEST_DB = "/tmp/kdi-dispatch-once-test.db";

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

describe("FF_DISPATCH_ONCE (kdi dispatch --once)", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("--once runs a single tick and exits, regardless of no ready tasks", () => {
    const r = runKdi(
      ["dispatch", "--once"],
      { FF_ENABLE_KANBAN_DISPATCH: "true", FF_DISPATCH_ONCE: "true" }
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("one-shot");
  });

  it("--once without FF_DISPATCH_ONCE errors with a clear message", () => {
    const r = runKdi(
      ["dispatch", "--once"],
      { FF_ENABLE_KANBAN_DISPATCH: "true", FF_DISPATCH_ONCE: "false" }
    );
    expect(r.ok).toBe(false);
    expect(r.stdout + r.stderr).toContain("--once is not enabled");
  });
});
