import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask, showTask } from "../src/models/task";
import { addDependency } from "../src/models/dependency";
import { setFlag, clearOverrides } from "../src/flags";
import { tick, startDispatcher } from "../src/dispatcher";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-dispatcher-test.db";

describe("dispatcher", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
    setFlag("FF_ENABLE_KANBAN_DISPATCH", true);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    try { rmSync(TEST_DB); } catch {}
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
    const mockRemoveWorktree = mock(() => true);

    const result = await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(1);
    expect(mockHarness).toHaveBeenCalled();
    expect(mockCreateWorktree).toHaveBeenCalled();

    const updated = showTask(task.id);
    expect(updated!.status).toBe("done");
    expect(updated!.result).toBe("success");
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
    const mockRemoveWorktree = mock(() => true);

    const result = await tick({
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(1);

    const updated = showTask(task.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("Harness failed");
  });

  it("marks task blocked when worktree creation fails", async () => {
    const board = createBoard("test-board", "/tmp/test-board");
    const task = createTask({ board_id: board.id, title: "Task", assignee: "opencode" });
    promoteTask(task.id);

    const mockCreateWorktree = mock(() => { throw new Error("git failed"); });
    const mockRemoveWorktree = mock(() => true);

    const result = await tick({
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    expect(result.processed).toBe(1);

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
    const mockRemoveWorktree = mock(() => true);

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
    const mockRemoveWorktree = mock(() => true);

    const dispatcher = startDispatcher(50, {
      spawnHarness: mockHarness,
      createWorktree: mockCreateWorktree,
      removeWorktree: mockRemoveWorktree,
    });

    // Wait for at least one tick
    await new Promise(resolve => setTimeout(resolve, 150));

    dispatcher.stop();

    expect(mockHarness).toHaveBeenCalled();
  });
});
