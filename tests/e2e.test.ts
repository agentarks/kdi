import { describe, it, expect } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initDb, closeDb } from "../src/db";
import { addDependency } from "../src/models/dependency";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function runKdi(args: string, env: Record<string, string> = {}): string {
  const output = execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
  });
  return output.trim();
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kdi-e2e-${prefix}-`));
}

function setupGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m 'initial'", { cwd: dir, stdio: "ignore" });
}

function setupProfiles(homeDir: string, profiles: { name: string; command: string }[]) {
  const configDir = join(homeDir, ".config", "kdi");
  mkdirSync(configDir, { recursive: true });
  const lines = profiles.map((p) => {
    const escaped = p.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `- name: ${p.name}\n  command: "${escaped}"`;
  });
  writeFileSync(join(configDir, "profiles.yaml"), lines.join("\n") + "\n");
}

function startDispatcher(env: Record<string, string>) {
  return spawn("bun", ["run", "src/index.ts", "dispatch", "--interval", "500"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

async function waitForTaskStatus(
  taskId: string,
  status: string,
  env: Record<string, string>,
  timeoutMs = 10000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const output = runKdi(`show ${taskId}`, env);
    const match = output.match(/Status: (\w+)/);
    if (match && match[1] === status) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function getTaskStatus(taskId: string, env: Record<string, string>): string | null {
  const output = runKdi(`show ${taskId}`, env);
  const match = output.match(/Status: (\w+)/);
  return match ? match[1] : null;
}

describe("kdi e2e acceptance", () => {
  it("boards create rejects path traversal slugs", () => {
    const tmp = makeTempDir("board-traversal");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    expect(() => runKdi(`boards create ../../bad --workdir ${repoDir}`, env)).toThrow(/Invalid board slug/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create returns task ID", () => {
    const tmp = makeTempDir("create");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "backend: auth" --board myproj --assignee opencode`, env);

    expect(taskId).toMatch(/^\d+$/);
    expect(parseInt(taskId, 10)).toBeGreaterThan(0);

    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "task promoted to ready is claimed by dispatcher within 10s",
    async () => {
      const tmp = makeTempDir("dispatch");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "testagent", command: "echo done" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "dispatch me" --board myproj --assignee testagent`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it(
    "harness runs in worktree branch wt/<profile>/<task_id>",
    async () => {
      const tmp = makeTempDir("worktree");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "branchagent", command: "git rev-parse --abbrev-ref HEAD" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "branch task" --board myproj --assignee branchagent`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);
      const output = runKdi(`show ${taskId}`, env);
      expect(output).toContain(`wt/branchagent/${taskId}`);

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it(
    "task result stored and visible via show",
    async () => {
      const tmp = makeTempDir("result");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "resultagent", command: "echo hello-result" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "result task" --board myproj --assignee resultagent`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);
      const output = runKdi(`show ${taskId}`, env);
      expect(output).toContain("hello-result");

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it(
    "parent dependency blocks child until parent done",
    async () => {
      const tmp = makeTempDir("deps");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "depagent", command: "echo parent-done" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const parentId = runKdi(`create "parent" --board myproj --assignee depagent`, env);
      const childId = runKdi(`create "child" --board myproj --assignee depagent`, env);

      initDb(dbPath);
      addDependency(parseInt(parentId, 10), parseInt(childId, 10));
      closeDb();

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${childId}`, env);

      await new Promise((r) => setTimeout(r, 1500));
      let childStatus = getTaskStatus(childId, env);
      expect(childStatus).toBe("ready");

      runKdi(`promote ${parentId}`, env);

      const parentDone = await waitForTaskStatus(parentId, "done", env, 10000);
      expect(parentDone).toBe(true);

      const childDone = await waitForTaskStatus(childId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(childDone).toBe(true);

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it(
    "100 tasks created and dispatched without SQLite contention",
    async () => {
      const tmp = makeTempDir("scale");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "scaleagent", command: "echo scale" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);

      const taskIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        const id = runKdi(`create "task ${i}" --board myproj --assignee scaleagent`, env);
        taskIds.push(id);
        runKdi(`promote ${id}`, env);
      }

      const dispatcher = startDispatcher(env);

      const start = Date.now();
      let allDone = false;
      while (Date.now() - start < 60000) {
        let output = "";
        let retries = 0;
        while (retries < 5) {
          try {
            output = runKdi(`list --board myproj --status done`, env);
            break;
          } catch (e: any) {
            if (e.message && e.message.includes("database is locked")) {
              retries++;
              await new Promise((r) => setTimeout(r, 200));
            } else {
              throw e;
            }
          }
        }
        const count = output.includes("No tasks.") ? 0 : output.split("\n").filter((l) => l.trim().length > 0).length;
        if (count === 100) {
          allDone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      dispatcher.kill("SIGTERM");
      expect(allDone).toBe(true);

      rmSync(tmp, { recursive: true, force: true });
    },
    120000
  );

  it("create --initial-status sets task status", () => {
    const tmp = makeTempDir("initial-status");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const blockedId = runKdi(`create "blocked task" --board myproj --initial-status blocked`, env);
    const runningId = runKdi(`create "running task" --board myproj --initial-status running`, env);
    const readyId = runKdi(`create "ready task" --board myproj --initial-status ready`, env);

    expect(getTaskStatus(blockedId, env)).toBe("blocked");
    expect(getTaskStatus(runningId, env)).toBe("running");
    expect(getTaskStatus(readyId, env)).toBe("ready");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --triage is alias for --initial-status triage", () => {
    const tmp = makeTempDir("triage-alias");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const triageId = runKdi(`create "triage task" --board myproj --triage`, env);
    expect(getTaskStatus(triageId, env)).toBe("triage");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create rejects invalid --initial-status", () => {
    const tmp = makeTempDir("invalid-status");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --initial-status invalid`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create rejects --triage used with --initial-status", () => {
    const tmp = makeTempDir("triage-initial-status-conflict");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "conflict" --board myproj --triage --initial-status triage`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --initial-status todo and done work", () => {
    const tmp = makeTempDir("initial-status-todo-done");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const todoId = runKdi(`create "todo task" --board myproj --initial-status todo`, env);
    const doneId = runKdi(`create "done task" --board myproj --initial-status done`, env);

    expect(getTaskStatus(todoId, env)).toBe("todo");
    expect(getTaskStatus(doneId, env)).toBe("done");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --priority sets integer priority", () => {
    const tmp = makeTempDir("priority");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const defaultId = runKdi(`create "default priority" --board myproj`, env);
    const highId = runKdi(`create "high priority" --board myproj --priority 5`, env);

    const defaultOutput = runKdi(`show ${defaultId}`, env);
    const highOutput = runKdi(`show ${highId}`, env);

    expect(defaultOutput).toContain("Priority: 0");
    expect(highOutput).toContain("Priority: 5");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create rejects invalid --priority", () => {
    const tmp = makeTempDir("invalid-priority");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --priority high`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --idempotency-key deduplicates", () => {
    const tmp = makeTempDir("idempotency");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const firstId = runKdi(`create "dedup me" --board myproj --idempotency-key abc-123`, env);
    const secondId = runKdi(`create "dedup me again" --board myproj --idempotency-key abc-123`, env);

    expect(secondId).toBe(firstId);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --idempotency-key rejects empty string", () => {
    const tmp = makeTempDir("idempotency-empty");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "empty key" --board myproj --idempotency-key ""`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("complete stores result, summary, and metadata", () => {
    const tmp = makeTempDir("complete");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_COMPLETE_METADATA: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "complete me" --board myproj`, env);

    runKdi(
      `complete ${taskId} --result "build passed" --summary "green" --metadata '{"tests": 12}'`,
      env
    );

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Status: done");
    expect(output).toContain("Result: build passed");
    expect(output).toContain("Summary: green");

    const runsOutput = runKdi(`runs ${taskId}`, env);
    expect(runsOutput).toContain("outcome=completed");
    expect(runsOutput).toContain('metadata="{"tests": 12}"');

    rmSync(tmp, { recursive: true, force: true });
  });

  it("complete supports bulk task ids with shared result", () => {
    const tmp = makeTempDir("complete-bulk");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const id1 = runKdi(`create "task 1" --board myproj`, env);
    const id2 = runKdi(`create "task 2" --board myproj`, env);

    runKdi(`complete ${id1} ${id2} --result "batch result"`, env);

    expect(getTaskStatus(id1, env)).toBe("done");
    expect(getTaskStatus(id2, env)).toBe("done");
    expect(runKdi(`show ${id1}`, env)).toContain("Result: batch result");
    expect(runKdi(`show ${id2}`, env)).toContain("Result: batch result");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("complete rejects invalid metadata", () => {
    const tmp = makeTempDir("complete-bad-metadata");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_COMPLETE_METADATA: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "bad metadata" --board myproj`, env);

    expect(() =>
      runKdi(`complete ${taskId} --metadata not-json`, env)
    ).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("review sets status to review and stores reason", () => {
    const tmp = makeTempDir("review");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_REVIEW_STATUS: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "review me" --board myproj`, env);

    runKdi(`review ${taskId} --reason "needs second look"`, env);

    expect(getTaskStatus(taskId, env)).toBe("review");
    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("needs second look");
    expect(output).toContain("Review reason:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "dispatcher times out harness exceeding --max-runtime",
    async () => {
      const tmp = makeTempDir("max-runtime-timeout");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "slowagent", command: "sleep 5" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true", FF_MAX_RUNTIME: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "slow task" --board myproj --assignee slowagent --max-runtime 1s`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "blocked", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);
      const output = runKdi(`show ${taskId}`, env);
      expect(output).toContain("timed out");

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it("kdi --version returns semantic version", () => {
    const tmp = makeTempDir("version");
    const dbPath = join(tmp, "kdi.db");
    const env = { KDI_DB: dbPath, HOME: tmp };
    const output = runKdi("--version", env);
    expect(output).toMatch(/^\d+\.\d+\.\d+$/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "adding new harness profile requires zero code changes",
    async () => {
      const tmp = makeTempDir("profile");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "zerocode", command: "echo zero-code-profile" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "zero code" --board myproj --assignee zerocode`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);
      const output = runKdi(`show ${taskId}`, env);
      expect(output).toContain("zero-code-profile");

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it("create --tenant stores tenant when flag enabled", () => {
    const tmp = makeTempDir("tenant-create");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_TENANT_NAMESPACE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "backend task" --board myproj --tenant backend`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Tenant: backend");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --tenant filters by tenant", () => {
    const tmp = makeTempDir("tenant-list");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_TENANT_NAMESPACE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "backend task" --board myproj --tenant backend`, env);
    runKdi(`create "frontend task" --board myproj --tenant frontend`, env);
    runKdi(`create "untask" --board myproj`, env);

    const output = runKdi(`list --board myproj --tenant backend`, env);
    expect(output).toContain("backend task");
    expect(output).not.toContain("frontend task");
    expect(output).not.toContain("untask");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --tenant composes with --status", () => {
    const tmp = makeTempDir("tenant-composed");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_TENANT_NAMESPACE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const readyBackend = runKdi(`create "ready backend" --board myproj --tenant backend`, env);
    runKdi(`create "todo backend" --board myproj --tenant backend`, env);
    runKdi(`create "ready frontend" --board myproj --tenant frontend`, env);
    runKdi(`promote ${readyBackend}`, env);

    const output = runKdi(`list --board myproj --tenant backend --status ready`, env);
    expect(output).toContain("ready backend");
    expect(output).not.toContain("todo backend");
    expect(output).not.toContain("ready frontend");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --tenant composes with --assignee", () => {
    const tmp = makeTempDir("tenant-assignee");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_TENANT_NAMESPACE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "backend alice" --board myproj --tenant backend --assignee alice`, env);
    runKdi(`create "backend bob" --board myproj --tenant backend --assignee bob`, env);
    runKdi(`create "frontend alice" --board myproj --tenant frontend --assignee alice`, env);

    const output = runKdi(`list --board myproj --tenant backend --assignee alice`, env);
    expect(output).toContain("backend alice");
    expect(output).not.toContain("backend bob");
    expect(output).not.toContain("frontend alice");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --tenant rejects empty tenant", () => {
    const tmp = makeTempDir("tenant-list-empty");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_TENANT_NAMESPACE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`list --board myproj --tenant ""`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --tenant rejected when flag disabled", () => {
    const tmp = makeTempDir("tenant-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "backend task" --board myproj --tenant backend`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --tenant rejected when flag disabled", () => {
    const tmp = makeTempDir("tenant-list-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`list --board myproj --tenant backend`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --tenant rejects empty tenant", () => {
    const tmp = makeTempDir("tenant-empty");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_TENANT_NAMESPACE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --tenant ""`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --skill stores skills array when flag enabled", () => {
    const tmp = makeTempDir("skills");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SKILLS_ARRAY: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "skilled task" --board myproj --skill github --skill "code-review"`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Skills: github, code-review");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --skill rejected when flag disabled", () => {
    const tmp = makeTempDir("skills-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --skill github`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --skill rejects invalid skill names", () => {
    const tmp = makeTempDir("skills-invalid");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SKILLS_ARRAY: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --skill "github; rm -rf /"`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --max-runtime stores seconds when flag enabled", () => {
    const tmp = makeTempDir("max-runtime");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_MAX_RUNTIME: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "capped task" --board myproj --max-runtime 5m`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Max runtime: 300s");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --max-runtime is rejected when flag disabled", () => {
    const tmp = makeTempDir("max-runtime-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "capped task" --board myproj --max-runtime 30s`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --created-by stores and displays creator when enabled", () => {
    const tmp = makeTempDir("created-by");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "track me" --board myproj --created-by alice`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Created by: alice");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create falls back to KDI_CREATED_BY env var when enabled", () => {
    const tmp = makeTempDir("created-by-env");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "true", KDI_CREATED_BY: "bob" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "env creator" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Created by: bob");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create falls back to USER env var when enabled and no explicit creator", () => {
    const tmp = makeTempDir("created-by-user");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "true", KDI_CREATED_BY: "", USER: "charlie" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "default creator" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Created by: charlie");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create ignores empty KDI_CREATED_BY and falls back to USER", () => {
    const tmp = makeTempDir("created-by-empty-env");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "true", KDI_CREATED_BY: "", USER: "dave" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "skip empty env" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Created by: dave");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --created-by filters tasks when enabled", () => {
    const tmp = makeTempDir("created-by-list");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "alice task" --board myproj --created-by alice`, env);
    runKdi(`create "bob task" --board myproj --created-by bob`, env);

    const output = runKdi(`list --board myproj --created-by alice`, env);
    expect(output).toContain("alice task");
    expect(output).not.toContain("bob task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --created-by is rejected when flag is disabled", () => {
    const tmp = makeTempDir("created-by-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "hidden" --board myproj --created-by alice`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list --created-by is rejected when flag is disabled", () => {
    const tmp = makeTempDir("created-by-list-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "plain" --board myproj`, env);
    expect(() => runKdi(`list --board myproj --created-by alice`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show does not display created_by when flag is disabled", () => {
    const tmp = makeTempDir("created-by-show-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "plain" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).not.toContain("Created by:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --created-by rejects identifiers longer than 255 chars", () => {
    const tmp = makeTempDir("created-by-too-long");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_CREATED_BY: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const longCreator = "a".repeat(256);
    expect(() => runKdi(`create "bad" --board myproj --created-by ${longCreator}`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --model stores and displays model override when flag enabled", () => {
    const tmp = makeTempDir("model-override");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_MODEL_OVERRIDE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "model task" --board myproj --model gpt-5.5`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Model override: gpt-5.5");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --model is rejected when flag disabled", () => {
    const tmp = makeTempDir("model-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --model gpt-5.5`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show does not display model override when flag disabled", () => {
    const tmp = makeTempDir("model-show-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_MODEL_OVERRIDE: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "plain" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).not.toContain("Model override:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --max-retries stores value when flag enabled", () => {
    const tmp = makeTempDir("max-retries");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_MAX_RETRIES: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "retry task" --board myproj --max-retries 3`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Max retries: 3");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --max-retries is rejected when flag disabled", () => {
    const tmp = makeTempDir("max-retries-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "retry task" --board myproj --max-retries 3`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --max-retries rejects invalid values", () => {
    const tmp = makeTempDir("max-retries-invalid");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_MAX_RETRIES: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "bad" --board myproj --max-retries -1`, env)).toThrow();
    expect(() => runKdi(`create "bad" --board myproj --max-retries abc`, env)).toThrow();
    expect(() => runKdi(`create "bad" --board myproj --max-retries 1.5`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "dispatcher circuit breaker requeues then blocks after max-retries",
    async () => {
      const tmp = makeTempDir("max-retries-circuit");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "failagent", command: "exit 1" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true", FF_MAX_RETRIES: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "circuit task" --board myproj --assignee failagent --max-retries 3`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "blocked", env, 15000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);
      const output = runKdi(`show ${taskId}`, env);
      expect(output).toContain("Circuit breaker");
      expect(output).toContain("Consecutive failures: 3");

      rmSync(tmp, { recursive: true, force: true });
    },
    25000
  );

  it("boards create stores metadata when flag enabled", () => {
    const tmp = makeTempDir("board-metadata");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_METADATA: "true" };

    runKdi(`boards create myproj --workdir ${repoDir} --name "My Project" --icon rocket --color "#123456"`, env);
    const output = runKdi(`boards show myproj`, env);
    expect(output).toContain("Name: My Project");
    expect(output).toContain("Icon: rocket");
    expect(output).toContain("Color: #123456");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards create --name is rejected when flag disabled", () => {
    const tmp = makeTempDir("board-metadata-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    expect(() => runKdi(`boards create myproj --workdir ${repoDir} --name "My Project"`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards edit updates metadata when flag enabled", () => {
    const tmp = makeTempDir("board-metadata-edit");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_METADATA: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`boards edit myproj --name "Updated" --icon star`, env);
    const output = runKdi(`boards show myproj`, env);
    expect(output).toContain("Name: Updated");
    expect(output).toContain("Icon: star");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards edit is rejected when flag disabled", () => {
    const tmp = makeTempDir("board-metadata-edit-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`boards edit myproj --name "Updated"`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards rm archives a board by default", () => {
    const tmp = makeTempDir("boards-rm-soft");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const output = runKdi(`boards rm myproj`, env);
    expect(output).toContain("Archived board");

    const listOutput = runKdi(`boards list --all`, env);
    expect(listOutput).toContain("myproj");
    expect(listOutput).toContain("archived");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards rm --delete permanently deletes board when flag enabled", () => {
    const tmp = makeTempDir("boards-rm-delete");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_RM_DELETE: "true" };
    const boardDir = join(dirname(dbPath), "boards", "myproj");
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(join(boardDir, "kanban.db"), "dummy");

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const output = runKdi(`boards rm myproj --delete`, env);
    expect(output).toContain("Deleted board");

    const listOutput = runKdi(`boards list --all`, env);
    expect(listOutput).not.toContain("myproj");
    expect(existsSync(boardDir)).toBe(false);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards rm --delete exits non-zero on non-existent slug", () => {
    const tmp = makeTempDir("boards-rm-delete-missing");
    const dbPath = join(tmp, "kdi.db");
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_RM_DELETE: "true" };

    expect(() => runKdi(`boards rm missing --delete`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards rm --delete is rejected when flag is disabled", () => {
    const tmp = makeTempDir("boards-rm-delete-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_RM_DELETE: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`boards rm myproj --delete`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });


  it("boards switch writes current board and boards show reads it", () => {
    const tmp = makeTempDir("boards-switch");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" };

    runKdi(`boards create alpha --workdir ${repoDir}`, env);
    runKdi(`boards create beta --workdir ${repoDir}`, env);

    // Before switching, show without slug should resolve via chain (no current file yet -> "default")
    expect(() => runKdi(`boards show`, env)).toThrow(/not found/);

    // Switch to alpha
    const switchOutput1 = runKdi(`boards switch alpha`, env);
    expect(switchOutput1).toContain("Switched to board");

    // boards show (without args) shows alpha
    const showOutput1 = runKdi(`boards show`, env);
    expect(showOutput1).toContain("Board: alpha");

    // Switch to beta
    runKdi(`boards switch beta`, env);
    const showOutput2 = runKdi(`boards show`, env);
    expect(showOutput2).toContain("Board: beta");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("board resolution chain: --board overrides current", () => {
    const tmp = makeTempDir("boards-chain-explicit");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" };

    runKdi(`boards create alpha --workdir ${repoDir}`, env);
    runKdi(`boards create beta --workdir ${repoDir}`, env);

    // Switch to alpha
    runKdi(`boards switch alpha`, env);

    // Create with explicit --board beta should go to beta
    const taskId = runKdi(`create "explicit board task" --board beta`, env);
    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).toContain("Title: explicit board task");

    // show board beta should have the task
    const boardShow = runKdi(`boards show beta`, env);
    expect(boardShow).toMatch(/todo:\s+1/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("board resolution chain: KDI_BOARD env overrides current file", () => {
    const tmp = makeTempDir("boards-chain-env");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);

    runKdi(`boards create alpha --workdir ${repoDir}`, { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" });
    runKdi(`boards create beta --workdir ${repoDir}`, { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" });

    // Switch to alpha
    runKdi(`boards switch alpha`, { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" });

    // Create with KDI_BOARD=beta should use beta
    const taskId = runKdi(
      `create "env board task"`,
      { KDI_DB: dbPath, HOME: tmp, KDI_BOARD: "beta" }
    );
    const showOutput = runKdi(`show ${taskId}`, { KDI_DB: dbPath, HOME: tmp });
    expect(showOutput).toContain("Title: env board task");

    // show board beta should have the task
    const boardShow = runKdi(`boards show beta`, { KDI_DB: dbPath, HOME: tmp });
    expect(boardShow).toMatch(/todo:\s+1/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("board resolution chain falls through to current file when no --board or KDI_BOARD", () => {
    const tmp = makeTempDir("boards-chain-current");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" };

    runKdi(`boards create alpha --workdir ${repoDir}`, env);
    runKdi(`boards create beta --workdir ${repoDir}`, env);

    // Switch to beta
    runKdi(`boards switch beta`, env);

    // Create without --board and without KDI_BOARD should use current (beta)
    const taskId = runKdi(`create "current board task"`, env);
    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).toContain("Title: current board task");

    // show board beta should have the task
    const boardShow = runKdi(`boards show beta`, env);
    expect(boardShow).toMatch(/todo:\s+1/);

    // show board alpha should NOT have the task
    const boardShowAlpha = runKdi(`boards show alpha`, env);
    expect(boardShowAlpha).toMatch(/todo:\s+0/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards switch rejects invalid slug", () => {
    const tmp = makeTempDir("boards-switch-invalid");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" };

    runKdi(`boards create valid --workdir ${repoDir}`, env);

    expect(() => runKdi(`boards switch ../evil`, env)).toThrow(/Invalid board slug/);
    expect(() => runKdi(`boards switch ""`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards switch rejects non-existent board", () => {
    const tmp = makeTempDir("boards-switch-nonexistent");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "true" };

    expect(() => runKdi(`boards switch missing`, env)).toThrow(/not found/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards switch is rejected when flag disabled", () => {
    const tmp = makeTempDir("boards-switch-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_SWITCH: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`boards switch myproj`, env)).toThrow(/not enabled/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("list command resolves board via chain", () => {
    const tmp = makeTempDir("list-chain");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "task 1" --board myproj`, env);
    runKdi(`create "task 2" --board myproj`, env);

    // List without --board should use default (doesn't exist) -> error
    expect(() => runKdi(`list`, env)).toThrow(/not found/);

    // List with --board works
    const listOutput = runKdi(`list --board myproj`, env);
    expect(listOutput).toContain("task 1");
    expect(listOutput).toContain("task 2");

    rmSync(tmp, { recursive: true, force: true });
  });

});
