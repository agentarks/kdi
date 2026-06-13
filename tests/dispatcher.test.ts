import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask, showTask } from "../src/models/task";
import { addDependency } from "../src/models/dependency";
import { setFlag, clearOverrides } from "../src/flags";
import { atomicClaim, heartbeat } from "../src/models/claim";
import { tick, startDispatcher } from "../src/dispatcher";
import { cleanupDb } from "./cleanupDb";

let testDbPath: string;

function setupTempHome(profiles: { name: string; command: string }[]): string {
  const home = mkdtempSync(join(tmpdir(), "kdi-dispatcher-home-"));
  const configDir = join(home, ".config", "kdi");
  mkdirSync(configDir, { recursive: true });
  const lines = profiles.map((p) => {
    const escaped = p.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `- name: ${p.name}\n  command: "${escaped}"`;
  });
  writeFileSync(join(configDir, "profiles.yaml"), lines.join("\n") + "\n");
  return home;
}

describe("dispatcher", () => {
  beforeEach(() => {
    testDbPath = join(tmpdir(), `kdi-dispatcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(testDbPath);
    initDb(testDbPath);
    setFlag("FF_ENABLE_KANBAN_DISPATCH", true);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(testDbPath);
  });

  it("returns early when flag is disabled", async () => {
    setFlag("FF_ENABLE_KANBAN_DISPATCH", false);
    const result = await tick();
    expect(result.processed).toBe(0);
  });

  it("processes ready task with successful harness", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Test task", assignee: "opencode" });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "success", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    const result = await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(1);
    expect(mockHarness).toHaveBeenCalled();
    expect(mockCreateWorktree).toHaveBeenCalledWith("/tmp/test-board", "opencode", String(task.id), "origin/main");
    expect(mockRemoveWorktree).toHaveBeenCalledWith("/tmp/test-board", "opencode", String(task.id), "/tmp/mock-worktree");

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.result).toBe("success");
  });

  it("uses task workspace as worktree source when set", async () => {
    const board = createBoard("test-board", "/tmp/board-workdir");
    const task = createTask({
      board_id: board.id,
      title: "Workspace task",
      assignee: "opencode",
      workspace: "/tmp/task-workspace",
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "success", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(mockCreateWorktree).toHaveBeenCalledWith("/tmp/task-workspace", "opencode", String(task.id), "origin/main");
    expect(mockRemoveWorktree).toHaveBeenCalledWith("/tmp/task-workspace", "opencode", String(task.id), "/tmp/mock-worktree");
  });

  it("skips blocked tasks due to dependencies", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child", assignee: "opencode" });
    promoteTask(child.id);
    addDependency(parent.id, child.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }));

    const result = await tick({ spawnHarness: mockHarness });

    expect(result.processed).toBe(0);
    const updated = showTask(child.id);
    expect(updated!.status).toBe("ready");
  });

  it("blocks task on harness failure", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Failing task", assignee: "opencode" });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "", stderr: "error output", exitCode: 1 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    const result = await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(0);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("Harness failed");
  });

  it("marks task blocked when worktree creation fails", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Task", assignee: "opencode" });
    promoteTask(task.id);

    const mockCreateWorktree = mock(() => { throw new Error("git failed"); });
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    const result = await tick({
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(0);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("git failed");
  });

  it("handles multiple ready tasks", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task1 = createTask({ board_id: board.id, title: "Task 1", assignee: "opencode" });
    const task2 = createTask({ board_id: board.id, title: "Task 2", assignee: "opencode" });
    promoteTask(task1.id);
    promoteTask(task2.id);

    let callCount = 0;
    const mockHarness = mock(() => {
      callCount++;
      return Promise.resolve({ stdout: `result-${callCount}`, stderr: "", exitCode: 0 });
    });
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    const result = await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(2);
    expect(mockHarness).toHaveBeenCalledTimes(2);
  });

  it("startDispatcher runs background loop and can be stopped", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Bg task", assignee: "opencode" });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    const dispatcher = startDispatcher(50, {
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    // Wait for at least one tick
    await new Promise(resolve => setTimeout(resolve, 150));

    await dispatcher.stop();

    expect(mockHarness).toHaveBeenCalled();
  });

  it("blocks task when board is not found", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Orphan task", assignee: "opencode" });
    promoteTask(task.id);

    // Archive the board so getBoardWorkdir returns null
    const db = (await import("../src/db")).getDb();
    db.run("UPDATE boards SET archived_at = unixepoch() WHERE id = ?", [board.id]);

    const result = await tick();

    expect(result.processed).toBe(0);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("Board not found");
  });

  it("blocks task when profile is unknown", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Unknown profile task", assignee: "nonexistent-profile-123" });
    promoteTask(task.id);

    const result = await tick();

    expect(result.processed).toBe(0);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("Unknown profile");
  });

  it("blocks task when spawnHarness throws", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Throwing harness task", assignee: "opencode" });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.reject(new Error("spawn failed")));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    const result = await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(0);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("spawn failed");
  });

  it("handles concurrent claim race", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Race task", assignee: "opencode" });
    promoteTask(task.id);

    const slowHarness = mock(() => new Promise((resolve) => {
      setTimeout(() => resolve({ stdout: "ok", stderr: "", exitCode: 0 }), 200);
    }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    // Start first tick (will claim the task and hold it)
    const firstTick = tick({
      spawnHarness: slowHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    // Small delay to ensure first tick claims the task
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second tick should see task as running and skip it
    const secondTick = tick({
      spawnHarness: slowHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const [result1, result2] = await Promise.all([firstTick, secondTick]);

    expect(result1.processed).toBe(1);
    expect(result2.processed).toBe(0);
  });

  it("passes board base_ref to createWorktree", async () => {
    const board = createBoard("test-board", "/tmp/test-board", "origin/develop");
    const task = createTask({ board_id: board.id, title: "Test task", assignee: "opencode" });
    promoteTask(task.id);

    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(mockCreateWorktree).toHaveBeenCalledWith("/tmp/test-board", "opencode", String(task.id), "origin/develop");
  });

  it("substitutes worktree branch into {{branch}} template", async () => {
    const home = setupTempHome([
      { name: "branchagent", command: "echo {{branch}}" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Branch test", assignee: "branchagent" });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    if (originalPath !== undefined) {
      process.env.KDI_PROFILES_PATH = originalPath;
    } else {
      delete process.env.KDI_PROFILES_PATH;
    }
    rmSync(home, { recursive: true, force: true });

    const calls = mockHarness.mock.calls as unknown as [string, string][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain(`wt/branchagent/${task.id}`);
  });

  it("passes skills to harness via {{skills}} template and KDI_SKILLS env", async () => {
    const home = setupTempHome([
      { name: "skillagent", command: "echo {{skills}}" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "Skills test",
      assignee: "skillagent",
      skills: ["github", "code-review"],
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    if (originalPath !== undefined) {
      process.env.KDI_PROFILES_PATH = originalPath;
    } else {
      delete process.env.KDI_PROFILES_PATH;
    }
    rmSync(home, { recursive: true, force: true });

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("github,code-review");
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_SKILLS).toBe("github,code-review");
  });

  it("passes model_override to harness via {{model}} template and KDI_MODEL env", async () => {
    const home = setupTempHome([
      { name: "modelagent", command: "echo {{model}}" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "Model test",
      assignee: "modelagent",
      model_override: "gpt-5.5",
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    if (originalPath !== undefined) {
      process.env.KDI_PROFILES_PATH = originalPath;
    } else {
      delete process.env.KDI_PROFILES_PATH;
    }
    rmSync(home, { recursive: true, force: true });

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("gpt-5.5");
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_MODEL).toBe("gpt-5.5");
  });

  it("does not set KDI_MODEL env when model_override is absent", async () => {
    const home = setupTempHome([
      { name: "nomodelagent", command: "echo done" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "No model test",
      assignee: "nomodelagent",
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    if (originalPath !== undefined) {
      process.env.KDI_PROFILES_PATH = originalPath;
    } else {
      delete process.env.KDI_PROFILES_PATH;
    }
    rmSync(home, { recursive: true, force: true });

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][4]).toBeUndefined();
  });

  it("processes ready tasks in priority descending order", async () => {
    const board = createBoard("prio-board", "/tmp/prio-board");
    const low = createTask({ board_id: board.id, title: "Low", assignee: "opencode", priority: 1 });
    const high = createTask({ board_id: board.id, title: "High", assignee: "opencode", priority: 5 });
    const med = createTask({ board_id: board.id, title: "Med", assignee: "opencode", priority: 3 });
    promoteTask(low.id);
    promoteTask(high.id);
    promoteTask(med.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const calls = mockCreateWorktree.mock.calls as unknown as [string, string, string, string][];
    expect(calls.length).toBe(3);

    // createWorktree is called with (repoDir, profile, taskId, baseRef)
    expect(Number(calls[0][2])).toBe(high.id);
    expect(Number(calls[1][2])).toBe(med.id);
    expect(Number(calls[2][2])).toBe(low.id);
  });

  it("promotes scheduled task to ready and claims it in same tick", async () => {
    const board = createBoard("sched-board", "/tmp/sched-board");
    const task = createTask({ board_id: board.id, title: "Auto promote", assignee: "opencode" });
    const at = Math.floor(Date.now() / 1000) - 1;

    // Directly set scheduled in the past (bypass scheduleTask future-check)
    getDb().run(
      `UPDATE tasks SET status = 'scheduled', scheduled_at = ? WHERE id = ?`,
      [at, task.id]
    );

    let claimed = false;
    const result = await tick({
      spawnHarness: async () => {
        claimed = true;
        return { stdout: "done", stderr: "", exitCode: 0, pid: 1234 };
      },
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(result.processed).toBe(1);
    expect(claimed).toBe(true);
    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
  });

  it("times out harness exceeding task max_runtime_seconds", async () => {
    const board = createBoard("timeout-board", "/tmp/timeout-board");
    const task = createTask({
      board_id: board.id,
      title: "Slow task",
      assignee: "opencode",
      max_runtime_seconds: 1,
    });
    promoteTask(task.id);

    const result = await tick({
      spawnHarness: async (command, cwd, logPath, timeoutMs) => {
        // Simulate the real spawnHarness timeout behavior
        await new Promise((resolve) => setTimeout(resolve, timeoutMs! + 50));
        throw new Error(`Harness timed out after ${timeoutMs}ms`);
      },
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(result.processed).toBe(0);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("timed out");

    const { getRuns } = await import("../src/models/taskRun");
    const runs = getRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("timed_out");
    expect(runs[0].outcome).toBe("timed_out");
  });

  it("passes max_runtime_seconds as harness timeout", async () => {
    const board = createBoard("timeout-board", "/tmp/timeout-board");
    const task = createTask({
      board_id: board.id,
      title: "Fast task",
      assignee: "opencode",
      max_runtime_seconds: 42,
    });
    promoteTask(task.id);

    let receivedTimeoutMs: number | undefined;
    await tick({
      spawnHarness: async (command, cwd, logPath, timeoutMs) => {
        receivedTimeoutMs = timeoutMs;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(receivedTimeoutMs).toBe(42000);
  });

  it("successful harness run resets consecutive_failures to 0", async () => {
    const board = createBoard("reset-board", "/tmp/reset-board");
    const task = createTask({
      board_id: board.id,
      title: "Reset me",
      assignee: "opencode",
      max_retries: 3,
    });
    promoteTask(task.id);

    const db = getDb();
    db.run("UPDATE tasks SET consecutive_failures = 2 WHERE id = ?", [task.id]);

    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.consecutive_failures).toBe(0);
  });

  it("EX_TEMPFAIL does not increment consecutive_failures", async () => {
    const board = createBoard("tempfail-board", "/tmp/tempfail-board");
    const task = createTask({
      board_id: board.id,
      title: "Tempfail me",
      assignee: "opencode",
      max_retries: 3,
    });
    promoteTask(task.id);

    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "", stderr: "rate limited", exitCode: 75 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.consecutive_failures).toBe(0);
  });

  it("requeues task with max_retries on first failures and blocks on final failure", async () => {
    const board = createBoard("retry-board", "/tmp/retry-board");
    const task = createTask({
      board_id: board.id,
      title: "Retry me",
      assignee: "opencode",
      max_retries: 3,
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    // First failure: requeue
    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });
    let updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.consecutive_failures).toBe(1);

    // Second failure: requeue
    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });
    updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.consecutive_failures).toBe(2);

    // Third failure: blocked by circuit breaker
    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });
    updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.consecutive_failures).toBe(3);
    expect(updated!.block_reason).toContain("Circuit breaker");
  });

  it("blocks task without max_retries on first failure", async () => {
    const board = createBoard("no-retry-board", "/tmp/no-retry-board");
    const task = createTask({
      board_id: board.id,
      title: "No retry cap",
      assignee: "opencode",
    });
    promoteTask(task.id);

    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.consecutive_failures).toBe(1);
  });

  it("successful run after retry resets consecutive_failures", async () => {
    const board = createBoard("recover-board", "/tmp/recover-board");
    const task = createTask({
      board_id: board.id,
      title: "Recover me",
      assignee: "opencode",
      max_retries: 3,
    });
    promoteTask(task.id);

    let calls = 0;
    const mockHarness = mock(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1 });
      }
      return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    });

    await tick({
      spawnHarness: mockHarness,
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });
    expect(showTask(task.id)!.status).toBe("ready");
    expect(showTask(task.id)!.consecutive_failures).toBe(1);

    await tick({
      spawnHarness: mockHarness,
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });
    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.consecutive_failures).toBe(0);
  });

  it("seeds initial heartbeat on claim when FF_HEARTBEAT is enabled", async () => {
    setFlag("FF_HEARTBEAT", true);
    const board = createBoard("hb-board", "/tmp/hb-board");
    const task = createTask({ board_id: board.id, title: "Heartbeat seed", assignee: "opencode" });
    promoteTask(task.id);

    const before = Math.floor(Date.now() / 1000);
    await tick({
      spawnHarness: () => new Promise((resolve) => setTimeout(() => resolve({ stdout: "ok", stderr: "", exitCode: 0 }), 50)),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });
    const after = Math.floor(Date.now() / 1000);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.last_heartbeat_at).toBeGreaterThanOrEqual(before);
    expect(updated!.last_heartbeat_at).toBeLessThanOrEqual(after);
  });

  it("does not seed initial heartbeat when FF_HEARTBEAT is disabled", async () => {
    setFlag("FF_HEARTBEAT", false);
    const board = createBoard("hb-off-board", "/tmp/hb-off-board");
    const task = createTask({ board_id: board.id, title: "No heartbeat seed", assignee: "opencode" });
    promoteTask(task.id);

    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.last_heartbeat_at).toBeNull();
  });

  it("reclaims task with stale heartbeat when FF_HEARTBEAT is enabled", async () => {
    setFlag("FF_HEARTBEAT", true);
    const board = createBoard("stale-hb-board", "/tmp/stale-hb-board");
    const task = createTask({ board_id: board.id, title: "Stale heartbeat", assignee: "opencode" });
    promoteTask(task.id);

    // Claim and seed heartbeat, then roll timestamps back beyond the 60-minute threshold
    atomicClaim(task.id, "opencode");
    heartbeat(task.id);

    const staleTime = Math.floor(Date.now() / 1000) - 3601;
    getDb().run(
      `UPDATE tasks SET last_heartbeat_at = ?, claim_expires = ? WHERE id = ?`,
      [staleTime, staleTime + 900, task.id]
    );
    const run = getDb().query("SELECT id FROM task_runs WHERE task_id = ?").get(task.id) as { id: number };
    getDb().run(`UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?`, [staleTime, run.id]);

    // Use maxSpawnsPerTick=0 so tick only reaps/promotes without re-claiming the reclaimed task
    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      maxSpawnsPerTick: 0,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.claim_lock).toBeNull();
    expect(updated!.claim_expires).toBeNull();
    expect(updated!.current_run_id).toBeNull();

    const { getRuns } = await import("../src/models/taskRun");
    const runs = getRuns(task.id);
    expect(runs[0].outcome).toBe("reclaimed");
    expect(runs[0].status).toBe("released");
    expect(runs[0].error).toBe("stale heartbeat detected by dispatcher");
  });

  it("ignores heartbeat age when FF_HEARTBEAT is disabled", async () => {
    setFlag("FF_HEARTBEAT", false);
    const board = createBoard("no-stale-hb-board", "/tmp/no-stale-hb-board");
    const task = createTask({ board_id: board.id, title: "No stale heartbeat", assignee: "opencode" });
    promoteTask(task.id);

    // Claim with a far-past heartbeat but a claim_expires still in the future
    atomicClaim(task.id, "opencode");
    const now = Math.floor(Date.now() / 1000);
    const staleTime = now - 7200;
    const futureExpiry = now + 900;
    getDb().run(
      `UPDATE tasks SET last_heartbeat_at = ?, claim_expires = ? WHERE id = ?`,
      [staleTime, futureExpiry, task.id]
    );

    // Use maxSpawnsPerTick=0 so tick only reaps/promotes without claiming the task
    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      maxSpawnsPerTick: 0,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("running");
  });

  it("reaps task with null heartbeat when claim_expires passed", async () => {
    setFlag("FF_HEARTBEAT", true);
    const board = createBoard("null-hb-board", "/tmp/null-hb-board");
    const task = createTask({ board_id: board.id, title: "Null heartbeat", assignee: "opencode" });
    promoteTask(task.id);

    atomicClaim(task.id, "opencode");
    const now = Math.floor(Date.now() / 1000);
    const pastExpiry = now - 1;
    getDb().run(
      `UPDATE tasks SET last_heartbeat_at = NULL, claim_expires = ? WHERE id = ?`,
      [pastExpiry, task.id]
    );

    // Use maxSpawnsPerTick=0 so tick only reaps/promotes without re-claiming the reclaimed task
    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      maxSpawnsPerTick: 0,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
  });
});
