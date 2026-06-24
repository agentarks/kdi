import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask, showTask } from "../src/models/task";
import { addDependency } from "../src/models/dependency";
import { setFlag, clearOverrides, FF_RATE_LIMIT_EXIT_CODE, FF_NOTIFY_SUBS, FF_DISPATCH_CONTROLS, FF_GOAL_MODE, FF_HARNESS_CONTEXT, FF_ENABLE_KANBAN_DISPATCH, FF_RESULT_SUMMARY } from "../src/flags";
import { extractHarnessResult } from "../src/harnessResult";
import { subscribe } from "../src/models/notifySub";
import { atomicClaim, heartbeat } from "../src/models/claim";
import { tick, startDispatcher } from "../src/dispatcher";
import { parseFailureLimit } from "../src/commands/dispatch";
import { getEvents } from "../src/models/taskEvent";
import { getRuns, updateRun } from "../src/models/taskRun";
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("gpt-5.5");
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_MODEL).toBe("gpt-5.5");
  });

  it("does not set KDI_MODEL env when model_override is absent", async () => {
    setFlag(FF_HARNESS_CONTEXT, true);
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_MODEL).toBeUndefined();
    expect(calls[0][4]!.KDI_TASK_TITLE).toBe("No model test");
  });

  it("passes current_step_key to harness via {{step_key}} template and KDI_CURRENT_STEP_KEY env", async () => {
    const home = setupTempHome([
      { name: "stepagent", command: "echo {{step_key}}" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "Step key test",
      assignee: "stepagent",
      current_step_key: "review",
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("review");
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_CURRENT_STEP_KEY).toBe("review");
  });

  it("does not set KDI_CURRENT_STEP_KEY env when current_step_key is absent", async () => {
    setFlag(FF_HARNESS_CONTEXT, true);
    const home = setupTempHome([
      { name: "nostepagent", command: "echo done" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "No step key test",
      assignee: "nostepagent",
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_CURRENT_STEP_KEY).toBeUndefined();
    expect(calls[0][4]!.KDI_TASK_TITLE).toBe("No step key test");
  });

  it("passes task title and body to harness via {{title}} and {{body}} templates when FF_HARNESS_CONTEXT is enabled", async () => {
    setFlag(FF_HARNESS_CONTEXT, true);
    const home = setupTempHome([
      { name: "contextagent", command: "echo '{{title}}' '{{body}}'" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "Task title",
      body: "Task body\nline two",
      assignee: "contextagent",
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("'Task title'");
    expect(calls[0][0]).toContain("'Task body\nline two'");
  });

  it("passes KDI_TASK_TITLE, KDI_TASK_BODY, KDI_TASK_ID, and KDI_BOARD env vars to harness when FF_HARNESS_CONTEXT is enabled", async () => {
    setFlag(FF_HARNESS_CONTEXT, true);
    const home = setupTempHome([
      { name: "envagent", command: "echo done" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("env-board", "/tmp/env-board");
    const task = createTask({
      board_id: board.id,
      title: "Env title",
      body: "Env body",
      assignee: "envagent",
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_TASK_TITLE).toBe("Env title");
    expect(calls[0][4]!.KDI_TASK_BODY).toBe("Env body");
    expect(calls[0][4]!.KDI_TASK_ID).toBe(String(task.id));
    expect(calls[0][4]!.KDI_BOARD).toBe("env-board");
  });

  it("passes empty KDI_TASK_BODY when task body is null and FF_HARNESS_CONTEXT is enabled", async () => {
    setFlag(FF_HARNESS_CONTEXT, true);
    const home = setupTempHome([
      { name: "nobodyagent", command: "echo done" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("nobody-board", "/tmp/nobody-board");
    const task = createTask({
      board_id: board.id,
      title: "No body",
      assignee: "nobodyagent",
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
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_TASK_TITLE).toBe("No body");
    expect(calls[0][4]!.KDI_TASK_BODY).toBe("");
    expect(calls[0][4]!.KDI_TASK_ID).toBe(String(task.id));
    expect(calls[0][4]!.KDI_BOARD).toBe("nobody-board");
  });

  it("does not pass task context when FF_HARNESS_CONTEXT is disabled", async () => {
    setFlag(FF_HARNESS_CONTEXT, false);
    setFlag(FF_RESULT_SUMMARY, false);
    const home = setupTempHome([
      { name: "disabledcontextagent", command: "echo '{{title}}' '{{body}}'" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("disabled-context-board", "/tmp/disabled-context-board");
    const task = createTask({
      board_id: board.id,
      title: "Disabled context title",
      body: "Disabled context body",
      assignee: "disabledcontextagent",
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
    clearOverrides();

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("'' ''");
    expect(calls[0][4]).toBeUndefined();
  });

  it("records current_step_key on the run when claiming", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({
      board_id: board.id,
      title: "Run step key test",
      assignee: "opencode",
      current_step_key: "deploy",
    });
    promoteTask(task.id);

    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    const { getRuns } = await import("../src/models/taskRun");
    const runs = getRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].step_key).toBe("deploy");
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

  it("EX_TEMPFAIL treats exit 75 as normal failure when flag is disabled", async () => {
    setFlag(FF_RATE_LIMIT_EXIT_CODE, false);
    const board = createBoard("tempfail-disabled-board", "/tmp/tempfail-disabled-board");
    const task = createTask({
      board_id: board.id,
      title: "Tempfail me disabled",
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
    expect(updated!.consecutive_failures).toBe(1);
    expect(updated!.rate_limited_until).toBeNull();
    clearOverrides();
  });

  it("EX_TEMPFAIL does not increment consecutive_failures when flag is enabled", async () => {
    setFlag(FF_RATE_LIMIT_EXIT_CODE, true);

    const board = createBoard("tempfail-board", "/tmp/tempfail-board");
    const task = createTask({
      board_id: board.id,
      title: "Tempfail me",
      assignee: "opencode",
      max_retries: 3,
    });
    promoteTask(task.id);

    const before = Math.floor(Date.now() / 1000);
    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "", stderr: "rate limited", exitCode: 75 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });
    const after = Math.floor(Date.now() / 1000);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.consecutive_failures).toBe(0);
    expect(updated!.rate_limited_until).not.toBeNull();
    expect(updated!.rate_limited_until).toBeGreaterThanOrEqual(before + 60);
    expect(updated!.rate_limited_until).toBeLessThanOrEqual(after + 60);

    const events = getEvents(task.id);
    const rateLimitedEvent = events.find((e) => e.kind === "rate_limited");
    expect(rateLimitedEvent).toBeDefined();
    const payload = JSON.parse(rateLimitedEvent!.payload ?? "{}");
    expect(payload.exit_code).toBe(75);
    expect(payload.cooldown_until).toBe(updated!.rate_limited_until);
    expect(payload.reason).toBe("rate limited");

    const runs = getRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("reclaimed");
    expect(runs[0].status).toBe("released");
    expect(runs[0].error).toContain("Rate-limited");
  });

  it("rate-limited task is skipped during cooldown window", async () => {
    setFlag(FF_RATE_LIMIT_EXIT_CODE, true);

    const board = createBoard("cooldown-board", "/tmp/cooldown-board");
    const task = createTask({
      board_id: board.id,
      title: "Cooldown task",
      assignee: "opencode",
    });
    promoteTask(task.id);

    const harness = mock(() => Promise.resolve({ stdout: "", stderr: "rate limited", exitCode: 75 }));

    // First tick: rate-limit the task
    await tick({
      spawnHarness: harness,
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    let updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.rate_limited_until).not.toBeNull();

    // Second tick: should not claim or spawn the task
    const result = await tick({
      spawnHarness: harness,
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(result.processed).toBe(0);
    expect(harness).toHaveBeenCalledTimes(1);

    updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
  });

  it("rate-limited task is claimed again after cooldown passes", async () => {
    setFlag(FF_RATE_LIMIT_EXIT_CODE, true);

    const board = createBoard("cooldown-expired-board", "/tmp/cooldown-expired-board");
    const task = createTask({
      board_id: board.id,
      title: "Cooldown expired task",
      assignee: "opencode",
    });
    promoteTask(task.id);

    const db = getDb();
    db.run("UPDATE tasks SET rate_limited_until = unixepoch() - 1 WHERE id = ?", [task.id]);

    const result = await tick({
      spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });

    expect(result.processed).toBe(1);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.rate_limited_until).toBeNull();
  });

  it("rate-limit cooldown can be overridden via tick option", async () => {
    setFlag(FF_RATE_LIMIT_EXIT_CODE, true);

    const board = createBoard("cooldown-override-board", "/tmp/cooldown-override-board");
    const task = createTask({
      board_id: board.id,
      title: "Cooldown override task",
      assignee: "opencode",
    });
    promoteTask(task.id);

    const before = Math.floor(Date.now() / 1000);
    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "", stderr: "rate limited", exitCode: 75 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      rateLimitCooldownSeconds: 300,
    });
    const after = Math.floor(Date.now() / 1000);

    const updated = showTask(task.id);
    expect(updated!.rate_limited_until).toBeGreaterThanOrEqual(before + 300);
    expect(updated!.rate_limited_until).toBeLessThanOrEqual(after + 300);
  });

  it("rate-limit cooldown can be overridden via KDI_RATE_LIMIT_COOLDOWN_SECONDS", async () => {
    setFlag(FF_RATE_LIMIT_EXIT_CODE, true);
    const originalEnv = process.env.KDI_RATE_LIMIT_COOLDOWN_SECONDS;
    process.env.KDI_RATE_LIMIT_COOLDOWN_SECONDS = "180";

    const board = createBoard("cooldown-env-board", "/tmp/cooldown-env-board");
    const task = createTask({
      board_id: board.id,
      title: "Cooldown env task",
      assignee: "opencode",
    });
    promoteTask(task.id);

    const before = Math.floor(Date.now() / 1000);
    await tick({
      spawnHarness: () => Promise.resolve({ stdout: "", stderr: "rate limited", exitCode: 75 }),
      createWorktree: () => "/tmp/mock-worktree",
      removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
    });
    const after = Math.floor(Date.now() / 1000);

    if (originalEnv !== undefined) {
      process.env.KDI_RATE_LIMIT_COOLDOWN_SECONDS = originalEnv;
    } else {
      delete process.env.KDI_RATE_LIMIT_COOLDOWN_SECONDS;
    }

    const updated = showTask(task.id);
    expect(updated!.rate_limited_until).toBeGreaterThanOrEqual(before + 180);
    expect(updated!.rate_limited_until).toBeLessThanOrEqual(after + 180);
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
    delete process.env.FF_RATE_LIMIT_EXIT_CODE;
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

  describe("crash grace period", () => {
    it("records spawned_at on the active run", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", true);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({ board_id: board.id, title: "Grace task", assignee: "opencode" });
      promoteTask(task.id);

      await tick({
        spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0, pid: 1234 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      });

      const runs = getRuns(task.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].spawned_at).toBeNumber();
      expect(runs[0].worker_pid).toBe(1234);
    });

    it("does not reclaim a dead PID within the grace period when flag enabled", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", true);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({ board_id: board.id, title: "Grace task", assignee: "opencode" });
      promoteTask(task.id);

      const claim = atomicClaim(task.id, "opencode");
      expect(claim.success).toBe(true);

      const now = Math.floor(Date.now() / 1000);
      updateRun(claim.runId!, { worker_pid: 999999, spawned_at: now });

      await tick();

      const updated = showTask(task.id);
      expect(updated!.status).toBe("running");
      const runs = getRuns(task.id);
      expect(runs[0].status).toBe("running");
    });

    it("reclaims a dead PID after the grace period when flag enabled", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", true);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({ board_id: board.id, title: "Grace task", assignee: "opencode" });
      promoteTask(task.id);

      const claim = atomicClaim(task.id, "opencode");
      expect(claim.success).toBe(true);

      const now = Math.floor(Date.now() / 1000);
      updateRun(claim.runId!, { worker_pid: 999999, spawned_at: now - 31 });

      await tick();

      const updated = showTask(task.id);
      expect(updated!.status).toBe("blocked");
      const runs = getRuns(task.id);
      expect(runs[0].status).toBe("crashed");
      expect(runs[0].outcome).toBe("crashed");
      expect(runs[0].error).toContain("grace period");
    });

    it("treats an immediate dead PID as a crash when flag disabled", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", false);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({ board_id: board.id, title: "Grace task", assignee: "opencode" });
      promoteTask(task.id);

      const claim = atomicClaim(task.id, "opencode");
      expect(claim.success).toBe(true);

      const now = Math.floor(Date.now() / 1000);
      updateRun(claim.runId!, { worker_pid: 999999, spawned_at: now });

      await tick();

      const updated = showTask(task.id);
      expect(updated!.status).toBe("blocked");
      const runs = getRuns(task.id);
      expect(runs[0].status).toBe("crashed");
      expect(runs[0].outcome).toBe("crashed");
    });

    it("requeues crashed task with max_retries after grace period", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", true);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({ board_id: board.id, title: "Grace retry task", assignee: "opencode", max_retries: 3 });
      promoteTask(task.id);

      const claim = atomicClaim(task.id, "opencode");
      const now = Math.floor(Date.now() / 1000);
      updateRun(claim.runId!, { worker_pid: 999999, spawned_at: now - 31 });

      await tick({
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
        maxSpawnsPerTick: 0,
      });

      const updated = showTask(task.id);
      expect(updated!.status).toBe("ready");
      expect(updated!.consecutive_failures).toBe(1);
      const runs = getRuns(task.id);
      expect(runs[0].status).toBe("crashed");
      expect(runs[0].outcome).toBe("crashed");
    });

    it("keeps successful harness runs unchanged when flag enabled", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", true);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({ board_id: board.id, title: "Normal task", assignee: "opencode" });
      promoteTask(task.id);

      const result = await tick({
        spawnHarness: () => Promise.resolve({ stdout: "done", stderr: "", exitCode: 0 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      });

      expect(result.processed).toBe(1);
      expect(showTask(task.id)!.status).toBe("done");
    });

    it("keeps timeout behavior unchanged when flag enabled", async () => {
      setFlag("FF_CRASH_GRACE_PERIOD", true);
      const board = createBoard("grace-board", "/tmp/grace-board");
      const task = createTask({
        board_id: board.id,
        title: "Slow task",
        assignee: "opencode",
        max_runtime_seconds: 1,
      });
      promoteTask(task.id);

      const result = await tick({
        spawnHarness: async (_command, _cwd, _logPath, timeoutMs) => {
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
      const runs = getRuns(task.id);
      expect(runs[0].status).toBe("timed_out");
    });

  });

  describe("notifier watcher integration", () => {
    let notifierHome: string;
    let stderrWrites: string[];
    let originalStderrWrite: typeof process.stderr.write;

    beforeEach(() => {
      notifierHome = mkdtempSync(join(tmpdir(), "kdi-dispatcher-notify-"));
      process.env.KDI_NOTIFIERS_PATH = join(notifierHome, "notifiers.yaml");
      process.env.KDI_NOTIFIER_CURSORS_PATH = join(notifierHome, "cursors");
      setFlag(FF_NOTIFY_SUBS, true);

      stderrWrites = [];
      originalStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array, ...args: any[]) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return originalStderrWrite(chunk, ...args);
      }) as any;
    });

    afterEach(() => {
      process.stderr.write = originalStderrWrite;
      if (process.env.KDI_NOTIFIERS_PATH === join(notifierHome, "notifiers.yaml")) {
        delete process.env.KDI_NOTIFIERS_PATH;
      }
      if (process.env.KDI_NOTIFIER_CURSORS_PATH === join(notifierHome, "cursors")) {
        delete process.env.KDI_NOTIFIER_CURSORS_PATH;
      }
      rmSync(notifierHome, { recursive: true, force: true });
    });

    it("delivers a completed event notification via log transport on tick", async () => {
      const board = createBoard("notify-dispatch-board", "/tmp/notify-dispatch-board");
      const task = createTask({ board_id: board.id, title: "Notify me", assignee: "opencode" });
      promoteTask(task.id);
      subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

      await tick({
        spawnHarness: () => Promise.resolve({ stdout: "done", stderr: "", exitCode: 0 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      });

      const updated = showTask(task.id);
      expect(updated!.status).toBe("done");

      const delivered = stderrWrites
        .map((line) => JSON.parse(line))
        .find((entry) => entry.eventKind === "finished" || entry.eventKind === "completed");
      expect(delivered).toBeDefined();
      expect(delivered.taskId).toBe(task.id);
      expect(delivered.profile).toBe("log");
    });

    it("does not run notifier watcher when FF_NOTIFY_SUBS is disabled", async () => {
      setFlag(FF_NOTIFY_SUBS, false);

      const board = createBoard("notify-off-board", "/tmp/notify-off-board");
      const task = createTask({ board_id: board.id, title: "No notify", assignee: "opencode" });
      promoteTask(task.id);
      subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

      await tick({
        spawnHarness: () => Promise.resolve({ stdout: "done", stderr: "", exitCode: 0 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      });

      const delivered = stderrWrites
        .map((line) => JSON.parse(line))
        .find((entry) => entry.eventKind === "finished" || entry.eventKind === "completed");
      expect(delivered).toBeUndefined();
    });
  });

  describe("failure limit", () => {
    beforeEach(() => {
      setFlag(FF_DISPATCH_CONTROLS, true);
    });

    describe("parseFailureLimit", () => {
      it("returns parsed value for valid input", () => {
        expect(parseFailureLimit("3")).toBe(3);
      });

      it("rejects zero", () => {
        expect(() => parseFailureLimit("0")).toThrow(/positive integer/);
      });

      it("rejects negative", () => {
        expect(() => parseFailureLimit("-2")).toThrow(/positive integer/);
      });

      it("rejects non-numeric", () => {
        expect(() => parseFailureLimit("xyz")).toThrow(/positive integer/);
      });

      it("rejects fractional", () => {
        expect(() => parseFailureLimit("1.5")).toThrow(/positive integer/);
      });
    });

    it("stops spawning after N distinct failures and emits warning", async () => {
      const board = createBoard("fl-board", "/tmp/fl-board");
      // Create 3 tasks, all will fail (no workdir = board failure)
      const t1 = createTask({ board_id: board.id, title: "Task 1", assignee: "opencode" });
      promoteTask(t1.id);
      const t2 = createTask({ board_id: board.id, title: "Task 2", assignee: "opencode" });
      promoteTask(t2.id);
      const t3 = createTask({ board_id: board.id, title: "Task 3", assignee: "opencode" });
      promoteTask(t3.id);

      // Override workdir to null to trigger board-not-found failures
      // Use existing board workdir which is valid
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: string[]) => { warnings.push(args.join(" ")); };

      try {
        await tick({
          failureLimit: 2,
        });
      } finally {
        console.warn = origWarn;
      }

      // Should have stopped after 2 failures
      expect(warnings.some((w) => w.includes("failure limit of 2 reached"))).toBe(true);
    });

    it("does not stop when failures are under the limit", async () => {
      const board = createBoard("fl2-board", "/tmp/fl2-board");
      const task = createTask({ board_id: board.id, title: "Task 1", assignee: "opencode" });
      promoteTask(task.id);

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: string[]) => { warnings.push(args.join(" ")); };

      const result = await tick({
        spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
        failureLimit: 5,
      });

      console.warn = origWarn;

      expect(result.processed).toBe(1);
      expect(warnings.some((w) => w.includes("failure limit"))).toBe(false);
    });

    it("composes with --max: stops at spawn cap even with no failures", async () => {
      const board = createBoard("fl3-board", "/tmp/fl3-board");
      const t1 = createTask({ board_id: board.id, title: "Task 1", assignee: "opencode" });
      promoteTask(t1.id);
      const t2 = createTask({ board_id: board.id, title: "Task 2", assignee: "opencode" });
      promoteTask(t2.id);

      const result = await tick({
        spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
        maxSpawnsPerTick: 1,
        failureLimit: 10,
      });

      // Only 1 spawned (maxSpawns cap), both are ready
      expect(result.processed).toBe(1);
    });

    it("stops at failure limit even when max is higher", async () => {
      const board = createBoard("fl4-board", "/tmp/fl4-board");
      // Create tasks with non-existent workdir so they fail
      const t1 = createTask({ board_id: board.id, title: "Task 1", assignee: "opencode" });
      promoteTask(t1.id);
      const t2 = createTask({ board_id: board.id, title: "Task 2", assignee: "opencode" });
      promoteTask(t2.id);
      const t3 = createTask({ board_id: board.id, title: "Task 3", assignee: "opencode" });
      promoteTask(t3.id);

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: string[]) => { warnings.push(args.join(" ")); };

      try {
        await tick({
          maxSpawnsPerTick: 10,
          failureLimit: 1,
        });
      } finally {
        console.warn = origWarn;
      }

      expect(warnings.some((w) => w.includes("failure limit of 1 reached"))).toBe(true);
    });

    it("no limit behavior when failureLimit is not set", async () => {
      const board = createBoard("fl5-board", "/tmp/fl5-board");
      const t1 = createTask({ board_id: board.id, title: "Task 1", assignee: "opencode" });
      promoteTask(t1.id);
      const t2 = createTask({ board_id: board.id, title: "Task 2", assignee: "opencode" });
      promoteTask(t2.id);

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: string[]) => { warnings.push(args.join(" ")); };

      const result = await tick({
        spawnHarness: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
      });

      console.warn = origWarn;

      expect(result.processed).toBe(2);
      expect(warnings.some((w) => w.includes("failure limit"))).toBe(false);
    });

    it("rate-limited tasks do not increment the failure counter", async () => {
      setFlag(FF_RATE_LIMIT_EXIT_CODE, true);
      const board = createBoard("fl6-board", "/tmp/fl6-board");
      const t1 = createTask({ board_id: board.id, title: "Rate-limited", assignee: "opencode" });
      promoteTask(t1.id);
      const t2 = createTask({ board_id: board.id, title: "Success", assignee: "opencode" });
      promoteTask(t2.id);

      let callCount = 0;
      const result = await tick({
        spawnHarness: async () => {
          callCount++;
          if (callCount === 1) {
            return { stdout: "", stderr: "rate limited", exitCode: 75 };
          }
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
        createWorktree: () => "/tmp/mock-worktree",
        removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
        failureLimit: 1,
      });

      // Both tasks should process (rate-limited not counted as failure)
      expect(result.processed).toBe(1);
      const rlTask = showTask(t1.id);
      expect(rlTask).not.toBeNull();
    });

    it("harness execution failure increments the counter", async () => {
      const board = createBoard("fl7-board", "/tmp/fl7-board");
      const t1 = createTask({ board_id: board.id, title: "Failing", assignee: "opencode" });
      promoteTask(t1.id);
      const t2 = createTask({ board_id: board.id, title: "Also ready", assignee: "opencode" });
      promoteTask(t2.id);

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: string[]) => { warnings.push(args.join(" ")); };

      try {
        await tick({
          spawnHarness: () => Promise.resolve({ stdout: "", stderr: "bad", exitCode: 1 }),
          createWorktree: () => "/tmp/mock-worktree",
          removeWorktree: () => ({ worktreeRemoved: true, branchDeleted: true, found: true }),
          failureLimit: 1,
        });
      } finally {
        console.warn = origWarn;
      }

      expect(warnings.some((w) => w.includes("failure limit of 1 reached"))).toBe(true);
    });
  });
});

describe("result summary extraction", () => {
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

  it("uses .kdi-result.txt when present", () => {
    const worktree = mkdtempSync(join(tmpdir(), "kdi-result-file-"));
    writeFileSync(join(worktree, ".kdi-result.txt"), "  clean result from file  ", "utf-8");
    const result = extractHarnessResult(worktree, "raw stdout");
    expect(result.result).toBe("clean result from file");
    expect(result.summary).toBe("clean result from file");
    rmSync(worktree, { recursive: true, force: true });
  });

  it("uses last JSON text chunk from stdout when result file is absent", () => {
    const worktree = mkdtempSync(join(tmpdir(), "kdi-result-json-"));
    const stdout = `{"type":"status","message":"first"}\n{"type":"result","content":"final answer"}\n`;
    const result = extractHarnessResult(worktree, stdout);
    expect(result.result).toBe("final answer");
    expect(result.summary).toBe("final answer");
    rmSync(worktree, { recursive: true, force: true });
  });

  it("falls back to raw stdout on malformed JSON / no result file", () => {
    const worktree = mkdtempSync(join(tmpdir(), "kdi-result-fallback-"));
    const stdout = "plain text output\nwith lines";
    const result = extractHarnessResult(worktree, stdout);
    expect(result.result).toBe(stdout.trim());
    expect(result.summary).toBe(stdout.trim().slice(0, 200));
    rmSync(worktree, { recursive: true, force: true });
  });

  it("prefers result file over JSON stdout", () => {
    const worktree = mkdtempSync(join(tmpdir(), "kdi-result-prefer-"));
    writeFileSync(join(worktree, ".kdi-result.txt"), "file wins", "utf-8");
    const stdout = `{"content":"json wins"}`;
    const result = extractHarnessResult(worktree, stdout);
    expect(result.result).toBe("file wins");
    rmSync(worktree, { recursive: true, force: true });
  });

  it("stores raw stdout when FF_RESULT_SUMMARY is disabled", async () => {
    setFlag(FF_RESULT_SUMMARY, false);
    const board = createBoard("rs-disabled-board", "/tmp/rs-disabled-board");
    const task = createTask({ board_id: board.id, title: "Raw stdout task", assignee: "opencode" });
    promoteTask(task.id);

    const worktree = mkdtempSync(join(tmpdir(), "kdi-rs-disabled-"));
    const stdout = `{"content":"should be ignored"}`;
    const mockHarness = mock(() => Promise.resolve({ stdout, stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => worktree);
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.result).toBe(stdout);
    expect(updated!.summary).toBe(stdout.slice(0, 200));

    const runs = getRuns(task.id);
    expect(runs[0].summary).toBe(stdout.slice(0, 200));

    rmSync(worktree, { recursive: true, force: true });
  });

  it("stores clean summary from JSON stdout when FF_RESULT_SUMMARY is enabled", async () => {
    setFlag(FF_RESULT_SUMMARY, true);
    const board = createBoard("rs-enabled-board", "/tmp/rs-enabled-board");
    const task = createTask({ board_id: board.id, title: "Clean summary task", assignee: "opencode" });
    promoteTask(task.id);

    const worktree = mkdtempSync(join(tmpdir(), "kdi-rs-enabled-"));
    const stdout = `{"type":"thinking","content":"step one"}\n{"type":"final","content":"  clean answer  "}`;
    const mockHarness = mock(() => Promise.resolve({ stdout, stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => worktree);
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.result).toBe("clean answer");
    expect(updated!.summary).toBe("clean answer");

    const runs = getRuns(task.id);
    expect(runs[0].summary).toBe("clean answer");

    rmSync(worktree, { recursive: true, force: true });
  });

  it("stores clean result from .kdi-result.txt when flag enabled", async () => {
    setFlag(FF_RESULT_SUMMARY, true);
    const board = createBoard("rs-file-board", "/tmp/rs-file-board");
    const task = createTask({ board_id: board.id, title: "Result file task", assignee: "opencode" });
    promoteTask(task.id);

    const worktree = mkdtempSync(join(tmpdir(), "kdi-rs-file-"));
    writeFileSync(join(worktree, ".kdi-result.txt"), "Result from file", "utf-8");
    const mockHarness = mock(() => Promise.resolve({ stdout: "raw stdout", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => worktree);
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.result).toBe("Result from file");
    expect(updated!.summary).toBe("Result from file");

    rmSync(worktree, { recursive: true, force: true });
  });

  it("passes result_file to harness via {{result_file}} template and KDI_RESULT_FILE env when flag enabled", async () => {
    setFlag(FF_RESULT_SUMMARY, true);
    const home = setupTempHome([{ name: "resultagent", command: "echo {{result_file}}" }]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("result-file-board", "/tmp/result-file-board");
    const task = createTask({ board_id: board.id, title: "Result file env task", assignee: "resultagent" });
    promoteTask(task.id);

    const worktree = mkdtempSync(join(tmpdir(), "kdi-rs-env-"));
    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => worktree);
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
    rmSync(worktree, { recursive: true, force: true });

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain(`${worktree}/.kdi-result.txt`);
    expect(calls[0][4]).toBeDefined();
    expect(calls[0][4]!.KDI_RESULT_FILE).toBe(`${worktree}/.kdi-result.txt`);
  });
});

// KDI-038: goal-mode dispatcher tests
describe("dispatcher goal mode", () => {
  beforeEach(() => {
    testDbPath = join(tmpdir(), `kdi-dispatcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(testDbPath);
    initDb(testDbPath);
    setFlag("FF_ENABLE_KANBAN_DISPATCH", true);
    setFlag(FF_GOAL_MODE, true);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(testDbPath);
  });

  it("non-satisfied turn requeues task with decremented remaining turns", async () => {
    const board = createBoard("goal-board", "/tmp/goal-board");
    const task = createTask({
      board_id: board.id,
      title: "Goal refactor",
      assignee: "opencode",
      goal_mode: true,
      goal_max_turns: 2,
      goal_judge_profile: "opencode",
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "turn output", stderr: "fail", exitCode: 1 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.goal_remaining_turns).toBe(1);

    const events = getEvents(task.id);
    const turnEvents = events.filter((e) => e.kind === "goal_turn");
    expect(turnEvents.length).toBe(1);
    expect(turnEvents[0].payload).toContain("\"verdict\":\"continue\"");
  });

  it("exhausted turn budget blocks the task with 'Goal max turns exhausted'", async () => {
    const board = createBoard("goal-board2", "/tmp/goal-board2");
    const task = createTask({
      board_id: board.id,
      title: "Goal exhaust",
      assignee: "opencode",
      goal_mode: true,
      goal_max_turns: 1,
      goal_judge_profile: "opencode",
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toBe("Goal max turns exhausted");
    expect(updated!.goal_remaining_turns).toBe(0);

    const events = getEvents(task.id);
    const turnEvents = events.filter((e) => e.kind === "goal_turn");
    expect(turnEvents.length).toBe(1);
    expect(turnEvents[0].payload).toContain("\"verdict\":\"exhausted\"");
  });

  it("successful harness on goal task satisfies the goal and finishes", async () => {
    const board = createBoard("goal-board3", "/tmp/goal-board3");
    const task = createTask({
      board_id: board.id,
      title: "Goal done",
      assignee: "opencode",
      goal_mode: true,
      goal_max_turns: 5,
      goal_judge_profile: "opencode",
    });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "all good", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.consecutive_failures).toBe(0);

    const events = getEvents(task.id);
    const turnEvents = events.filter((e) => e.kind === "goal_turn");
    expect(turnEvents.length).toBe(1);
    expect(turnEvents[0].payload).toContain("\"verdict\":\"done\"");
  });

  it("goal tasks behave as normal tasks when FF_GOAL_MODE is disabled", async () => {
    setFlag(FF_GOAL_MODE, false);
    const board = createBoard("goal-board4", "/tmp/goal-board4");
    // Bypass createTask validation by writing goal_mode directly to the DB.
    const { getDb } = await import("../src/db");
    const created = createTask({ board_id: board.id, title: "Direct goal task", assignee: "opencode" });
    getDb().run(`UPDATE tasks SET goal_mode = 1, goal_max_turns = 2, goal_remaining_turns = 2, goal_judge_profile = 'opencode' WHERE id = ?`, [created.id]);
    promoteTask(created.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(created.id);
    expect(updated!.status).toBe("done");
  });

  it("non-goal task with FF_GOAL_MODE enabled is unaffected", async () => {
    const board = createBoard("nongoal-board", "/tmp/nongoal-board");
    const task = createTask({ board_id: board.id, title: "Normal task", assignee: "opencode" });
    promoteTask(task.id);

    const mockHarness = mock(() => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }));
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
  });

  it("passes KDI_GOAL_* env vars to the harness on goal-mode tasks", async () => {
    const board = createBoard("goal-env-board", "/tmp/goal-env-board");
    const task = createTask({
      board_id: board.id,
      title: "Env vars",
      assignee: "opencode",
      goal_mode: true,
      goal_max_turns: 4,
      goal_judge_profile: "opencode",
    });
    promoteTask(task.id);

    let capturedEnv: Record<string, string> | undefined;
    const mockHarness = mock((cmd: string, cwd: string, logPath: string | undefined, timeoutMs: number | undefined, env?: Record<string, string>) => {
      capturedEnv = env;
      return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    });
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness as any,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.KDI_GOAL_MODE).toBe("true");
    expect(capturedEnv!.KDI_GOAL_MAX_TURNS).toBe("4");
    expect(capturedEnv!.KDI_GOAL_REMAINING_TURNS).toBe("4");
    expect(capturedEnv!.KDI_GOAL_TURN).toBe("1");
    expect(capturedEnv!.KDI_GOAL_VERDICT_FILE).toContain(".kdi-goal-verdict.json");
  });

  it("passes task context env vars and substitutes {{title}}/{{body}} when FF_HARNESS_CONTEXT is enabled", async () => {
    setFlag(FF_HARNESS_CONTEXT, true);

    const home = setupTempHome([
      { name: "contextagent", command: "echo '{{title}}' '{{body}}'" },
    ]);
    const originalPath = process.env.KDI_PROFILES_PATH;
    process.env.KDI_PROFILES_PATH = join(home, ".config/kdi/profiles.yaml");

    const board = createBoard("context-board", "/tmp/context-board");
    const task = createTask({
      board_id: board.id,
      title: "Parity task",
      body: "Verify harness context",
      assignee: "contextagent",
    });
    promoteTask(task.id);

    let capturedEnv: Record<string, string> | undefined;
    const mockHarness = mock((cmd: string, cwd: string, logPath: string | undefined, timeoutMs: number | undefined, env?: Record<string, string>) => {
      capturedEnv = env;
      return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
    });
    const mockCreateWorktree = mock(() => "/tmp/mock-worktree");
    const mockRemoveWorktree = mock(() => ({ worktreeRemoved: true, branchDeleted: true, found: true }));

    await tick({
      spawnHarness: mockHarness as any,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    if (originalPath !== undefined) {
      process.env.KDI_PROFILES_PATH = originalPath;
    } else {
      delete process.env.KDI_PROFILES_PATH;
    }
    rmSync(home, { recursive: true, force: true });
    delete process.env.FF_HARNESS_CONTEXT;
    delete process.env.FF_RESULT_SUMMARY;

    const calls = mockHarness.mock.calls as unknown as [string, string, string | undefined, number | undefined, Record<string, string> | undefined][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain("'Parity task'");
    expect(calls[0][0]).toContain("'Verify harness context'");
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.KDI_TASK_TITLE).toBe("Parity task");
    expect(capturedEnv!.KDI_TASK_BODY).toBe("Verify harness context");
    expect(capturedEnv!.KDI_TASK_ID).toBe(String(task.id));
    expect(capturedEnv!.KDI_BOARD).toBe("context-board");
  });
});
