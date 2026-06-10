import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import { createRun, getRuns, getRun, updateRun, finishRun } from "../src/models/taskRun";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-taskrun-test.db";

describe("taskRun model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("createRun returns a run and updates task.current_run_id", async () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Run test" });

    const run = createRun({
      task_id: task.id,
      profile: "opencode",
      status: "running",
      started_at: 1000,
    });

    expect(run.id).toBeNumber();
    expect(run.task_id).toBe(task.id);
    expect(run.profile).toBe("opencode");
    expect(run.status).toBe("running");
    expect(run.started_at).toBe(1000);
    expect(run.ended_at).toBeNull();
    expect(run.outcome).toBeNull();

    // Verify task.current_run_id was updated
    const { showTask } = await import("../src/models/task");
    const updatedTask = showTask(task.id);
    expect(updatedTask!.current_run_id).toBe(run.id);
  });

  it("getRuns returns runs ordered by started_at DESC", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Multi run" });

    const run1 = createRun({ task_id: task.id, status: "running", started_at: 1000 });
    const run2 = createRun({ task_id: task.id, status: "running", started_at: 2000 });

    const runs = getRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(run2.id);
    expect(runs[1].id).toBe(run1.id);
  });

  it("updateRun updates fields and returns updated run", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Update run" });
    const run = createRun({ task_id: task.id, status: "running", started_at: 1000 });

    const updated = updateRun(run.id, {
      status: "blocked",
      worker_pid: 1234,
      last_heartbeat_at: 2000,
    });

    expect(updated.status).toBe("blocked");
    expect(updated.worker_pid).toBe(1234);
    expect(updated.last_heartbeat_at).toBe(2000);
  });

  it("finishRun sets outcome, summary, error, ended_at and clears task.current_run_id", async () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Finish run" });
    const run = createRun({ task_id: task.id, status: "running", started_at: 1000 });

    finishRun(run.id, "completed", "All good", '{"tests": 5}', null, 2000);

    const finished = getRun(run.id);
    expect(finished!.status).toBe("done");
    expect(finished!.outcome).toBe("completed");
    expect(finished!.summary).toBe("All good");
    expect(finished!.metadata).toBe('{"tests": 5}');
    expect(finished!.ended_at).toBe(2000);

    const { showTask } = await import("../src/models/task");
    const updatedTask = showTask(task.id);
    expect(updatedTask!.current_run_id).toBeNull();
  });

  it("finishRun with no endedAt uses current time", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Finish now" });
    const run = createRun({ task_id: task.id, status: "running", started_at: 1000 });

    finishRun(run.id, "crashed", null, null, "boom");

    const finished = getRun(run.id);
    expect(finished!.status).toBe("done");
    expect(finished!.outcome).toBe("crashed");
    expect(finished!.error).toBe("boom");
    expect(finished!.ended_at).toBeNumber();
  });
});
