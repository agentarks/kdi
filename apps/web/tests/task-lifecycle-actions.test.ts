import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "~/db";
import { createBoard } from "~/models/board";
import { createTask, showTask } from "~/models/task";
import {
  applyTaskAction,
  applyBulkAction,
  loadTaskList,
  loadTaskDetail,
} from "$lib/server/taskActions";

const TEST_DB = join(tmpdir(), "kdi-ui-006-test.db");

let savedHome: string | undefined;
let savedKdiDb: string | undefined;

function cleanupDb(path: string) {
  closeDb();
  try { rmSync(path); } catch {}
  try { rmSync(path + "-wal"); } catch {}
  try { rmSync(path + "-shm"); } catch {}
  try { rmSync(path + ".init.lock"); } catch {}
}

function setupEnv() {
  savedHome = process.env.HOME;
  savedKdiDb = process.env.KDI_DB;
  process.env.HOME = mkdtempSync(join(tmpdir(), "kdi-ui-006-home-"));
  process.env.KDI_DB = TEST_DB;
  cleanupDb(TEST_DB);
  initDb(TEST_DB);
}

function teardownEnv() {
  cleanupDb(TEST_DB);
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (savedKdiDb !== undefined) process.env.KDI_DB = savedKdiDb;
  else delete process.env.KDI_DB;
}

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.append(key, value);
  }
  return fd;
}

describe("task lifecycle actions", () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  it("loadTaskList resolves and creates a missing board", () => {
    const { board, tasks } = loadTaskList("default");
    expect(board).not.toBeNull();
    expect(board!.slug).toBe("default");
    expect(tasks).toEqual([]);
  });

  it("loadTaskDetail returns a task and its board", () => {
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Detail test" });
    const result = loadTaskDetail(task.id);
    expect(result.task?.id).toBe(task.id);
    expect(result.board?.id).toBe(board.id);
  });

  it("promote → block → unblock → complete → archive flow", () => {
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Lifecycle flow" });

    const promote = applyTaskAction("promote", task.id, new FormData());
    expect(promote.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("ready");

    const block = applyTaskAction("block", task.id, formData({ reason: "stuck" }));
    expect(block.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("blocked");

    const unblock = applyTaskAction("unblock", task.id, new FormData());
    expect(unblock.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("todo");

    const complete = applyTaskAction(
      "complete",
      task.id,
      formData({ result: "done", summary: "all good" })
    );
    expect(complete.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("done");

    const archive = applyTaskAction("archive", task.id, new FormData());
    expect(archive.status).toBe("success");
    expect(showTask(task.id)).toBeNull();
  });

  it("claim → heartbeat → reclaim → complete flow", () => {
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Claim flow" });

    applyTaskAction("promote", task.id, new FormData());
    expect(showTask(task.id)!.status).toBe("ready");

    const claim = applyTaskAction("claim", task.id, formData({ profile: "pi" }));
    expect(claim.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("running");

    const heartbeat = applyTaskAction("heartbeat", task.id, formData({ note: "alive" }));
    expect(heartbeat.status).toBe("success");
    expect(showTask(task.id)!.last_heartbeat_at).not.toBeNull();

    const reclaim = applyTaskAction("reclaim", task.id, formData({ reason: "done" }));
    expect(reclaim.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("ready");

    const complete = applyTaskAction("complete", task.id, formData({ result: "done" }));
    expect(complete.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("done");
  });

  it("schedule, review, assign, and reassign", () => {
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Metadata flow" });

    const future = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16);
    const schedule = applyTaskAction(
      "schedule",
      task.id,
      formData({ at: future, reason: "later" })
    );
    expect(schedule.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("scheduled");

    const unblock = applyTaskAction("unblock", task.id, new FormData());
    expect(unblock.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("ready");

    const review = applyTaskAction("review", task.id, formData({ reason: "check" }));
    expect(review.status).toBe("success");
    expect(showTask(task.id)!.status).toBe("review");

    const assign = applyTaskAction("assign", task.id, formData({ profile: "opencode" }));
    expect(assign.status).toBe("success");
    expect(showTask(task.id)!.assignee).toBe("opencode");

    const reassign = applyTaskAction(
      "reassign",
      task.id,
      formData({ profile: "pi" })
    );
    expect(reassign.status).toBe("success");
    expect(showTask(task.id)!.assignee).toBe("pi");

    const unassign = applyTaskAction("assign", task.id, formData({ profile: "none" }));
    expect(unassign.status).toBe("success");
    expect(showTask(task.id)!.assignee).toBeNull();
  });

  it("bulk actions produce per-task results and summary", () => {
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const t1 = createTask({ board_id: board.id, title: "Bulk 1" });
    const t2 = createTask({ board_id: board.id, title: "Bulk 2" });

    const result = applyBulkAction("promote", [t1.id, t2.id], new FormData());
    expect(result.summary.attempted).toBe(2);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(0);
    for (const r of result.results) {
      expect(r.status).toBe("success");
    }
    expect(showTask(t1.id)!.status).toBe("ready");
    expect(showTask(t2.id)!.status).toBe("ready");

    const blockResult = applyBulkAction(
      "block",
      [t1.id, t2.id],
      formData({ reason: "batch" })
    );
    expect(blockResult.summary.succeeded).toBe(2);
    expect(showTask(t1.id)!.status).toBe("blocked");
    expect(showTask(t2.id)!.status).toBe("blocked");

    const unblockResult = applyBulkAction("unblock", [t1.id, t2.id], new FormData());
    expect(unblockResult.summary.succeeded).toBe(2);
    expect(showTask(t1.id)!.status).toBe("todo");
    expect(showTask(t2.id)!.status).toBe("todo");
  });

  it("skips bulk block for already blocked tasks", () => {
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Skip test" });
    applyTaskAction("block", task.id, formData({ reason: "first" }));

    const result = applyBulkAction(
      "block",
      [task.id],
      formData({ reason: "second" })
    );
    expect(result.summary.attempted).toBe(1);
    expect(result.summary.succeeded).toBe(0);
    expect(result.summary.skipped).toBe(1);
    expect(result.results[0].status).toBe("skipped");
  });

  it("rejects promote dry-run and force when bulk flag is off", () => {
    process.env.FF_BULK_OPERATIONS = "false";
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Flag test" });

    const dryRun = applyTaskAction("promote", task.id, formData({ dryRun: "on" }));
    expect(dryRun.status).toBe("error");
    expect(dryRun.message).toBe("Bulk operations feature is not enabled.");

    const force = applyTaskAction("promote", task.id, formData({ force: "on" }));
    expect(force.status).toBe("error");
    expect(force.message).toBe("Bulk operations feature is not enabled.");
  });

  it("rejects schedule when scheduled status flag is off", () => {
    process.env.FF_SCHEDULED_STATUS = "false";
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Schedule flag" });

    const future = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16);
    const schedule = applyTaskAction(
      "schedule",
      task.id,
      formData({ at: future })
    );
    expect(schedule.status).toBe("error");
    expect(schedule.message).toBe("Scheduled status feature is not enabled.");
  });

  it("rejects complete metadata when flag is off", () => {
    process.env.FF_COMPLETE_METADATA = "false";
    const board = createBoard("default", join(process.env.HOME!, "boards", "default"));
    const task = createTask({ board_id: board.id, title: "Metadata flag" });

    const complete = applyTaskAction(
      "complete",
      task.id,
      formData({ metadata: '{"x":1}' })
    );
    expect(complete.status).toBe("error");
    expect(complete.message).toBe("Complete --metadata is not enabled.");
  });
});
