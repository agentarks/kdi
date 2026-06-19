import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { createBoard } from "../src/models/board";
import { createTask, showTask } from "../src/models/task";
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
});
