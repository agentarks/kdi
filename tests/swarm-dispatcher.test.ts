import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { createBoard } from "../src/models/board";
import { createTask, showTask, blockTask, completeTask, archiveTask } from "../src/models/task";
import { getEvents } from "../src/models/taskEvent";
import { tick } from "../src/dispatcher";
import { setFlag, clearOverrides, FF_SWARM_MODE, FF_ENABLE_KANBAN_DISPATCH } from "../src/flags";

const TEST_DB = "/tmp/kdi-swarm-dispatcher-test.db";

async function runTick() {
  return tick({
    spawnHarness: async () => ({ stdout: "done", stderr: "", exitCode: 0, pid: 1 }),
    createWorktree: () => "/tmp/wt",
    removeWorktree: () => ({ removed: true, branchRemoved: true }),
    maxSpawnsPerTick: 10,
  });
}

describe("dispatcher swarm watcher", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
    setFlag(FF_ENABLE_KANBAN_DISPATCH, true);
    setFlag(FF_SWARM_MODE, true);
  });

  afterEach(() => {
    clearOverrides();
    cleanupDb(TEST_DB);
  });

  it("completes orchestrator when synthesizer task finishes", async () => {
    const board = createBoard("swarm-disp", "/tmp/swarm-disp");
    const orchestrator = createTask({ board_id: board.id, title: "swarm: test", initialStatus: "triage" });
    createTask({
      board_id: board.id,
      title: "synthesize: test",
      assignee: "opencode",
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });

    await runTick();
    const updated = showTask(orchestrator.id);
    expect(updated!.status).toBe("done");
  });

  it("blocks orchestrator when a swarm child is blocked", async () => {
    const board = createBoard("swarm-disp", "/tmp/swarm-disp");
    const orchestrator = createTask({ board_id: board.id, title: "swarm: test", initialStatus: "triage" });
    const worker = createTask({
      board_id: board.id,
      title: "auth",
      assignee: "backend",
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });

    // Simulate worker blocked without running
    const db = (await import("../src/db")).getDb();
    db.run("UPDATE tasks SET status = 'blocked', block_reason = 'failed' WHERE id = ?", [worker.id]);

    await runTick();

    const updated = showTask(orchestrator.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.block_reason).toContain("auth");
  });

  it("emits swarm_failed and blocks orchestrator when a child is blocked", async () => {
    const board = createBoard("swarm-disp", "/tmp/swarm-disp");
    const orchestrator = createTask({ board_id: board.id, title: "swarm: test", initialStatus: "triage" });
    const worker = createTask({
      board_id: board.id,
      title: "auth",
      assignee: "backend",
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });

    blockTask(worker.id, "failed");

    await runTick();

    const failed = getEvents(orchestrator.id).filter((e) => e.kind === "swarm_failed");
    expect(failed).toHaveLength(1);
    const payload = JSON.parse(failed[0].payload!);
    expect(payload.child_id).toBe(worker.id);
    expect(payload.child_status).toBe("blocked");
    expect(showTask(orchestrator.id)!.status).toBe("blocked");
  });

  it("does not emit swarm_completed when orchestrator was already moved out of triage", async () => {
    const board = createBoard("swarm-disp", "/tmp/swarm-disp");
    const orchestrator = createTask({ board_id: board.id, title: "swarm: test", initialStatus: "triage" });
    createTask({
      board_id: board.id,
      title: "synthesize: test",
      assignee: "opencode",
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });

    // Orchestrator leaves triage before the synthesizer finishes
    completeTask(orchestrator.id, { summary: "already done" });

    await runTick();

    const events = getEvents(orchestrator.id).map((e) => e.kind);
    expect(events).not.toContain("swarm_completed");
  });

  it("does not emit swarm_completed when orchestrator is already archived", async () => {
    const board = createBoard("swarm-disp", "/tmp/swarm-disp");
    const orchestrator = createTask({ board_id: board.id, title: "swarm: test", initialStatus: "triage" });
    createTask({
      board_id: board.id,
      title: "synthesize: test",
      assignee: "opencode",
      initialStatus: "ready",
      swarm_parent_id: orchestrator.id,
    });

    archiveTask(orchestrator.id);

    await runTick();

    const events = getEvents(orchestrator.id).map((e) => e.kind);
    expect(events).not.toContain("swarm_completed");
  });

  it("does not emit swarm_completed when orchestrator does not exist", async () => {
    const board = createBoard("swarm-disp", "/tmp/swarm-disp");
    const missingOrchestratorId = 999999;
    createTask({
      board_id: board.id,
      title: "synthesize: orphan",
      assignee: "opencode",
      initialStatus: "ready",
      swarm_parent_id: missingOrchestratorId,
    });

    await runTick();

    const events = getEvents(missingOrchestratorId).map((e) => e.kind);
    expect(events).not.toContain("swarm_completed");
  });
});
