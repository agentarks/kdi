import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function runKdi(args: string[], env: Record<string, string> = {}): { ok: boolean; stdout: string; stderr: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
  const testDb = join(tmpDir, "kdi.db");
  try {
    const result = execFileSync("bun", ["run", "src/index.ts", ...args], {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      env: { ...process.env, KDI_DB: testDb, FF_GLOBAL_BOARD: "true", ...env },
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
      env: { ...process.env, KDI_DB: db, FF_GLOBAL_BOARD: "true", ...env },
    });
    return { ok: true, stdout: result, stderr: "" };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

function setupProfiles(home: string): void {
  const configDir = join(home, ".config", "kdi");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "profiles.yaml"),
    "- name: noop\n  command: \"true\"\n  agent: noop\n",
    "utf-8"
  );
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# init", "utf-8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

describe("global --board flag", () => {
  it("create resolves the board from global --board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      const r1 = runKdiWithDb(["boards", "create", "myproj", "--workdir", "/tmp/myproj"], {}, db);
      expect(r1.ok).toBe(true);
      const r2 = runKdiWithDb(["--board", "myproj", "create", "global board task"], {}, db);
      expect(r2.ok).toBe(true);
      const r3 = runKdiWithDb(["--board", "myproj", "list"], {}, db);
      expect(r3.ok).toBe(true);
      expect(r3.stdout).toContain("global board task");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("show resolves the board from global --board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      runKdiWithDb(["boards", "create", "myproj", "--workdir", "/tmp/myproj"], {}, db);
      const createResult = runKdiWithDb(["--board", "myproj", "create", "global show task"], {}, db);
      expect(createResult.ok).toBe(true);
      const taskId = createResult.stdout.trim();
      const showResult = runKdiWithDb(["--board", "myproj", "show", taskId], {}, db);
      expect(showResult.ok).toBe(true);
      expect(showResult.stdout).toContain("global show task");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("list resolves the board from global --board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      runKdiWithDb(["boards", "create", "myproj", "--workdir", "/tmp/myproj"], {}, db);
      runKdiWithDb(["--board", "myproj", "create", "global list task"], {}, db);
      const listResult = runKdiWithDb(["--board", "myproj", "list"], {}, db);
      expect(listResult.ok).toBe(true);
      expect(listResult.stdout).toContain("global list task");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dispatch resolves the board from global --board and filters to that board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-dispatch-"));
    const db = join(tmpDir, "kdi.db");
    const home = join(tmpDir, "home");
    const alphaRepo = join(tmpDir, "alpha-repo");
    const betaRepo = join(tmpDir, "beta-repo");
    try {
      setupProfiles(home);
      initGitRepo(alphaRepo);
      initGitRepo(betaRepo);

      const env = {
        HOME: home,
        FF_ENABLE_KANBAN_DISPATCH: "true",
        FF_DISPATCH_ONCE: "true",
      };

      runKdiWithDb(["boards", "create", "alpha", "--workdir", alphaRepo], env, db);
      runKdiWithDb(["boards", "create", "beta", "--workdir", betaRepo], env, db);

      const alphaTask = runKdiWithDb(["--board", "alpha", "create", "alpha ready", "--assignee", "noop", "--initial-status", "ready"], env, db).stdout.trim();
      const betaTask = runKdiWithDb(["--board", "beta", "create", "beta ready", "--assignee", "noop", "--initial-status", "ready"], env, db).stdout.trim();

      const dispatchResult = runKdiWithDb(["--board", "alpha", "dispatch", "--once"], env, db);
      expect(dispatchResult.ok).toBe(true);
      expect(dispatchResult.stdout).toContain("processed=1");

      const alphaShow = runKdiWithDb(["--board", "alpha", "show", alphaTask], env, db);
      expect(alphaShow.stdout).toContain("Status: done");

      const betaShow = runKdiWithDb(["--board", "beta", "show", betaTask], env, db);
      expect(betaShow.stdout).toContain("Status: ready");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("swarm resolves the board from global --board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-swarm-"));
    const db = join(tmpDir, "kdi.db");
    const home = join(tmpDir, "home");
    try {
      setupProfiles(home);
      const env = { HOME: home, FF_SWARM_MODE: "true" };
      runKdiWithDb(["boards", "create", "swarmproj", "--workdir", "/tmp/swarmproj"], env, db);
      const swarmResult = runKdiWithDb(
        ["--board", "swarmproj", "swarm", "--worker", "noop:worker1", "--verifier", "noop", "--synthesizer", "noop"],
        env,
        db
      );
      expect(swarmResult.ok).toBe(true);
      expect(swarmResult.stdout).toContain("Created swarm orchestrator");
      const listResult = runKdiWithDb(["--board", "swarmproj", "list"], env, db);
      expect(listResult.stdout).toContain("worker1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("subcommand --board wins over global --board", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      const r1 = runKdiWithDb(["boards", "create", "real", "--workdir", "/tmp/real"], {}, db);
      expect(r1.ok).toBe(true);
      const r2 = runKdiWithDb(["--board", "nonexistent", "list", "--board", "real"], {}, db);
      expect(r2.ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("global --board overrides KDI_BOARD env in the resolution chain", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      runKdiWithDb(["boards", "create", "target", "--workdir", "/tmp/target"], {}, db);
      const r = runKdiWithDb(["--board", "target", "create", "env override task"], { KDI_BOARD: "missing" }, db);
      expect(r.ok).toBe(true);
      const list = runKdiWithDb(["--board", "target", "list"], {}, db);
      expect(list.stdout).toContain("env override task");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects global --board when FF_GLOBAL_BOARD is disabled", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      runKdiWithDb(["boards", "create", "myproj", "--workdir", "/tmp/myproj"], {}, db);
      const r = runKdiWithDb(["--board", "myproj", "list"], { FF_GLOBAL_BOARD: "false" }, db);
      expect(r.ok).toBe(false);
      expect(r.stderr + r.stdout).toContain("Global --board flag is not enabled");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls through to KDI_BOARD env when no --board flag is given", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kdi-global-board-"));
    const db = join(tmpDir, "kdi.db");
    try {
      runKdiWithDb(["boards", "create", "envboard", "--workdir", "/tmp/envboard"], {}, db);
      runKdiWithDb(["create", "env fallback task"], { KDI_BOARD: "envboard" }, db);
      const list = runKdiWithDb(["list"], { KDI_BOARD: "envboard" }, db);
      expect(list.stdout).toContain("env fallback task");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
