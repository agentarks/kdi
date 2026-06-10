import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
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

    // Mark parent as done using db directly
    getDb().run(
      "UPDATE tasks SET status = 'done', updated_at = unixepoch() WHERE id = ?",
      [parent.id]
    );

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
});
