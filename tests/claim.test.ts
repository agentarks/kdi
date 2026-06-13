import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask } from "../src/models/task";
import { atomicClaim, heartbeat } from "../src/models/claim";
import { getRun, getRuns } from "../src/models/taskRun";
import { getEvents } from "../src/models/taskEvent";
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

  it("heartbeat updates task and active run timestamps", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Heartbeat task", assignee: "opencode" });
    promoteTask(task.id);

    const before = Math.floor(Date.now() / 1000);
    const claim = atomicClaim(task.id, "opencode");
    expect(claim.success).toBe(true);

    // Simulate time passing
    const updatedTask = heartbeat(task.id);
    expect(updatedTask).toBe(true);

    const after = Math.floor(Date.now() / 1000);
    const run = getRun(claim.runId!);
    expect(run).not.toBeNull();
    expect(run!.last_heartbeat_at).toBeGreaterThanOrEqual(before);
    expect(run!.last_heartbeat_at).toBeLessThanOrEqual(after);
  });

  it("heartbeat records a heartbeat event with note", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Heartbeat note task", assignee: "opencode" });
    promoteTask(task.id);
    atomicClaim(task.id, "opencode");

    const ok = heartbeat(task.id, "step 1 done");
    expect(ok).toBe(true);

    const events = getEvents(task.id);
    const heartbeatEvents = events.filter((e) => e.kind === "heartbeat");
    expect(heartbeatEvents).toHaveLength(1);
    expect(JSON.parse(heartbeatEvents[0].payload!)).toEqual({ note: "step 1 done" });
  });

  it("heartbeat returns false for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived heartbeat task", assignee: "opencode" });
    promoteTask(task.id);
    atomicClaim(task.id, "opencode");

    const { archiveTask } = require("../src/models/task");
    archiveTask(task.id);

    const ok = heartbeat(task.id);
    expect(ok).toBe(false);
  });
});
