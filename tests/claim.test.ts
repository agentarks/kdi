import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask } from "../src/models/task";
import { atomicClaim } from "../src/models/claim";
import { getRun, getRuns } from "../src/models/taskRun";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-claim-test.db";

describe("claim model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("atomicClaim copies task max_runtime_seconds to the run", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({
      board_id: board.id,
      title: "Claim cap",
      assignee: "opencode",
      max_runtime_seconds: 300,
    });
    promoteTask(task.id);

    const result = atomicClaim(task.id, "opencode");
    expect(result.success).toBe(true);
    expect(result.runId).toBeNumber();

    const run = getRun(result.runId!);
    expect(run).not.toBeNull();
    expect(run!.max_runtime_seconds).toBe(300);
  });

  it("atomicClaim leaves run max_runtime_seconds null when task has no cap", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({
      board_id: board.id,
      title: "No cap",
      assignee: "opencode",
    });
    promoteTask(task.id);

    const result = atomicClaim(task.id, "opencode");
    expect(result.success).toBe(true);

    const run = getRun(result.runId!);
    expect(run!.max_runtime_seconds).toBeNull();
  });

  it("atomicClaim fails when task is not ready", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Not ready" });

    const result = atomicClaim(task.id, "opencode");
    expect(result.success).toBe(false);
    expect(getRuns(task.id)).toHaveLength(0);
  });

  it("atomicClaim fails when task is rate-limited", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Rate limited", assignee: "opencode" });
    promoteTask(task.id);

    const db = initDb(TEST_DB);
    db.run("UPDATE tasks SET rate_limited_until = unixepoch() + 3600 WHERE id = ?", [task.id]);

    const result = atomicClaim(task.id, "opencode");
    expect(result.success).toBe(false);
    expect(getRuns(task.id)).toHaveLength(0);
  });

  it("atomicClaim clears rate_limited_until on successful claim", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Clear cooldown", assignee: "opencode" });
    promoteTask(task.id);

    const db = initDb(TEST_DB);
    db.run("UPDATE tasks SET rate_limited_until = unixepoch() - 1 WHERE id = ?", [task.id]);

    const result = atomicClaim(task.id, "opencode");
    expect(result.success).toBe(true);

    const updated = db.query("SELECT rate_limited_until FROM tasks WHERE id = ?").get(task.id) as { rate_limited_until: number | null };
    expect(updated.rate_limited_until).toBeNull();
  });
});
