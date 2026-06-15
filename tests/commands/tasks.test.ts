import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getBoardDataDir } from "../../src/db";
import { cleanupDb } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { createTask } from "../../src/models/task";
import { createRun } from "../../src/models/taskRun";
import { listRunsCommand, attachTaskCommand, showTaskCommand, blockTaskCommand, promoteTaskCommand, archiveTaskCommand } from "../../src/commands/tasks";
import { setFlag, clearOverrides, isEnabled, FF_TASK_ATTACHMENTS, FF_BULK_OPERATIONS } from "../../src/flags";
import { addDependency } from "../../src/models/dependency";

const TEST_DB = "/tmp/kdi-commands-tasks-test.db";
const TEST_SLUGS = ["cmd-board", "attach-board", "show-board"];

function cleanupAttachments() {
  for (const slug of TEST_SLUGS) {
    try {
      rmSync(getBoardDataDir(slug), { recursive: true, force: true });
    } catch {}
  }
}

describe("tasks commands", () => {
  let sourceDir: string;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    cleanupAttachments();
    process.env.KDI_DB = TEST_DB;
    sourceDir = mkdtempSync(join(tmpdir(), "kdi-attach-cmd-"));
    initDb(TEST_DB);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(TEST_DB);
    cleanupAttachments();
    try {
      rmSync(sourceDir, { recursive: true, force: true });
    } catch {}
    delete process.env.KDI_DB;
  });

  it("runs command displays spawned_at when crash grace flag is enabled", async () => {
    setFlag("FF_CRASH_GRACE_PERIOD", true);

    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Cmd task" });
    const run = createRun({
      task_id: task.id,
      status: "done",
      started_at: 1000,
      spawned_at: 2000,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await listRunsCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const line = logs.find((l) => l.includes(`Run #${run.id}`));
    expect(line).toBeDefined();
    expect(line).toContain("spawned=");
  });

  it("runs command hides spawned_at when crash grace flag is disabled", async () => {
    setFlag("FF_CRASH_GRACE_PERIOD", false);

    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Cmd task" });
    createRun({
      task_id: task.id,
      status: "done",
      started_at: 1000,
      spawned_at: 2000,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await listRunsCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const line = logs.find((l) => l.startsWith("Run #"));
    expect(line).toBeDefined();
    expect(line).not.toContain("spawned=");
  });

  it("attach command copies file when flag is enabled", async () => {
    setFlag(FF_TASK_ATTACHMENTS, true);

    const board = createBoard("attach-board", "/tmp/attach-board");
    const task = createTask({ board_id: board.id, title: "Attach task" });
    const sourcePath = join(sourceDir, "report.txt");
    writeFileSync(sourcePath, "report body");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await attachTaskCommand.parseAsync([String(task.id), sourcePath], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("report.txt") && l.includes("11 bytes"))).toBe(true);
  });

  it("attach command is rejected when flag is disabled", async () => {
    setFlag(FF_TASK_ATTACHMENTS, false);

    const board = createBoard("attach-board", "/tmp/attach-board");
    const task = createTask({ board_id: board.id, title: "Attach task" });
    const sourcePath = join(sourceDir, "report.txt");
    writeFileSync(sourcePath, "report body");

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    let exited = false;
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exited = true;
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;

    try {
      await attachTaskCommand.parseAsync([String(task.id), sourcePath], { from: "user" });
    } catch {
      // expected
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(exited).toBe(true);
    expect(errors.some((l) => l.includes("Task attachments feature is not enabled"))).toBe(true);
  });

  it("show command displays attachments when flag is enabled", async () => {
    setFlag(FF_TASK_ATTACHMENTS, true);

    const board = createBoard("show-board", "/tmp/show-board");
    const task = createTask({ board_id: board.id, title: "Show task" });
    const sourcePath = join(sourceDir, "artifact.log");
    writeFileSync(sourcePath, "log line");

    await attachTaskCommand.parseAsync([String(task.id), sourcePath], { from: "user" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await showTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Attachments:"))).toBe(true);
    expect(logs.some((l) => l.includes("artifact.log") && l.includes("8 bytes"))).toBe(true);
  });

  it("show command hides attachments when flag is disabled", async () => {
    setFlag(FF_TASK_ATTACHMENTS, false);

    const board = createBoard("show-board", "/tmp/show-board");
    const task = createTask({ board_id: board.id, title: "Show task" });
    const sourcePath = join(sourceDir, "artifact.log");
    writeFileSync(sourcePath, "log line");

    // Attach directly via model; even though the flag is off, the row exists.
    const { createAttachment } = await import("../../src/models/taskAttachment");
    createAttachment(task.id, sourcePath);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await showTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Attachments:"))).toBe(false);
    expect(logs.some((l) => l.includes("artifact.log"))).toBe(false);
  });
});

describe("bulk operations", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    cleanupAttachments();
    process.env.KDI_DB = TEST_DB;
    initDb(TEST_DB);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(TEST_DB);
    cleanupAttachments();
    delete process.env.KDI_DB;
  });

  it("flag is disabled by default", () => {
    expect(isEnabled(FF_BULK_OPERATIONS)).toBe(false);
  });

  it("setFlag enables the flag", () => {
    setFlag(FF_BULK_OPERATIONS, true);
    expect(isEnabled(FF_BULK_OPERATIONS)).toBe(true);
  });

  it("setFlag false keeps flag disabled", () => {
    setFlag(FF_BULK_OPERATIONS, false);
    expect(isEnabled(FF_BULK_OPERATIONS)).toBe(false);
  });

  it("single promote uses old path when flag disabled", () => {
    // The old promoteTask function skips dependency checks and
    // is used when isBulk=false (single task, no force/dryRun)
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    // Old promote skips dependency check — should succeed
    const { promoteTask } = require("../../src/models/task");
    const result = promoteTask(child.id);
    expect(result.status).toBe("ready");
  });

  it("promoteTaskAdvanced blocks by dependencies without force", () => {
    // The new advanced function checks dependencies
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const { promoteTaskAdvanced } = require("../../src/models/task");
    const result = promoteTaskAdvanced(child.id);
    expect(result.status).toBe("blocked_by_dependencies");
  });

  it("promoteTaskAdvanced with force bypasses dependencies", () => {
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const { promoteTaskAdvanced } = require("../../src/models/task");
    const result = promoteTaskAdvanced(child.id, { force: true });
    expect(result.status).toBe("promoted");
  });

  it("promoteTaskAdvanced dryRun does not mutate", () => {
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Dry run" });

    const { promoteTaskAdvanced, showTask } = require("../../src/models/task");
    const result = promoteTaskAdvanced(task.id, { dryRun: true });
    expect(result.status).toBe("would_promote");
    expect(showTask(task.id).status).toBe("todo");
  });

  it("archiveTaskHard cascade-deletes related rows", () => {
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Delete me" });
    const { archiveTask, archiveTaskHard, showTask } = require("../../src/models/task");
    archiveTask(task.id);
    archiveTaskHard(task.id);
    expect(showTask(task.id)).toBeNull();
  });
});
