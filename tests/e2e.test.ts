import { describe, it, expect } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "../src/db";
import { addDependency } from "../src/models/dependency";

const PROJECT_ROOT = "/Users/shakilakram/projects/kdi";

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
});
