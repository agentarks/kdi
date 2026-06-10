import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  blockTask,
  unblockTask,
  archiveTask,
  type Task,
} from "../src/models/task";
import { createBoard } from "../src/models/board";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-task-test.db";

describe("task model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("createTask returns task with all fields and defaults", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Fix bug" });

    expect(task.id).toBeNumber();
    expect(task.board_id).toBe(board.id);
    expect(task.title).toBe("Fix bug");
    expect(task.body).toBeNull();
    expect(task.assignee).toBeNull();
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("medium");
    expect(task.workspace_kind).toBe("worktree");
    expect(task.branch).toBeNull();
    expect(task.result).toBeNull();
    expect(task.summary).toBeNull();
    expect(task.block_reason).toBeNull();
    expect(task.created_at).toBeNumber();
    expect(task.updated_at).toBeNumber();
    expect(task.archived_at).toBeNull();
  });

  it("createTask with all optional fields", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({
      board_id: board.id,
      title: "Implement feature",
      body: "Detailed description",
      assignee: "alice",
      priority: "high",
      workspace_kind: "scratch",
      branch: "feature-123",
    });

    expect(task.title).toBe("Implement feature");
    expect(task.body).toBe("Detailed description");
    expect(task.assignee).toBe("alice");
    expect(task.priority).toBe("high");
    expect(task.workspace_kind).toBe("scratch");
    expect(task.branch).toBe("feature-123");
  });

  it("listTasks returns all tasks for a board", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Task 1" });
    createTask({ board_id: board.id, title: "Task 2" });

    const tasks = listTasks({ board_id: board.id });
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.title)).toContain("Task 1");
    expect(tasks.map(t => t.title)).toContain("Task 2");
  });

  it("listTasks filters by status", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Todo Task" });
    const readyTask = createTask({ board_id: board.id, title: "Ready Task" });
    
    // Promote to ready using public API
    promoteTask(readyTask.id);

    const todoTasks = listTasks({ board_id: board.id, status: "todo" });
    const readyTasks = listTasks({ board_id: board.id, status: "ready" });

    expect(todoTasks).toHaveLength(1);
    expect(todoTasks[0].title).toBe("Todo Task");
    expect(readyTasks).toHaveLength(1);
    expect(readyTasks[0].title).toBe("Ready Task");
  });

  it("listTasks filters by assignee", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Alice's Task", assignee: "alice" });
    createTask({ board_id: board.id, title: "Bob's Task", assignee: "bob" });

    const aliceTasks = listTasks({ board_id: board.id, assignee: "alice" });
    expect(aliceTasks).toHaveLength(1);
    expect(aliceTasks[0].title).toBe("Alice's Task");
  });

  it("listTasks excludes archived tasks", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Active" });
    const archived = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(archived.id);

    const tasks = listTasks({ board_id: board.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Active");
  });

  it("showTask returns task details", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const created = createTask({ board_id: board.id, title: "My Task" });

    const task = showTask(created.id);
    expect(task).not.toBeNull();
    expect(task!.id).toBe(created.id);
    expect(task!.title).toBe("My Task");
    expect(task!.status).toBe("todo");
  });

  it("showTask returns null for non-existent id", () => {
    const task = showTask(99999);
    expect(task).toBeNull();
  });

  it("showTask returns null for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(task.id);

    const result = showTask(task.id);
    expect(result).toBeNull();
  });

  it("editTask updates body and updated_at", async () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "My Task" });
    const originalUpdatedAt = task.updated_at;

    // Wait to ensure updated_at changes (unixepoch resolution is 1 second)
    await new Promise(resolve => setTimeout(resolve, 1100));
    const edited = editTask(task.id, "New body content");
    expect(edited.body).toBe("New body content");
    expect(edited.updated_at).toBeGreaterThan(originalUpdatedAt);
  });

  it("editTask throws for non-existent task", () => {
    expect(() => editTask(99999, "body")).toThrow();
  });

  it("promoteTask moves todo to ready", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Promote me" });
    expect(task.status).toBe("todo");

    const promoted = promoteTask(task.id);
    expect(promoted.status).toBe("ready");
  });

  it("promoteTask throws if task is not todo", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Already ready" });
    promoteTask(task.id); // Move to ready

    expect(() => promoteTask(task.id)).toThrow();
  });

  it("promoteTask throws for non-existent task", () => {
    expect(() => promoteTask(99999)).toThrow();
  });

  it("blockTask marks task as blocked with reason", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Block me" });

    const blocked = blockTask(task.id, "Waiting for API");
    expect(blocked.status).toBe("blocked");
    expect(blocked.block_reason).toBe("Waiting for API");
  });

  it("blockTask throws for non-existent task", () => {
    expect(() => blockTask(99999, "reason")).toThrow();
  });

  it("blockTask throws for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived task" });
    archiveTask(task.id);
    expect(() => blockTask(task.id, "reason")).toThrow();
  });

  it("unblockTask moves blocked to todo", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Unblock me" });
    blockTask(task.id, "Blocked");

    const unblocked = unblockTask(task.id);
    expect(unblocked.status).toBe("todo");
    expect(unblocked.block_reason).toBeNull();
  });

  it("unblockTask throws if task is not blocked", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Not blocked" });

    expect(() => unblockTask(task.id)).toThrow();
  });

  it("unblockTask throws for non-existent task", () => {
    expect(() => unblockTask(99999)).toThrow();
  });

  it("archiveTask sets archived_at", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archive me" });
    expect(task.archived_at).toBeNull();

    const archived = archiveTask(task.id);
    expect(archived.archived_at).toBeNumber();
    expect(archived.archived_at).not.toBeNull();
  });

  it("archiveTask throws for non-existent task", () => {
    expect(() => archiveTask(99999)).toThrow();
  });

  it("archiveTask throws for already-archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Already archived" });
    archiveTask(task.id);
    expect(() => archiveTask(task.id)).toThrow();
  });

  it("editTask throws for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived task" });
    archiveTask(task.id);
    expect(() => editTask(task.id, "new body")).toThrow();
  });
});
