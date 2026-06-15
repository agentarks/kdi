import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getBoardDataDir } from "../../src/db";
import { cleanupDb } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { createTask, archiveTask, type Task } from "../../src/models/task";
import { createRun } from "../../src/models/taskRun";
import { listRunsCommand, attachTaskCommand, showTaskCommand, createTaskCommand, listTasksCommand } from "../../src/commands/tasks";
import { setFlag, clearOverrides, FF_TASK_ATTACHMENTS, FF_LIST_FILTERS_SORT } from "../../src/flags";

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

const KDI030_DB = "/tmp/kdi-commands-tasks-030-test.db";

describe("KDI-030 list filters and sort", () => {
  beforeEach(() => {
    cleanupDb(KDI030_DB);
    process.env.KDI_DB = KDI030_DB;
    initDb(KDI030_DB);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(KDI030_DB);
    delete process.env.KDI_DB;
    delete process.env.KDI_PROFILE;
    delete process.env.HERMES_PROFILE;
  });

  function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
    return new Promise((resolve) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const originalLog = console.log;
      const originalError = console.error;
      const originalExit = process.exit;

      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
      process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as typeof process.exit;

      fn().then(() => {
        console.log = originalLog;
        console.error = originalError;
        process.exit = originalExit;
        resolve({ logs, errors });
      }).catch(() => {
        console.log = originalLog;
        console.error = originalError;
        process.exit = originalExit;
        resolve({ logs, errors });
      });
    });
  }

  it("create --session stores session_id when flag enabled", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");

    const { logs } = await captureLogs(() =>
      createTaskCommand.parseAsync(["Session task", "--board", "kdi030", "--session", "sess-abc"], { from: "user" })
    );

    const taskId = Number(logs[0]);
    expect(taskId).toBeGreaterThan(0);

    // Verify via model
    const { showTask } = await import("../../src/models/task");
    const task = showTask(taskId);
    expect(task!.session_id).toBe("sess-abc");
  });

  it("create --session is gated by FF_LIST_FILTERS_SORT", async () => {
    setFlag(FF_LIST_FILTERS_SORT, false);
    const board = createBoard("kdi030", "/tmp/kdi030");

    const { errors } = await captureLogs(() =>
      createTaskCommand.parseAsync(["Task", "--board", "kdi030", "--session", "sess-abc"], { from: "user" })
    );

    expect(errors.some((e) => e.includes("List filters and sort feature is not enabled"))).toBe(true);
  });

  it("list --session filters by session_id", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "S1", session_id: "sess-1" });
    createTask({ board_id: board.id, title: "S2", session_id: "sess-2" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--session", "sess-1"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("S1"))).toBe(true);
    expect(logs.some((l) => l.includes("S2"))).toBe(false);
  });

  it("list --mine filters by KDI_PROFILE", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    process.env.KDI_PROFILE = "alice";
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Alice task", assignee: "alice" });
    createTask({ board_id: board.id, title: "Bob task", assignee: "bob" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--mine"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Alice task"))).toBe(true);
    expect(logs.some((l) => l.includes("Bob task"))).toBe(false);
  });

  it("list --mine falls back to HERMES_PROFILE then user", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    delete process.env.KDI_PROFILE;
    process.env.HERMES_PROFILE = "bob";
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Bob task", assignee: "bob" });
    createTask({ board_id: board.id, title: "Alice task", assignee: "alice" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--mine"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Bob task"))).toBe(true);
    expect(logs.some((l) => l.includes("Alice task"))).toBe(false);
  });

  it("list --mine and --assignee are mutually exclusive", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");

    const { errors } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--mine", "--assignee", "bob"], { from: "user" })
    );

    expect(errors.some((e) => e.includes("--mine and --assignee cannot be used together"))).toBe(true);
  });

  it("list --archived includes archived tasks", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Active" });
    const archived = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(archived.id);

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--archived"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Active"))).toBe(true);
    expect(logs.some((l) => l.includes("Archived"))).toBe(true);
  });

  it("list --status archived --archived returns only archived tasks", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Active" });
    const archived = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(archived.id);

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--status", "archived", "--archived"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Active"))).toBe(false);
    expect(logs.some((l) => l.includes("Archived"))).toBe(true);
  });

  it("list --sort priority returns tasks ordered by priority DESC", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Low", priority: 1 });
    createTask({ board_id: board.id, title: "High", priority: 10 });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "priority"], { from: "user" })
    );

    // High priority first
    const taskLines = logs.filter((l) => l.includes("["));
    expect(taskLines[0]).toContain("High");
    expect(taskLines[1]).toContain("Low");
  });

  it("list --sort title orders case-insensitively", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "zebra" });
    createTask({ board_id: board.id, title: "Apple" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "title"], { from: "user" })
    );

    const taskLines = logs.filter((l) => l.includes("["));
    expect(taskLines[0]).toContain("Apple");
    expect(taskLines[1]).toContain("zebra");
  });

  it("list --sort updated returns tasks", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "T1" });
    createTask({ board_id: board.id, title: "T2" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "updated"], { from: "user" })
    );

    // Just verify the sort key is accepted
    expect(logs.some((l) => l.includes("T1"))).toBe(true);
    expect(logs.some((l) => l.includes("T2"))).toBe(true);
  });

  it("list --sort invalid key is rejected", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");

    const { errors } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "invalid"], { from: "user" })
    );

    expect(errors.some((e) => e.includes("Invalid sort key"))).toBe(true);
  });

  it("list --workflow-template-id filters by template", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Onboard task", workflow_template_id: "onboarding" });
    createTask({ board_id: board.id, title: "Other" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--workflow-template-id", "onboarding"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Onboard task"))).toBe(true);
    expect(logs.some((l) => l.includes("Other"))).toBe(false);
  });

  it("list --step-key filters by step", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Review task", current_step_key: "review" });
    createTask({ board_id: board.id, title: "Draft task", current_step_key: "draft" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--step-key", "review"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Review task"))).toBe(true);
    expect(logs.some((l) => l.includes("Draft task"))).toBe(false);
  });

  it("list new options compose with existing filters", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Match", assignee: "alice", session_id: "s1" });
    createTask({ board_id: board.id, title: "Wrong assignee", assignee: "bob", session_id: "s1" });
    createTask({ board_id: board.id, title: "Wrong session", assignee: "alice" });

    const { logs } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--assignee", "alice", "--session", "s1"], { from: "user" })
    );

    expect(logs.some((l) => l.includes("Match"))).toBe(true);
    expect(logs.some((l) => l.includes("Wrong assignee"))).toBe(false);
    expect(logs.some((l) => l.includes("Wrong session"))).toBe(false);
  });

  it("list new options are gated by FF_LIST_FILTERS_SORT", async () => {
    setFlag(FF_LIST_FILTERS_SORT, false);
    const board = createBoard("kdi030", "/tmp/kdi030");

    const { errors } = await captureLogs(() =>
      listTasksCommand.parseAsync(["--board", "kdi030", "--mine"], { from: "user" })
    );

    expect(errors.some((e) => e.includes("List filters and sort feature is not enabled"))).toBe(true);
  });
});
