import { describe, it, expect } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initDb, closeDb, getDb } from "../src/db";
import { addDependency } from "../src/models/dependency";
import { getEvents } from "../src/models/taskEvent";

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

  it("kdi dispatch --rate-limit-cooldown is rejected when flag is disabled", () => {
    const tmp = makeTempDir("rate-limit-cooldown-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`dispatch --rate-limit-cooldown 30s`, env)).toThrow(/Rate-limit exit code handling is not enabled/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "kdi dispatch --rate-limit-cooldown sets cooldown duration when flag enabled",
    async () => {
      const tmp = makeTempDir("rate-limit-cooldown-enabled");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "rateagent", command: "exit 75" }]);
      const env = {
        KDI_DB: dbPath,
        HOME: tmp,
        FF_ENABLE_KANBAN_DISPATCH: "true",
        FF_RATE_LIMIT_EXIT_CODE: "true",
      };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "rate task" --board myproj --assignee rateagent`, env);

      const dispatcher = spawn("bun", ["run", "src/index.ts", "dispatch", "--interval", "500", "--rate-limit-cooldown", "2m"], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, ...env },
        stdio: "ignore",
      });

      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "ready", env, 10000);
      expect(ok).toBe(true);

      // Wait for the dispatcher to process the EX_TEMPFAIL and set the cooldown.
      let output = "";
      let cooldownLine = false;
      const start = Date.now();
      while (Date.now() - start < 10000) {
        output = runKdi(`show ${taskId}`, env);
        if (output.includes("Rate limited until:")) {
          cooldownLine = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      dispatcher.kill("SIGTERM");

      expect(cooldownLine).toBe(true);

      const match = output.match(/Rate limited until: ([^\n]+)/);
      expect(match).not.toBeNull();
      const cooldown = new Date(match![1]).getTime();
      const now = Date.now();
      expect(cooldown).toBeGreaterThanOrEqual(now + 110000);
      expect(cooldown).toBeLessThanOrEqual(now + 130000);

      rmSync(tmp, { recursive: true, force: true });
    },
    25000
  );

  it("show displays rate limited until when flag enabled and cooldown is set", () => {
    const tmp = makeTempDir("rate-limit-show-enabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RATE_LIMIT_EXIT_CODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "rate show task" --board myproj`, env);

    initDb(dbPath);
    getDb().run("UPDATE tasks SET rate_limited_until = unixepoch() + 60 WHERE id = ?", [parseInt(taskId, 10)]);
    closeDb();

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Rate limited until:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show hides rate limited until when flag is disabled", () => {
    const tmp = makeTempDir("rate-limit-show-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RATE_LIMIT_EXIT_CODE: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "rate hide task" --board myproj`, env);

    initDb(dbPath);
    getDb().run("UPDATE tasks SET rate_limited_until = unixepoch() + 60 WHERE id = ?", [parseInt(taskId, 10)]);
    closeDb();

    const output = runKdi(`show ${taskId}`, env);
    expect(output).not.toContain("Rate limited until:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards create stores metadata when flag enabled", () => {
    const tmp = makeTempDir("board-metadata");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_BOARD_METADATA: "true" };

    runKdi(`boards create myproj --workdir ${repoDir} --name "My Project" --icon rocket --color "#123456" --description "Project board"`, env);
    const output = runKdi(`boards show myproj`, env);
    expect(output).toContain("Name: My Project");
    expect(output).toContain("Icon: rocket");
    expect(output).toContain("Color: #123456");
    expect(output).toContain("Description: Project board");

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
    runKdi(`boards edit myproj --name "Updated" --icon star --description "Updated description"`, env);
    const output = runKdi(`boards show myproj`, env);
    expect(output).toContain("Name: Updated");
    expect(output).toContain("Icon: star");
    expect(output).toContain("Description: Updated description");

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

  it("boards create --description is rejected when flag disabled", () => {
    const tmp = makeTempDir("board-description-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp };

    expect(() => runKdi(`boards create myproj --workdir ${repoDir} --description "Project board"`, env)).toThrow();

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

  it("boards set-default-workdir stores and displays defaultWorkdir when flag enabled", () => {
    const tmp = makeTempDir("default-workdir-set");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    const defaultDir = join(tmp, "default");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const output = runKdi(`boards set-default-workdir myproj ${defaultDir}`, env);
    expect(output).toContain(`Default workdir for board "myproj" set to ${defaultDir}`);

    const showOutput = runKdi(`boards show myproj`, env);
    expect(showOutput).toContain(`Default workdir: ${defaultDir}`);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards set-default-workdir clears defaultWorkdir when path is omitted", () => {
    const tmp = makeTempDir("default-workdir-clear");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    const defaultDir = join(tmp, "default");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`boards set-default-workdir myproj ${defaultDir}`, env);
    const output = runKdi(`boards set-default-workdir myproj`, env);
    expect(output).toContain(`Default workdir for board "myproj" cleared`);

    const showOutput = runKdi(`boards show myproj`, env);
    expect(showOutput).not.toContain("Default workdir:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("boards set-default-workdir is rejected when flag is disabled", () => {
    const tmp = makeTempDir("default-workdir-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`boards set-default-workdir myproj ${repoDir}`, env)).toThrow();

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

  describe("kdi init", () => {
    it("kdi init creates database and reports path", () => {
      const tmp = makeTempDir("init-create");
      const dbPath = join(tmp, "kdi.db");
      const env = { KDI_DB: dbPath, HOME: tmp };

      const output = runKdi("init", env);
      expect(output).toContain("Database initialized at");
      expect(output).toContain(dbPath);
      expect(existsSync(dbPath)).toBe(true);

      rmSync(tmp, { recursive: true, force: true });
    });

    it("kdi init is idempotent", () => {
      const tmp = makeTempDir("init-idempotent");
      const dbPath = join(tmp, "kdi.db");
      const env = { KDI_DB: dbPath, HOME: tmp };

      runKdi("init", env);
      const output = runKdi("init", env);
      expect(output).toContain("Database initialized at");

      rmSync(tmp, { recursive: true, force: true });
    });

    it("kdi init --force re-runs schema and migrations", () => {
      const tmp = makeTempDir("init-force");
      const dbPath = join(tmp, "kdi.db");
      const env = { KDI_DB: dbPath, HOME: tmp };

      // Initialize once
      runKdi("init", env);
      expect(existsSync(dbPath)).toBe(true);

      // Force re-init
      const output = runKdi("init --force", env);
      expect(output).toContain("Database initialized at");

      rmSync(tmp, { recursive: true, force: true });
    });

    it("kdi init --path <path> initializes at custom path", () => {
      const tmp = makeTempDir("init-path");
      const customDbPath = join(tmp, "custom", "nested", "kdi.db");
      const env = { KDI_DB: join(tmp, "other.db"), HOME: tmp };

      const output = runKdi(`init --path ${customDbPath}`, env);
      expect(output).toContain("Database initialized at");
      expect(output).toContain(customDbPath);
      expect(existsSync(customDbPath)).toBe(true);

      rmSync(tmp, { recursive: true, force: true });
    });

    it("kdi init --help shows documentation", () => {
      const tmp = makeTempDir("init-help");
      const dbPath = join(tmp, "kdi.db");
      const env = { KDI_DB: dbPath, HOME: tmp };

      const output = runKdi("init --help", env);
      expect(output).toContain("Initialize the kdi database");
      expect(output).toContain("--force");
      expect(output).toContain("--path");

      rmSync(tmp, { recursive: true, force: true });
    });
  });

  it("create inherits defaultWorkdir when workspace is omitted and flag enabled", () => {
    const tmp = makeTempDir("default-workdir-create");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    const defaultDir = join(tmp, "default");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`boards set-default-workdir myproj ${defaultDir}`, env);
    const taskId = runKdi(`create "inherits workspace" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain(`Workspace: ${defaultDir}`);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create --workspace overrides board defaultWorkdir", () => {
    const tmp = makeTempDir("default-workdir-override");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    const defaultDir = join(tmp, "default");
    const explicitDir = join(tmp, "explicit");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(explicitDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`boards set-default-workdir myproj ${defaultDir}`, env);
    const taskId = runKdi(`create "explicit workspace" --board myproj --workspace ${explicitDir}`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain(`Workspace: ${explicitDir}`);
    expect(output).not.toContain(`Workspace: ${defaultDir}`);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("create ignores defaultWorkdir when flag is disabled", () => {
    const tmp = makeTempDir("default-workdir-create-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    const defaultDir = join(tmp, "default");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    setupGitRepo(repoDir);

    const enabledEnv = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "true" };
    runKdi(`boards create myproj --workdir ${repoDir}`, enabledEnv);
    runKdi(`boards set-default-workdir myproj ${defaultDir}`, enabledEnv);

    const disabledEnv = { KDI_DB: dbPath, HOME: tmp, FF_DEFAULT_WORKDIR: "false" };
    const taskId = runKdi(`create "no inherit" --board myproj`, disabledEnv);

    const output = runKdi(`show ${taskId}`, enabledEnv);
    expect(output).not.toContain("Workspace:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "dispatcher creates per-task log file when FF_WORKER_LOG_CAPTURE is enabled",
    async () => {
      const tmp = makeTempDir("log-capture-enabled");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "logagent", command: "echo stdout-line && echo stderr-line >&2" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true", FF_WORKER_LOG_CAPTURE: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "log task" --board myproj --assignee logagent`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);

      const logPath = join(tmp, ".local", "share", "kdi", "logs", "myproj", `${taskId}.log`);
      expect(existsSync(logPath)).toBe(true);
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("stdout-line");
      expect(content).toContain("stderr-line");

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it(
    "dispatcher does not create per-task log file when FF_WORKER_LOG_CAPTURE is disabled",
    async () => {
      const tmp = makeTempDir("log-capture-disabled");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "nologagent", command: "echo done" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true", FF_WORKER_LOG_CAPTURE: "false" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "no log task" --board myproj --assignee nologagent`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);

      const logPath = join(tmp, ".local", "share", "kdi", "logs", "myproj", `${taskId}.log`);
      expect(existsSync(logPath)).toBe(false);

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it(
    "kdi log prints full captured log and --tail prints trailing bytes",
    async () => {
      const tmp = makeTempDir("log-command");
      const dbPath = join(tmp, "kdi.db");
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);
      setupProfiles(tmp, [{ name: "logcmdagent", command: "printf 'start-middle-end'" }]);
      const env = { KDI_DB: dbPath, HOME: tmp, FF_ENABLE_KANBAN_DISPATCH: "true", FF_WORKER_LOG_CAPTURE: "true" };

      runKdi(`boards create myproj --workdir ${repoDir}`, env);
      const taskId = runKdi(`create "log cmd task" --board myproj --assignee logcmdagent`, env);

      const dispatcher = startDispatcher(env);
      runKdi(`promote ${taskId}`, env);

      const ok = await waitForTaskStatus(taskId, "done", env, 10000);
      dispatcher.kill("SIGTERM");

      expect(ok).toBe(true);

      const fullOutput = runKdi(`log ${taskId}`, env);
      expect(fullOutput).toContain("start-middle-end");

      const tailOutput = runKdi(`log ${taskId} --tail 10`, env);
      expect(tailOutput).toBe("middle-end");

      rmSync(tmp, { recursive: true, force: true });
    },
    20000
  );

  it("kdi log prints message when no log exists", () => {
    const tmp = makeTempDir("log-missing");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_WORKER_LOG_CAPTURE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "no log yet" --board myproj`, env);

    const output = runKdi(`log ${taskId}`, env);
    expect(output).toBe("No log found for this task.");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi log --tail rejects non-positive values", () => {
    const tmp = makeTempDir("log-tail-invalid");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_WORKER_LOG_CAPTURE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "tail invalid" --board myproj`, env);

    expect(() => runKdi(`log ${taskId} --tail -1`, env)).toThrow(/positive integer/);
    expect(() => runKdi(`log ${taskId} --tail 0`, env)).toThrow(/positive integer/);
    expect(() => runKdi(`log ${taskId} --tail abc`, env)).toThrow(/positive integer/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi log is rejected when flag is disabled", () => {
    const tmp = makeTempDir("log-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_WORKER_LOG_CAPTURE: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "log disabled" --board myproj`, env);

    expect(() => runKdi(`log ${taskId}`, env)).toThrow(/not enabled/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show displays log path when FF_WORKER_LOG_CAPTURE is enabled", () => {
    const tmp = makeTempDir("show-log-path");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_WORKER_LOG_CAPTURE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "show log" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Log:");
    expect(output).toContain(join(".local", "share", "kdi", "logs", "myproj", `${taskId}.log`));

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show does not display log path when FF_WORKER_LOG_CAPTURE is disabled", () => {
    const tmp = makeTempDir("show-no-log-path");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_WORKER_LOG_CAPTURE: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "no show log" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).not.toContain("Log:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("assign sets assignee and show displays it", () => {
    const tmp = makeTempDir("assign");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "assign me" --board myproj`, env);

    const output = runKdi(`assign ${taskId} opencode`, env);
    expect(output).toContain(`Assigned task ${taskId} to opencode.`);

    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).toContain("Assignee: opencode");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("assign none clears assignee", () => {
    const tmp = makeTempDir("assign-none");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "unassign me" --board myproj --assignee opencode`, env);

    const output = runKdi(`assign ${taskId} none`, env);
    expect(output).toContain(`Unassigned task ${taskId}.`);

    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).not.toContain("Assignee:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("assign rejects empty profile", () => {
    const tmp = makeTempDir("assign-empty");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "empty profile" --board myproj`, env);

    expect(() => runKdi(`assign ${taskId} "  "`, env)).toThrow(/empty/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("reassign with --reclaim releases claim and changes assignee", () => {
    const tmp = makeTempDir("reassign-reclaim");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "reassign me" --board myproj --assignee opencode`, env);
    runKdi(`promote ${taskId}`, env);
    runKdi(`claim ${taskId}`, { ...env, KDI_PROFILE: "opencode" });

    const output = runKdi(`reassign ${taskId} codex --reclaim`, env);
    expect(output).toContain(`Reassigned task ${taskId} to codex.`);

    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).toContain("Assignee: codex");
    expect(showOutput).toContain("Status: ready");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("reassign with --reclaim --reason records reason", () => {
    const tmp = makeTempDir("reassign-reason");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "reason task" --board myproj --assignee opencode`, env);
    runKdi(`promote ${taskId}`, env);
    runKdi(`claim ${taskId}`, { ...env, KDI_PROFILE: "opencode" });

    runKdi(`reassign ${taskId} codex --reclaim --reason "slow worker"`, env);

    const runsOutput = runKdi(`runs ${taskId}`, env);
    expect(runsOutput).toContain("reclaimed");
    expect(runsOutput).toContain("slow worker");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("reassign none --reclaim clears assignee and leaves task ready", () => {
    const tmp = makeTempDir("reassign-none");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "clear me" --board myproj --assignee opencode`, env);
    runKdi(`promote ${taskId}`, env);
    runKdi(`claim ${taskId}`, { ...env, KDI_PROFILE: "opencode" });

    const output = runKdi(`reassign ${taskId} none --reclaim --reason "abort"`, env);
    expect(output).toContain(`Unassigned task ${taskId}.`);

    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).not.toContain("Assignee:");
    expect(showOutput).toContain("Status: ready");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("reclaim --reason records reason when flag enabled", () => {
    const tmp = makeTempDir("reclaim-reason");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "reclaim me" --board myproj --assignee opencode`, env);
    runKdi(`promote ${taskId}`, env);
    runKdi(`claim ${taskId}`, { ...env, KDI_PROFILE: "opencode" });

    runKdi(`reclaim ${taskId} --reason "manual"`, env);

    const runsOutput = runKdi(`runs ${taskId}`, env);
    expect(runsOutput).toContain("reclaimed");
    expect(runsOutput).toContain("manual");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("assign and reassign are gated by feature flag", () => {
    const tmp = makeTempDir("assign-gated");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "gated" --board myproj`, env);

    expect(() => runKdi(`assign ${taskId} opencode`, env)).toThrow(/not enabled/);
    expect(() => runKdi(`reassign ${taskId} codex`, env)).toThrow(/not enabled/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("reclaim --reason is gated by feature flag but base reclaim works", () => {
    const tmp = makeTempDir("reclaim-gated");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_ASSIGN_REASSIGN: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "reclaim base" --board myproj --assignee opencode`, env);
    runKdi(`promote ${taskId}`, env);
    runKdi(`claim ${taskId}`, { ...env, KDI_PROFILE: "opencode" });

    expect(() => runKdi(`reclaim ${taskId} --reason "manual"`, env)).toThrow(/requires the assign\/reassign feature/);

    const output = runKdi(`reclaim ${taskId}`, env);
    expect(output).toContain(`Reclaimed task ${taskId}.`);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("heartbeat is rejected when flag is disabled", () => {
    const tmp = makeTempDir("heartbeat-disabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_HEARTBEAT: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "heartbeat disabled" --board myproj --initial-status running`, env);

    expect(() => runKdi(`heartbeat ${taskId}`, env)).toThrow(/Heartbeat feature is not enabled/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("heartbeat updates timestamps and records note event when flag enabled", () => {
    const tmp = makeTempDir("heartbeat-enabled");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_HEARTBEAT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "heartbeat enabled" --board myproj --initial-status running`, env);

    const output = runKdi(`heartbeat ${taskId} --note "step 1 done"`, env);
    expect(output).toContain(`Heartbeat recorded for task ${taskId}`);

    const showOutput = runKdi(`show ${taskId}`, env);
    expect(showOutput).toContain("Last heartbeat:");

    initDb(dbPath);
    const events = getEvents(parseInt(taskId, 10));
    closeDb();
    const heartbeatEvents = events.filter((e) => e.kind === "heartbeat");
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0].payload).toContain('"note":"step 1 done"');

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show hides last heartbeat when flag is disabled", () => {
    const tmp = makeTempDir("heartbeat-show-hidden");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const enabledEnv = { KDI_DB: dbPath, HOME: tmp, FF_HEARTBEAT: "true" };
    const disabledEnv = { KDI_DB: dbPath, HOME: tmp, FF_HEARTBEAT: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, enabledEnv);
    const taskId = runKdi(`create "heartbeat hidden" --board myproj --initial-status running`, enabledEnv);
    runKdi(`heartbeat ${taskId}`, enabledEnv);

    const disabledOutput = runKdi(`show ${taskId}`, disabledEnv);
    expect(disabledOutput).not.toContain("Last heartbeat:");

    rmSync(tmp, { recursive: true, force: true });
  });

  // ── KDI-030: list filters and sort CLI ──

  it("kdi create --session stores session_id", () => {
    const tmp = makeTempDir("list-session-create");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "session task" --board myproj --session sess-123`, env);
    expect(taskId).toBeTruthy();

    const showOutput = runKdi(`show ${taskId}`, env);
    // Verify it was stored by listing with the session filter
    const listOutput = runKdi(`list --board myproj --session sess-123`, env);
    expect(listOutput).toContain("session task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --session filters by session_id", () => {
    const tmp = makeTempDir("list-session-filter");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "sess-1-task" --board myproj --session sess-1`, env);
    runKdi(`create "sess-2-task" --board myproj --session sess-2`, env);

    const output1 = runKdi(`list --board myproj --session sess-1`, env);
    expect(output1).toContain("sess-1-task");
    expect(output1).not.toContain("sess-2-task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --mine filters by KDI_PROFILE", () => {
    const tmp = makeTempDir("list-mine");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true", KDI_PROFILE: "alice" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "alice-task" --board myproj --assignee alice`, env);
    runKdi(`create "bob-task" --board myproj --assignee bob`, env);

    const output = runKdi(`list --board myproj --mine`, env);
    expect(output).toContain("alice-task");
    expect(output).not.toContain("bob-task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --mine and --assignee are mutually exclusive", () => {
    const tmp = makeTempDir("list-mine-conflict");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`list --board myproj --mine --assignee bob`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --archived includes archived tasks", () => {
    const tmp = makeTempDir("list-archived");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const activeId = runKdi(`create "active-task" --board myproj`, env);
    const archivedId = runKdi(`create "archived-task" --board myproj`, env);
    runKdi(`archive ${archivedId}`, env);

    // Without --archived: only active tasks
    const defaultOutput = runKdi(`list --board myproj`, env);
    expect(defaultOutput).toContain("active-task");
    expect(defaultOutput).not.toContain("archived-task");

    // With --archived: both active and archived
    const archivedOutput = runKdi(`list --board myproj --archived`, env);
    expect(archivedOutput).toContain("active-task");
    expect(archivedOutput).toContain("archived-task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --sort priority orders by priority DESC", () => {
    const tmp = makeTempDir("list-sort-priority");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true", FF_PRIORITY_INTEGER: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "low" --board myproj --priority 1`, env);
    runKdi(`create "high" --board myproj --priority 10`, env);
    runKdi(`create "med" --board myproj --priority 5`, env);

    const output = runKdi(`list --board myproj --sort priority`, env);
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toContain("high");
    expect(lines[1]).toContain("med");
    expect(lines[2]).toContain("low");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --sort title orders case-insensitively", () => {
    const tmp = makeTempDir("list-sort-title");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "zebra" --board myproj`, env);
    runKdi(`create "Apple" --board myproj`, env);

    const output = runKdi(`list --board myproj --sort title`, env);
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toContain("Apple");
    expect(lines[1]).toContain("zebra");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --sort updated orders by updated_at DESC", () => {
    const tmp = makeTempDir("list-sort-updated");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "first" --board myproj`, env);
    runKdi(`create "second" --board myproj`, env);
    // Promote the second task to change its updated_at
    runKdi(`promote 2`, env);

    const output = runKdi(`list --board myproj --sort updated`, env);
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    // The promoted (second) task should appear first since it was updated most recently
    expect(lines[0]).toContain("second");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --sort with invalid key shows error", () => {
    const tmp = makeTempDir("list-sort-invalid");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`list --board myproj --sort invalid`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --status archived --archived returns archived tasks", () => {
    const tmp = makeTempDir("list-status-archived");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "active-task" --board myproj`, env);
    runKdi(`create "archived-task" --board myproj`, env);
    // Soft-archive the second task
    runKdi(`archive 2`, env);

    const output = runKdi(`list --board myproj --status archived --archived`, env);
    expect(output).toContain("archived-task");
    expect(output).not.toContain("active-task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list new options are gated by flag", () => {
    const tmp = makeTempDir("list-gated");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    // Each new option should be rejected when flag is disabled
    expect(() => runKdi(`list --board myproj --mine`, env)).toThrow();
    expect(() => runKdi(`list --board myproj --session sess-1`, env)).toThrow();
    expect(() => runKdi(`list --board myproj --archived`, env)).toThrow();
    expect(() => runKdi(`list --board myproj --sort priority`, env)).toThrow();
    expect(() => runKdi(`list --board myproj --workflow-template-id wf1`, env)).toThrow();
    expect(() => runKdi(`list --board myproj --step-key step1`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi create --session is gated by flag", () => {
    const tmp = makeTempDir("create-session-gated");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    expect(() => runKdi(`create "task" --board myproj --session sess-1`, env)).toThrow();

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --workflow-template-id filters by template", () => {
    const tmp = makeTempDir("list-wf");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    // Use SQL to set workflow_template_id (CLI doesn't have --workflow-template-id on create)
    const db = initDb(dbPath);
    const taskId = runKdi(`create "wf-task" --board myproj`, env);
    const boardId = runKdi(`boards show myproj`, env);
    // Set directly in DB since create doesn't expose --workflow-template-id
    runKdi(`create "other-task" --board myproj`, env);
    db.run(`UPDATE tasks SET workflow_template_id = 'onboard' WHERE id = ?`, [parseInt(taskId)]);

    const output = runKdi(`list --board myproj --workflow-template-id onboard`, env);
    expect(output).toContain("wf-task");
    expect(output).not.toContain("other-task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list --step-key filters by step key", () => {
    const tmp = makeTempDir("list-step");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "step-task" --board myproj`, env);
    runKdi(`create "other-task" --board myproj`, env);
    const db = initDb(dbPath);
    db.run(`UPDATE tasks SET current_step_key = 'review' WHERE title = 'step-task'`);

    const output = runKdi(`list --board myproj --step-key review`, env);
    expect(output).toContain("step-task");
    expect(output).not.toContain("other-task");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("kdi list filters compose with existing --status and --assignee", () => {
    const tmp = makeTempDir("list-compose");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_LIST_FILTERS_SORT: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    runKdi(`create "alice-ready" --board myproj --assignee alice --initial-status ready`, env);
    runKdi(`create "alice-todo" --board myproj --assignee alice`, env);
    runKdi(`create "bob-ready" --board myproj --assignee bob --initial-status ready`, env);

    const output = runKdi(`list --board myproj --status ready --assignee alice`, env);
    expect(output).toContain("alice-ready");
    expect(output).not.toContain("alice-todo");
    expect(output).not.toContain("bob-ready");

    rmSync(tmp, { recursive: true, force: true });
  });

  // ── KDI-031: show run filtering CLI ──

  it("show displays Runs section when FF_SHOW_RUN_FILTERING is enabled", async () => {
    const tmp = makeTempDir("show-runs");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "show runs" --board myproj`, env);

    initDb(dbPath);
    const { createRun } = await import("../src/models/taskRun");
    createRun({ task_id: parseInt(taskId, 10), status: "running", profile: "opencode", started_at: 1000 });
    closeDb();

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("Runs:");
    expect(output).toContain("status=running");
    expect(output).toContain("profile=opencode");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show filters runs by --state-type status and --state-name", async () => {
    const tmp = makeTempDir("show-filter-status");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "filter status" --board myproj`, env);

    initDb(dbPath);
    const { createRun, finishRun } = await import("../src/models/taskRun");
    const run1 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 1000 });
    finishRun(run1.id, "completed");
    const run2 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 2000 });
    finishRun(run2.id, "crashed", null, null, "boom");
    closeDb();

    const output = runKdi(`show ${taskId} --state-type status --state-name crashed`, env);
    expect(output).toContain("Runs:");
    expect(output).toContain("status=crashed");
    expect(output).not.toContain("status=done");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show filters runs by --state-type outcome and --state-name", async () => {
    const tmp = makeTempDir("show-filter-outcome");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "filter outcome" --board myproj`, env);

    initDb(dbPath);
    const { createRun, finishRun } = await import("../src/models/taskRun");
    const run1 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 1000 });
    finishRun(run1.id, "completed");
    const run2 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 2000 });
    finishRun(run2.id, "crashed", null, null, "boom");
    closeDb();

    const output = runKdi(`show ${taskId} --state-type outcome --state-name completed`, env);
    expect(output).toContain("Runs:");
    expect(output).toContain("outcome=completed");
    expect(output).not.toContain("outcome=crashed");

    rmSync(tmp, { recursive: true, force: true });
  });

  it('show prints "No runs match the filter." when filter matches nothing', async () => {
    const tmp = makeTempDir("show-no-match");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "no match" --board myproj`, env);

    initDb(dbPath);
    const { createRun } = await import("../src/models/taskRun");
    createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 1000 });
    closeDb();

    const output = runKdi(`show ${taskId} --state-type status --state-name done`, env);
    expect(output).toContain("No runs match the filter.");

    rmSync(tmp, { recursive: true, force: true });
  });

  it('show prints "No runs found for this task." when task has no runs', () => {
    const tmp = makeTempDir("show-no-runs");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "no runs" --board myproj`, env);

    const output = runKdi(`show ${taskId}`, env);
    expect(output).toContain("No runs found for this task.");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show rejects --state-type without --state-name", () => {
    const tmp = makeTempDir("show-no-name");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "incomplete filter" --board myproj`, env);

    expect(() => runKdi(`show ${taskId} --state-type status`, env)).toThrow(
      /--state-type and --state-name must both be provided/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show rejects --state-name without --state-type", () => {
    const tmp = makeTempDir("show-no-type");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "incomplete filter 2" --board myproj`, env);

    expect(() => runKdi(`show ${taskId} --state-name crashed`, env)).toThrow(
      /--state-type and --state-name must both be provided/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show rejects invalid --state-type", () => {
    const tmp = makeTempDir("show-invalid-type");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "invalid type" --board myproj`, env);

    expect(() => runKdi(`show ${taskId} --state-type foo --state-name bar`, env)).toThrow(
      /Invalid state type/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show rejects filter options when FF_SHOW_RUN_FILTERING is disabled", () => {
    const tmp = makeTempDir("show-flag-off");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "flag off" --board myproj`, env);

    expect(() => runKdi(`show ${taskId} --state-type status --state-name crashed`, env)).toThrow(
      /Run filtering feature is not enabled/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("show does not display Runs section when FF_SHOW_RUN_FILTERING is disabled", async () => {
    const tmp = makeTempDir("show-no-runs-section");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SHOW_RUN_FILTERING: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "no runs section" --board myproj`, env);

    initDb(dbPath);
    const { createRun } = await import("../src/models/taskRun");
    createRun({ task_id: parseInt(taskId, 10), status: "running", profile: "opencode", started_at: 1000 });
    closeDb();

    const output = runKdi(`show ${taskId}`, env);
    expect(output).not.toContain("Runs:");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs unfiltered output is unchanged when FF_RUNS_FILTERING is disabled", async () => {
    const tmp = makeTempDir("runs-flag-off-baseline");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs baseline" --board myproj`, env);

    initDb(dbPath);
    const { createRun, finishRun } = await import("../src/models/taskRun");
    const run1 = createRun({ task_id: parseInt(taskId, 10), status: "running", profile: "opencode", started_at: 1000 });
    finishRun(run1.id, "completed");
    const run2 = createRun({ task_id: parseInt(taskId, 10), status: "running", profile: "opencode", started_at: 2000 });
    finishRun(run2.id, "crashed", null, null, "boom");
    closeDb();

    const output = runKdi(`runs ${taskId}`, env);
    expect(output).toContain(`Run #${run1.id}:`);
    expect(output).toContain(`Run #${run2.id}:`);
    expect(output).toContain("status=done");
    expect(output).toContain("status=crashed");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs rejects filter options when FF_RUNS_FILTERING is disabled", () => {
    const tmp = makeTempDir("runs-flag-off");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs flag off" --board myproj`, env);

    expect(() => runKdi(`runs ${taskId} --state-type status --state-name crashed`, env)).toThrow(
      /Run filtering feature is not enabled/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs filters by --state-type status and --state-name when flag enabled", async () => {
    const tmp = makeTempDir("runs-filter-status");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs filter status" --board myproj`, env);

    initDb(dbPath);
    const { createRun, finishRun } = await import("../src/models/taskRun");
    const run1 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 1000 });
    finishRun(run1.id, "completed");
    const run2 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 2000 });
    finishRun(run2.id, "crashed", null, null, "boom");
    closeDb();

    const output = runKdi(`runs ${taskId} --state-type status --state-name crashed`, env);
    expect(output).toContain(`Run #${run2.id}:`);
    expect(output).toContain("status=crashed");
    expect(output).not.toContain(`Run #${run1.id}:`);
    expect(output).not.toContain("status=done");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs filters by --state-type outcome and --state-name when flag enabled", async () => {
    const tmp = makeTempDir("runs-filter-outcome");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs filter outcome" --board myproj`, env);

    initDb(dbPath);
    const { createRun, finishRun } = await import("../src/models/taskRun");
    const run1 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 1000 });
    finishRun(run1.id, "completed");
    const run2 = createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 2000 });
    finishRun(run2.id, "crashed", null, null, "boom");
    closeDb();

    const output = runKdi(`runs ${taskId} --state-type outcome --state-name completed`, env);
    expect(output).toContain(`Run #${run1.id}:`);
    expect(output).toContain("outcome=completed");
    expect(output).not.toContain(`Run #${run2.id}:`);
    expect(output).not.toContain("outcome=crashed");

    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs prints "No runs match the filter." when filter matches nothing', async () => {
    const tmp = makeTempDir("runs-no-match");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs no match" --board myproj`, env);

    initDb(dbPath);
    const { createRun } = await import("../src/models/taskRun");
    createRun({ task_id: parseInt(taskId, 10), status: "running", started_at: 1000 });
    closeDb();

    const output = runKdi(`runs ${taskId} --state-type status --state-name crashed`, env);
    expect(output).toContain("No runs match the filter.");

    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs prints "No runs found for this task." when task has no runs', () => {
    const tmp = makeTempDir("runs-no-runs");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs no runs" --board myproj`, env);

    const output = runKdi(`runs ${taskId}`, env);
    expect(output).toContain("No runs found for this task.");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs rejects --state-type without --state-name", () => {
    const tmp = makeTempDir("runs-no-name");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs incomplete" --board myproj`, env);

    expect(() => runKdi(`runs ${taskId} --state-type status`, env)).toThrow(
      /--state-type and --state-name must both be provided/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs rejects --state-name without --state-type", () => {
    const tmp = makeTempDir("runs-no-type");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs incomplete 2" --board myproj`, env);

    expect(() => runKdi(`runs ${taskId} --state-name crashed`, env)).toThrow(
      /--state-type and --state-name must both be provided/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs rejects invalid --state-type", () => {
    const tmp = makeTempDir("runs-invalid-type");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs invalid type" --board myproj`, env);

    expect(() => runKdi(`runs ${taskId} --state-type foo --state-name bar`, env)).toThrow(
      /Invalid state type/
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs unfiltered output is unchanged when flag enabled and no filter supplied", async () => {
    const tmp = makeTempDir("runs-enabled-baseline");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_RUNS_FILTERING: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const taskId = runKdi(`create "runs enabled baseline" --board myproj`, env);

    initDb(dbPath);
    const { createRun, finishRun } = await import("../src/models/taskRun");
    const run1 = createRun({ task_id: parseInt(taskId, 10), status: "running", profile: "opencode", started_at: 1000 });
    finishRun(run1.id, "completed");
    const run2 = createRun({ task_id: parseInt(taskId, 10), status: "running", profile: "opencode", started_at: 2000 });
    finishRun(run2.id, "crashed", null, null, "boom");
    closeDb();

    const output = runKdi(`runs ${taskId}`, env);
    expect(output).toContain(`Run #${run1.id}:`);
    expect(output).toContain(`Run #${run2.id}:`);
    expect(output).toContain("status=done");
    expect(output).toContain("status=crashed");
    expect(output).toContain("outcome=completed");
    expect(output).toContain("outcome=crashed");

    rmSync(tmp, { recursive: true, force: true });
  });



  it("swarm is rejected when flag disabled", () => {
    const tmp = makeTempDir("swarm-flag-off");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "false" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    expect(() =>
      runKdi(
        `swarm --worker backend:auth --verifier qa --synthesizer pm --board myproj`,
        env
      )
    ).toThrow(/Swarm mode is not enabled/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm dry-run prints plan without creating tasks", () => {
    const tmp = makeTempDir("swarm-dry-run");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const output = runKdi(
      `swarm --worker backend:auth --worker frontend:login --verifier qa --synthesizer pm --board myproj --dry-run`,
      env
    );

    expect(output).toContain("Orchestrator:");
    expect(output).toContain("Worker: auth");
    expect(output).toContain("Worker: login");
    expect(output).toContain("Verifier:");
    expect(output).toContain("Synthesizer:");
    expect(output).toContain("auth -> verify:");
    expect(output).toContain("login -> verify:");
    expect(output).toContain("-> synthesize:");

    const listOutput = runKdi("list --board myproj", env);
    expect(listOutput).not.toContain("auth");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm creates orchestrator, workers, verifier, and synthesizer", () => {
    const tmp = makeTempDir("swarm-create");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);
    const output = runKdi(
      `swarm --worker backend:auth --worker frontend:login --verifier qa --synthesizer pm --board myproj --body "build auth" --priority 3 --session sess-1`,
      env
    );

    const orchestratorId = output.match(/orchestrator #(\d+)/)?.[1];
    expect(orchestratorId).toBeDefined();

    const orchestratorShow = runKdi(`show ${orchestratorId}`, env);
    expect(orchestratorShow).toContain("Status: triage");
    expect(orchestratorShow).toContain("build auth");

    const listOutput = runKdi("list --board myproj --status ready", env);
    expect(listOutput).toContain("auth");
    expect(listOutput).toContain("login");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm rejects missing worker", () => {
    const tmp = makeTempDir("swarm-no-worker");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    expect(() =>
      runKdi(`swarm --verifier qa --synthesizer pm --board myproj`, env)
    ).toThrow(/At least one --worker is required/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm rejects missing verifier", () => {
    const tmp = makeTempDir("swarm-no-verifier");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    expect(() =>
      runKdi(`swarm --worker backend:auth --synthesizer pm --board myproj`, env)
    ).toThrow(/--verifier is required/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm rejects missing synthesizer", () => {
    const tmp = makeTempDir("swarm-no-synthesizer");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    expect(() =>
      runKdi(`swarm --worker backend:auth --verifier qa --board myproj`, env)
    ).toThrow(/--synthesizer is required/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm rejects duplicate worker titles", () => {
    const tmp = makeTempDir("swarm-dup-title");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    expect(() =>
      runKdi(
        `swarm --worker backend:auth --worker frontend:auth --verifier qa --synthesizer pm --board myproj`,
        env
      )
    ).toThrow(/Duplicate worker title/);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("swarm rejects worker missing title suffix", () => {
    const tmp = makeTempDir("swarm-bad-worker");
    const dbPath = join(tmp, "kdi.db");
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    setupGitRepo(repoDir);
    const env = { KDI_DB: dbPath, HOME: tmp, FF_SWARM_MODE: "true" };

    runKdi(`boards create myproj --workdir ${repoDir}`, env);

    expect(() =>
      runKdi(
        `swarm --worker backend --verifier qa --synthesizer pm --board myproj`,
        env
      )
    ).toThrow(/Invalid worker/);

    rmSync(tmp, { recursive: true, force: true });
  });
});