import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, completeTask, archiveTask } from "../src/models/task";
import {
  addDependency,
  isBlockedByDependencies,
  getChildTasks,
} from "../src/models/dependency";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-dependency-test.db";

describe("dependency model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("child is blocked when parent is not done", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const parent = createTask({ board_id: board.id, title: "Parent Task" });
    const child = createTask({ board_id: board.id, title: "Child Task" });

    addDependency(parent.id, child.id);

    const blocked = isBlockedByDependencies(child.id);
    expect(blocked).toBe(true);
  });

  it("child is unblocked when parent is done", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const parent = createTask({ board_id: board.id, title: "Parent Task" });
    const child = createTask({ board_id: board.id, title: "Child Task" });

    addDependency(parent.id, child.id);

    completeTask(parent.id);

    const blocked = isBlockedByDependencies(child.id);
    expect(blocked).toBe(false);
  });

  it("lists child tasks for a parent", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const parent = createTask({ board_id: board.id, title: "Parent Task" });
    const child1 = createTask({ board_id: board.id, title: "Child 1" });
    const child2 = createTask({ board_id: board.id, title: "Child 2" });
    const orphan = createTask({ board_id: board.id, title: "Orphan Task" });

    addDependency(parent.id, child1.id);
    addDependency(parent.id, child2.id);

    const children = getChildTasks(parent.id);
    expect(children).toHaveLength(2);
    expect(children.map((t) => t.id)).toContain(child1.id);
    expect(children.map((t) => t.id)).toContain(child2.id);
    expect(children.map((t) => t.id)).not.toContain(orphan.id);
  });

  it("throws on self-dependency", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const task = createTask({ board_id: board.id, title: "Self Task" });

    expect(() => addDependency(task.id, task.id)).toThrow("Self-dependency is not allowed");
  });

  it("throws on circular dependency", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const a = createTask({ board_id: board.id, title: "Task A" });
    const b = createTask({ board_id: board.id, title: "Task B" });

    addDependency(a.id, b.id);

    expect(() => addDependency(b.id, a.id)).toThrow("Circular dependency is not allowed");
  });

  it("throws on duplicate dependency insertion", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const parent = createTask({ board_id: board.id, title: "Parent Task" });
    const child = createTask({ board_id: board.id, title: "Child Task" });

    addDependency(parent.id, child.id);

    expect(() => addDependency(parent.id, child.id)).toThrow();
  });

  it("archived parent is excluded from blocking check", () => {
    const board = createBoard("dep-board", "/tmp/dep-board");
    const parent = createTask({ board_id: board.id, title: "Parent Task" });
    const child = createTask({ board_id: board.id, title: "Child Task" });

    addDependency(parent.id, child.id);
    archiveTask(parent.id);

    const blocked = isBlockedByDependencies(child.id);
    expect(blocked).toBe(false);
  });
});
