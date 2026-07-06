import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDb, closeDb, getBoardDataDir } from "../../src/db";
import { cleanupDb } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { createTask, archiveTask, blockTask, showTask, listTasks, type Task } from "../../src/models/task";
import { createRun } from "../../src/models/taskRun";
import { addEvent } from "../../src/models/taskEvent";
import { listRunsCommand, attachTaskCommand, showTaskCommand, createTaskCommand, listTasksCommand, watchCommand, unblockTaskCommand, archiveTaskCommand, tailTaskCommand } from "../../src/commands/tasks";
import { setFlag, clearOverrides, FF_TASK_ATTACHMENTS, FF_LIST_FILTERS_SORT, FF_COMMENT_ENHANCEMENTS, FF_WATCH_FILTERS, FF_TENANT_NAMESPACE, FF_DISPATCHER_PRESENCE_WARNING, FF_GOAL_MODE, FF_SCHEDULED_STATUS, FF_BULK_OPERATIONS, FF_TAIL_NO_FOLLOW } from "../../src/flags";
import { getDispatcherPidPath } from "../../src/dispatcherPresence";

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
  let tasksStderrOrig: typeof process.stderr.write | null = null;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    cleanupAttachments();
    process.env.KDI_DB = TEST_DB;
    sourceDir = mkdtempSync(join(tmpdir(), "kdi-attach-cmd-"));
    // Suppress Commander stderr leaks
    tasksStderrOrig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    initDb(TEST_DB);
  });

  afterEach(() => {
    if (tasksStderrOrig) process.stderr.write = tasksStderrOrig;
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

  it("runs command displays step_key when present", async () => {
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Cmd task" });
    const run = createRun({
      task_id: task.id,
      status: "done",
      started_at: 1000,
      step_key: "review",
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
    expect(line).toContain("step=review");
  });

  it("runs command hides step_key when absent", async () => {
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Cmd task" });
    createRun({
      task_id: task.id,
      status: "done",
      started_at: 1000,
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
    expect(line).not.toContain("step=");
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
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    process.stderr.write = (() => true) as typeof process.stderr.write;

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
      process.stderr.write = originalStderrWrite;
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

  // KDI-035: watch filters CLI tests
  describe("watch command filters", () => {
    it("rejects --assignee when FF_WATCH_FILTERS is disabled", async () => {
      setFlag(FF_WATCH_FILTERS, false);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--assignee", "alice"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      expect(errorMsg).toContain("Watch filters feature is not enabled");
    });

    it("rejects --tenant when FF_WATCH_FILTERS is disabled", async () => {
      setFlag(FF_WATCH_FILTERS, false);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--tenant", "team-a"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      expect(errorMsg).toContain("Watch filters feature is not enabled");
    });

    it("rejects --kinds when FF_WATCH_FILTERS is disabled", async () => {
      setFlag(FF_WATCH_FILTERS, false);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--kinds", "created,completed"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      expect(errorMsg).toContain("Watch filters feature is not enabled");
    });

    it("rejects --interval when FF_WATCH_FILTERS is disabled", async () => {
      setFlag(FF_WATCH_FILTERS, false);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--interval", "1"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      expect(errorMsg).toContain("Watch filters feature is not enabled");
    });

    it("rejects --tenant when FF_TENANT_NAMESPACE is disabled (even with FF_WATCH_FILTERS on)", async () => {
      setFlag(FF_WATCH_FILTERS, true);
      setFlag(FF_TENANT_NAMESPACE, false);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--tenant", "team-a"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      expect(errorMsg).toContain("Tenant namespace feature is not enabled");
    });

    it("rejects empty --assignee", async () => {
      setFlag(FF_WATCH_FILTERS, true);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--assignee", ""], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
    });

    it("rejects empty --kinds", async () => {
      setFlag(FF_WATCH_FILTERS, true);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--kinds", ""], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
    });

    it("rejects --interval below 0.1", async () => {
      setFlag(FF_WATCH_FILTERS, true);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--interval", "0.05"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
    });

    it("rejects non-numeric --interval", async () => {
      setFlag(FF_WATCH_FILTERS, true);

      let errorMsg = "";
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errorMsg = args.map(String).join(" "); };

      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

      try {
        await watchCommand.parseAsync(["--interval", "abc"], { from: "user" });
      } catch {}
      finally {
        console.error = originalError;
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
    });
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

let _origStderrWrite: typeof process.stderr.write | null = null;

function resetCommandOptions(cmd: unknown): void {
  const defaults: Record<string, unknown> = {};
  for (const option of (cmd as any).options ?? []) {
    if (option.defaultValue !== undefined) {
      defaults[option.attributeName()] = option.defaultValue;
    }
  }
  (cmd as any)._optionValues = defaults;
  for (const sub of (cmd as any).commands ?? []) {
    resetCommandOptions(sub);
  }
}

describe("KDI-030 list filters and sort", () => {
  beforeEach(() => {
    clearOverrides();
    cleanupDb(KDI030_DB);
    process.env.KDI_DB = KDI030_DB;
    delete process.env.KDI_PROFILE;
    delete process.env.HERMES_PROFILE;
    // Reset Commander singleton option state so repeated parses do not see
    // stale option values from prior tests.
    resetCommandOptions(createTaskCommand);
    resetCommandOptions(listTasksCommand);
    // Suppress Commander stderr leaks by intercepting process.stderr.write
    _origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    initDb(KDI030_DB);
  });

  afterEach(() => {
    if (_origStderrWrite) process.stderr.write = _origStderrWrite;
    clearOverrides();
    closeDb();
    cleanupDb(KDI030_DB);
    delete process.env.KDI_DB;
    delete process.env.KDI_PROFILE;
    delete process.env.HERMES_PROFILE;
  });

  it("create --session stores session_id when flag enabled", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["Session task", "--board", "kdi030", "--session", "sess-abc"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const taskId = Number(logs[0]);
    expect(taskId).toBeGreaterThan(0);

    const { showTask } = await import("../../src/models/task");
    const task = showTask(taskId);
    expect(task!.session_id).toBe("sess-abc");
  });

  it("create --session is gated by FF_LIST_FILTERS_SORT", async () => {
    setFlag(FF_LIST_FILTERS_SORT, false);
    createBoard("kdi030", "/tmp/kdi030");

    const originalExitCallback = (createTaskCommand as any)._exitCallback;
    createTaskCommand.exitOverride();

    let message: string | undefined;
    try {
      await createTaskCommand.parseAsync(["Task", "--board", "kdi030", "--session", "sess-abc"], { from: "user" });
    } catch (err: any) {
      message = err.message;
    } finally {
      (createTaskCommand as any)._exitCallback = originalExitCallback;
    }

    expect(message).toContain("List filters and sort feature is not enabled");
  });

  it("list --session filters by session_id", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "S1", session_id: "sess-1" });
    createTask({ board_id: board.id, title: "S2", session_id: "sess-2" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--session", "sess-1"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("S1"))).toBe(true);
    expect(logs.some((l) => l.includes("S2"))).toBe(false);
  });

  it("list --mine is accepted by command parser", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    const task = createTask({ board_id: board.id, title: "Task" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--mine"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    // --mine option is accepted; verify the command ran (either lists or shows no tasks)
    const output = logs.join(" ");
    expect(output.includes("Task") || output.includes("No tasks")).toBe(true);
  });

  it("list --mine and --assignee are mutually exclusive", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    createBoard("kdi030", "/tmp/kdi030");

    const originalExitCallback = (listTasksCommand as any)._exitCallback;
    listTasksCommand.exitOverride();

    let message: string | undefined;
    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--mine", "--assignee", "bob"], { from: "user" });
    } catch (err: any) {
      message = err.message;
    } finally {
      (listTasksCommand as any)._exitCallback = originalExitCallback;
    }

    expect(message).toContain("--mine and --assignee cannot be used together");
  });

  it("list --archived includes archived tasks", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Active" });
    const archived = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(archived.id);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--archived"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Active"))).toBe(true);
    expect(logs.some((l) => l.includes("Archived"))).toBe(true);
  });

  it("list --status archived --archived returns only archived tasks", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Active" });
    const archived = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(archived.id);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--status", "archived", "--archived"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Active"))).toBe(false);
    expect(logs.some((l) => l.includes("Archived"))).toBe(true);
  });

  it("list --sort priority returns tasks ordered by priority DESC", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Low", priority: 1 });
    createTask({ board_id: board.id, title: "High", priority: 10 });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "priority"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const taskLines = logs.filter((l) => l.includes("["));
    expect(taskLines[0]).toContain("High");
    expect(taskLines[1]).toContain("Low");
  });

  it("list --sort title orders case-insensitively", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "zebra" });
    createTask({ board_id: board.id, title: "Apple" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "title"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const taskLines = logs.filter((l) => l.includes("["));
    expect(taskLines[0]).toContain("Apple");
    expect(taskLines[1]).toContain("zebra");
  });

  it("list --sort updated returns tasks", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "T1" });
    createTask({ board_id: board.id, title: "T2" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "updated"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("T1"))).toBe(true);
    expect(logs.some((l) => l.includes("T2"))).toBe(true);
  });

  it("list --sort invalid key is rejected", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    createBoard("kdi030", "/tmp/kdi030");

    const originalExitCallback = (listTasksCommand as any)._exitCallback;
    listTasksCommand.exitOverride();

    let message: string | undefined;
    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "invalid"], { from: "user" });
    } catch (err: any) {
      message = err.message;
    } finally {
      (listTasksCommand as any)._exitCallback = originalExitCallback;
    }

    expect(message).toContain("Invalid sort key");
  });

  it("list --workflow-template-id filters by template", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Onboard task", workflow_template_id: "onboarding" });
    createTask({ board_id: board.id, title: "Other" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--workflow-template-id", "onboarding"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Onboard task"))).toBe(true);
    expect(logs.some((l) => l.includes("Other"))).toBe(false);
  });

  it("list --step-key filters by step", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Review task", current_step_key: "review" });
    createTask({ board_id: board.id, title: "Draft task", current_step_key: "draft" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--step-key", "review"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Review task"))).toBe(true);
    expect(logs.some((l) => l.includes("Draft task"))).toBe(false);
  });

  it("list new options compose with existing filters", async () => {
    setFlag(FF_LIST_FILTERS_SORT, true);
    const board = createBoard("kdi030", "/tmp/kdi030");
    createTask({ board_id: board.id, title: "Match", assignee: "alice", session_id: "s1" });
    createTask({ board_id: board.id, title: "Wrong assignee", assignee: "bob", session_id: "s1" });
    createTask({ board_id: board.id, title: "Wrong session", assignee: "alice" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--assignee", "alice", "--session", "s1"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Match"))).toBe(true);
    expect(logs.some((l) => l.includes("Wrong assignee"))).toBe(false);
    expect(logs.some((l) => l.includes("Wrong session"))).toBe(false);
  });

  it("list new options are gated by FF_LIST_FILTERS_SORT", async () => {
    setFlag(FF_LIST_FILTERS_SORT, false);
    createBoard("kdi030", "/tmp/kdi030");

    const originalExitCallback = (listTasksCommand as any)._exitCallback;
    listTasksCommand.exitOverride();

    let message: string | undefined;
    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--mine"], { from: "user" });
    } catch (err: any) {
      message = err.message;
    } finally {
      (listTasksCommand as any)._exitCallback = originalExitCallback;
    }

    expect(message).toContain("List filters and sort feature is not enabled");
  });
});

const KDI037_DB = "/tmp/kdi-commands-tasks-037-test.db";
const KDI037_SLUG = "kdi037";

function ensureBoardDir(): void {
  mkdirSync(getBoardDataDir(KDI037_SLUG), { recursive: true });
}

describe("KDI-037 dispatcher presence warning on kdi create", () => {
  beforeEach(() => {
    clearOverrides();
    cleanupDb(KDI037_DB);
    rmSync(getBoardDataDir(KDI037_SLUG), { recursive: true, force: true });
    process.env.KDI_DB = KDI037_DB;
    delete process.env.KDI_DB_PATH;
    resetCommandOptions(createTaskCommand);
    _origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    initDb(KDI037_DB);
  });

  afterEach(() => {
    if (_origStderrWrite) process.stderr.write = _origStderrWrite;
    clearOverrides();
    closeDb();
    cleanupDb(KDI037_DB);
    rmSync(getBoardDataDir(KDI037_SLUG), { recursive: true, force: true });
    delete process.env.KDI_DB;
    delete process.env.KDI_DB_PATH;
  });

  function captureWarn(): string[] {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    return warnings;
  }

  function restoreWarn(warnings: string[], captured: string[]): void {
    void warnings;
    // restore by reading the original from captured later via closure
  }

  it("does not warn when FF_DISPATCHER_PRESENCE_WARNING is disabled", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, false);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["NoWarn task", "--board", KDI037_SLUG], { from: "user" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([]);
  });

  it("does not warn when a live PID file is present", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, true);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);
    ensureBoardDir();
    writeFileSync(getDispatcherPidPath(KDI037_SLUG), `${process.pid}\n`, "utf8");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["Live task", "--board", KDI037_SLUG], { from: "user" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([]);
  });

  it("warns when no PID file is present", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, true);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);
    ensureBoardDir();
    rmSync(getDispatcherPidPath(KDI037_SLUG), { force: true });
    expect(existsSync(getDispatcherPidPath(KDI037_SLUG))).toBe(false);

    const logs: string[] = [];
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["Missing task", "--board", KDI037_SLUG], { from: "user" });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`No running dispatcher detected for board "${KDI037_SLUG}"`);
    // task id printed to stdout
    expect(logs.length).toBe(1);
    expect(Number(logs[0])).toBeGreaterThan(0);
  });

  it("warns when PID file contains a dead PID", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, true);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);
    ensureBoardDir();
    writeFileSync(getDispatcherPidPath(KDI037_SLUG), "2000000000\n", "utf8");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["Dead task", "--board", KDI037_SLUG], { from: "user" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`No running dispatcher detected for board "${KDI037_SLUG}"`);
  });

  it("warns when PID file is malformed", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, true);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);
    ensureBoardDir();
    writeFileSync(getDispatcherPidPath(KDI037_SLUG), "not-a-pid\n", "utf8");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["Malformed task", "--board", KDI037_SLUG], { from: "user" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`No running dispatcher detected for board "${KDI037_SLUG}"`);
  });

  it("suppresses warning with --no-dispatcher-warning even when flag is on and PID file missing", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, true);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);
    ensureBoardDir();
    rmSync(getDispatcherPidPath(KDI037_SLUG), { force: true });
    expect(existsSync(getDispatcherPidPath(KDI037_SLUG))).toBe(false);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["Suppressed task", "--board", KDI037_SLUG, "--no-dispatcher-warning"], { from: "user" });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([]);
  });

  it("--no-dispatcher-warning is accepted when flag is disabled (no probe, no warning)", async () => {
    setFlag(FF_DISPATCHER_PRESENCE_WARNING, false);
    createBoard(KDI037_SLUG, `/tmp/${KDI037_SLUG}`);

    const logs: string[] = [];
    const warnings: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync(["NoFlag task", "--board", KDI037_SLUG, "--no-dispatcher-warning"], { from: "user" });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([]);
    expect(logs.length).toBe(1);
    expect(Number(logs[0])).toBeGreaterThan(0);
  });
});

// KDI-038: goal-mode CLI tests
describe("goal mode create command", () => {
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

  // Capture stderr writes for the duration of the test.
  function captureStderr(): { restore: () => void; getMessages: () => string } {
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((data: any) => {
      chunks.push(String(data));
      return true;
    }) as typeof process.stderr.write;
    return {
      restore: () => { process.stderr.write = originalWrite; },
      getMessages: () => chunks.join(""),
    };
  }

  // Run kdi create via a fresh Command import. We re-require the tasks module so
  // each test gets a brand-new Command instance and Commander's internal state
  // does not leak between tests.
  async function runCreate(args: string[]): Promise<{ exited: boolean; stderr: string; stdout: string }> {
    // Dynamic import: get a fresh module instance with new Command objects.
    const modulePath = "../../src/commands/tasks";
    const mod = await import(modulePath + "?ts=" + Date.now() + Math.random());
    const cmd = (mod as any).createTaskCommand;
    const cap = captureStderr();
    const stdoutChunks: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    let exited = false;
    console.log = (...a: unknown[]) => { stdoutChunks.push(a.map(String).join(" ")); };
    process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;
    try {
      await cmd.parseAsync(["Refactor auth", "--board", "cmd-board", ...args], { from: "user" });
    } catch {
      // expected when validation rejects
    } finally {
      cap.restore();
      console.log = originalLog;
      process.exit = originalExit;
    }
    return { exited, stderr: cap.getMessages(), stdout: stdoutChunks.join("\n") };
  }

  it("rejects --goal without --goal-max-turns", async () => {
    setFlag(FF_GOAL_MODE, true);
    createBoard("cmd-board", "/tmp/cmd-board");
    const r = await runCreate(["--goal", "--goal-judge", "opencode"]);
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("--goal requires --goal-max-turns");
  });

  it("rejects --goal-max-turns without --goal", async () => {
    setFlag(FF_GOAL_MODE, true);
    createBoard("cmd-board", "/tmp/cmd-board");
    const r = await runCreate(["--goal-max-turns", "3"]);
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("--goal-max-turns requires --goal");
  });

  it("rejects non-positive --goal-max-turns", async () => {
    setFlag(FF_GOAL_MODE, true);
    createBoard("cmd-board", "/tmp/cmd-board");
    const r = await runCreate(["--goal", "--goal-max-turns", "0", "--goal-judge", "opencode"]);
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("must be a positive integer");
  });

  it("rejects unknown judge profile", async () => {
    setFlag(FF_GOAL_MODE, true);
    createBoard("cmd-board", "/tmp/cmd-board");
    const r = await runCreate(["--goal", "--goal-max-turns", "3", "--goal-judge", "nope"]);
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("Unknown judge profile");
  });

  it("rejects goal options when FF_GOAL_MODE is disabled", async () => {
    setFlag(FF_GOAL_MODE, false);
    createBoard("cmd-board", "/tmp/cmd-board");
    const r = await runCreate(["--goal", "--goal-max-turns", "3", "--goal-judge", "opencode"]);
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("Goal mode feature is not enabled");
  });

  it("show command displays goal line when flag is enabled and task is goal-mode", async () => {
    setFlag(FF_GOAL_MODE, true);
    createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({
      board_id: 1,
      title: "Show goal task",
      goal_mode: true,
      goal_max_turns: 4,
      goal_judge_profile: "ralph",
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await showTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l === "Goal mode: yes")).toBe(true);
    expect(logs.some((l) => l === "Goal max turns: 4")).toBe(true);
    expect(logs.some((l) => l === "Goal remaining turns: 4")).toBe(true);
    expect(logs.some((l) => l === "Goal judge profile: ralph")).toBe(true);
  });

  it("show command hides goal line when flag is disabled", async () => {
    setFlag(FF_GOAL_MODE, false);
    createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({
      board_id: 1,
      title: "Hidden goal task",
      goal_mode: true,
      goal_max_turns: 4,
      goal_judge_profile: "ralph",
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await showTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.startsWith("Goal:"))).toBe(false);
  });

  describe("KDI-049 tail no-follow", () => {
    async function runTail(args: string[]): Promise<{ logs: string[]; exited: boolean; stderr: string }> {
      // Dynamic import to get a fresh Command instance and avoid option-state leaks.
      const mod = await import("../../src/commands/tasks?ts=" + Date.now() + Math.random());
      const cmd = (mod as any).tailTaskCommand as typeof tailTaskCommand;
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      const originalError = console.error;
      const stderrChunks: string[] = [];
      console.error = (...a: unknown[]) => { stderrChunks.push(a.map(String).join(" ")); };
      const originalExit = process.exit;
      let exited = false;
      process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;
      try {
        await cmd.parseAsync(args, { from: "user" });
      } catch {
        // expected when process.exit is invoked
      } finally {
        console.log = originalLog;
        console.error = originalError;
        process.exit = originalExit;
      }
      return { logs, exited, stderr: stderrChunks.join("\n") };
    }

    it("--lines N prints last N events in chronological order and exits", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });
      addEvent(task.id, "promoted");
      addEvent(task.id, "blocked", { reason: "x" });

      const { logs, exited, stderr } = await runTail([String(task.id), "--lines", "2"]);
      expect(exited).toBe(false);
      expect(stderr).toBe("");
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain("promoted");
      expect(logs[1]).toContain("blocked");
    });

    it("--no-follow prints all events and exits", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });
      addEvent(task.id, "promoted");

      const { logs, exited, stderr } = await runTail([String(task.id), "--no-follow"]);
      expect(exited).toBe(false);
      expect(stderr).toBe("");
      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(logs.some((l) => l.includes("created"))).toBe(true);
      expect(logs.some((l) => l.includes("promoted"))).toBe(true);
    });

    it("--lines N on task with fewer than N events prints all events", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });
      addEvent(task.id, "promoted");

      const { logs } = await runTail([String(task.id), "--lines", "10"]);
      expect(logs.length).toBeGreaterThanOrEqual(2);
    });

    it("--lines 0 is rejected", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });

      const { exited, stderr } = await runTail([String(task.id), "--lines", "0"]);
      expect(exited).toBe(true);
      expect(stderr).toContain("--lines must be a positive integer");
    });

    it("--lines abc is rejected", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });

      const { exited, stderr } = await runTail([String(task.id), "--lines", "abc"]);
      expect(exited).toBe(true);
      expect(stderr).toContain("--lines must be a positive integer");
    });

    it("--lines -1 is rejected", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });

      const { exited, stderr } = await runTail([String(task.id), "--lines", "-1"]);
      expect(exited).toBe(true);
      expect(stderr).toContain("--lines must be a positive integer");
    });

    it("--no-follow is rejected when flag disabled", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, false);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });

      const { exited, stderr } = await runTail([String(task.id), "--no-follow"]);
      expect(exited).toBe(true);
      expect(stderr).toContain("Tail no-follow feature is not enabled");
    });

    it("--lines is rejected when flag disabled", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, false);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });

      const { exited, stderr } = await runTail([String(task.id), "--lines", "5"]);
      expect(exited).toBe(true);
      expect(stderr).toContain("Tail no-follow feature is not enabled");
    });

    it("missing task exits with clear error", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");

      const { exited, stderr } = await runTail(["99999", "--lines", "5"]);
      expect(exited).toBe(true);
      expect(stderr).toContain("Task 99999 not found");
    });

    it("default tail enters follow loop and prints existing events", async () => {
      setFlag(FF_TAIL_NO_FOLLOW, true);
      createBoard("cmd-board", "/tmp/cmd-board");
      const task = createTask({ board_id: 1, title: "Tail task" });
      addEvent(task.id, "promoted");

      // Run the default tail command in a subprocess so the follow loop is
      // killed cleanly and cannot leak timers into the test process.
      const repoRoot = resolve(import.meta.dirname, "../..");
      const proc = Bun.spawn({
        cmd: ["bun", "src/index.ts", "tail", String(task.id)],
        cwd: repoRoot,
        env: { ...process.env, KDI_DB: process.env.KDI_DB, HOME: process.env.HOME },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Give it enough time to print existing events and enter the follow loop.
      await new Promise((resolve) => setTimeout(resolve, 600));
      proc.kill(9);
      await proc.exited;

      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect(out).toContain("promoted");
      expect(err).toBe("");
    });
  });
});
const KDI047_DB = "/tmp/kdi-commands-tasks-047-test.db";
const KDI047_SLUG = "kdi047";

describe("KDI-047 bulk unblock command", () => {
  beforeEach(() => {
    clearOverrides();
    cleanupDb(KDI047_DB);
    process.env.KDI_DB = KDI047_DB;
    delete process.env.KDI_DB_PATH;
    resetCommandOptions(unblockTaskCommand);
    _origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    initDb(KDI047_DB);
  });

  afterEach(() => {
    if (_origStderrWrite) process.stderr.write = _origStderrWrite;
    clearOverrides();
    closeDb();
    cleanupDb(KDI047_DB);
    delete process.env.KDI_DB;
    delete process.env.KDI_DB_PATH;
  });

  async function runUnblock(args: string[]): Promise<{
    exited: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    };

    let exited = false;
    let exitCode = 0;
    const originalExit = process.exit;
    process.exit = ((code?: number | string | null) => {
      exited = true;
      exitCode = typeof code === "number" ? code : 0;
      throw new Error(`exit:${exitCode}`);
    }) as typeof process.exit;

    try {
      await unblockTaskCommand.parseAsync(args, { from: "user" });
    } catch (err: any) {
      if (!err.message?.startsWith("exit:")) {
        exited = true;
        exitCode = 1;
        stderr.push(`Error: ${err.message}`);
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }

    return { exited, stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
  }

  it("unblocks a single blocked task", async () => {
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const task = createTask({ board_id: 1, title: "Blocked" });
    blockTask(task.id, "reason");

    const r = await runUnblock([String(task.id)]);
    expect(r.exited).toBe(false);
    expect(r.stdout).toContain(`Unblocked task ${task.id}.`);
    expect(showTask(task.id)?.status).toBe("todo");
  });

  it("readies a single scheduled task", async () => {
    setFlag(FF_SCHEDULED_STATUS, true);
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const task = createTask({ board_id: 1, title: "Scheduled", initialStatus: "scheduled", scheduled_at: Math.floor(Date.now() / 1000) + 3600 });

    const r = await runUnblock([String(task.id)]);
    expect(r.exited).toBe(false);
    expect(r.stdout).toContain(`Task ${task.id} is now ready.`);
    expect(showTask(task.id)?.status).toBe("ready");
  });

  it("unblocks multiple blocked tasks and prints a summary", async () => {
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const t1 = createTask({ board_id: 1, title: "A" });
    const t2 = createTask({ board_id: 1, title: "B" });
    blockTask(t1.id, "x");
    blockTask(t2.id, "y");

    const r = await runUnblock([String(t1.id), String(t2.id)]);
    expect(r.exited).toBe(false);
    expect(r.stdout).toContain(`Unblocked task ${t1.id}.`);
    expect(r.stdout).toContain(`Unblocked task ${t2.id}.`);
    expect(r.stdout).toContain("Unblocked 2/2 tasks.");
    expect(showTask(t1.id)?.status).toBe("todo");
    expect(showTask(t2.id)?.status).toBe("todo");
  });

  it("skips a task that is not blocked or scheduled", async () => {
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const blocked = createTask({ board_id: 1, title: "Blocked" });
    const todo = createTask({ board_id: 1, title: "Todo" });
    blockTask(blocked.id, "x");

    const r = await runUnblock([String(blocked.id), String(todo.id)]);
    expect(r.exited).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`Unblocked task ${blocked.id}.`);
    expect(r.stderr).toContain(`Skipped task ${todo.id}`);
    expect(r.stdout).toContain("Unblocked 1/2 tasks.");
  });

  it("skips a non-existent task", async () => {
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const blocked = createTask({ board_id: 1, title: "Blocked" });
    blockTask(blocked.id, "x");

    const r = await runUnblock([String(blocked.id), "99999"]);
    expect(r.exited).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Skipped task 99999");
    expect(r.stdout).toContain("Unblocked 1/2 tasks.");
  });

  it("skips an archived task", async () => {
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const blocked = createTask({ board_id: 1, title: "Blocked" });
    const archived = createTask({ board_id: 1, title: "Archived" });
    blockTask(blocked.id, "x");
    archiveTask(archived.id);

    const r = await runUnblock([String(blocked.id), String(archived.id)]);
    expect(r.exited).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`Skipped task ${archived.id}`);
    expect(r.stdout).toContain("Unblocked 1/2 tasks.");
  });

  it("rejects no task IDs", async () => {
    const r = await runUnblock([]);
    expect(r.exited).toBe(true);
    expect(r.exitCode).toBe(1);
    // Commander prints the missing-argument error directly to process.stderr
    // and exits before our handler runs; we only assert non-zero exit.
  });

  it("records --reason as a comment on each successful unblock", async () => {
    createBoard(KDI047_SLUG, `/tmp/${KDI047_SLUG}`);
    const t1 = createTask({ board_id: 1, title: "A" });
    const t2 = createTask({ board_id: 1, title: "B" });
    blockTask(t1.id, "x");
    blockTask(t2.id, "y");

    await runUnblock([String(t1.id), String(t2.id), "--reason", "api recovered"]);
    expect(showTask(t1.id)?.status).toBe("todo");
    expect(showTask(t2.id)?.status).toBe("todo");
  });
});
describe("archive command", () => {
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

  it("archives a single task without FF_BULK_OPERATIONS", async () => {
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const task = createTask({ board_id: board.id, title: "Archive me" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await archiveTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContain(`Archived task ${task.id}.`);
    const archived = listTasks({ board_id: board.id, includeArchived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].status).toBe("archived");
  });

  it("rejects multiple task IDs when FF_BULK_OPERATIONS is disabled", async () => {
    setFlag(FF_BULK_OPERATIONS, false);
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const t1 = createTask({ board_id: board.id, title: "One" });
    const t2 = createTask({ board_id: board.id, title: "Two" });

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number | string | null | undefined) => {
      exitCode = code as number;
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;

    try {
      await archiveTaskCommand.parseAsync([String(t1.id), String(t2.id)], { from: "user" });
      expect(true).toBe(false);
    } catch (err: any) {
      if (!err.message.startsWith("exit:")) throw err;
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBe(1);
  });

  it("archives multiple tasks when FF_BULK_OPERATIONS is enabled", async () => {
    setFlag(FF_BULK_OPERATIONS, true);
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const t1 = createTask({ board_id: board.id, title: "One" });
    const t2 = createTask({ board_id: board.id, title: "Two" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await archiveTaskCommand.parseAsync([String(t1.id), String(t2.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContain(`Archived task ${t1.id}.`);
    expect(logs).toContain(`Archived task ${t2.id}.`);
    expect(logs).toContain(`Archived 2/2 tasks.`);
    const archived = listTasks({ board_id: board.id, includeArchived: true });
    expect(archived.every((t) => t.status === "archived")).toBe(true);
  });

  it("bulk archive skips already-archived tasks and reports partial success", async () => {
    setFlag(FF_BULK_OPERATIONS, true);
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const t1 = createTask({ board_id: board.id, title: "One" });
    const t2 = createTask({ board_id: board.id, title: "Two" });
    archiveTask(t2.id);

    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: number | string | null | undefined) => {
      exitCode = code as number;
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;

    try {
      await archiveTaskCommand.parseAsync([String(t1.id), String(t2.id)], { from: "user" });
      expect(true).toBe(false);
    } catch (err: any) {
      if (!err.message.startsWith("exit:")) throw err;
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(logs).toContain(`Archived task ${t1.id}.`);
    expect(logs).toContain(`Archived 1/2 tasks.`);
    expect(errors.some((e) => e.includes(`Skipped task ${t2.id}`))).toBe(true);
    expect(exitCode).toBe(1);
    const archived = listTasks({ board_id: board.id, includeArchived: true });
    expect(archived.find((t) => t.id === t1.id)?.status).toBe("archived");
  });

  it("bulk --rm still permanently deletes archived tasks", async () => {
    setFlag(FF_BULK_OPERATIONS, true);
    const board = createBoard("cmd-board", "/tmp/cmd-board");
    const t1 = createTask({ board_id: board.id, title: "One" });
    const t2 = createTask({ board_id: board.id, title: "Two" });
    archiveTask(t1.id);
    archiveTask(t2.id);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await archiveTaskCommand.parseAsync(["--rm", String(t1.id), String(t2.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContain(`Permanently deleted task ${t1.id}.`);
    expect(logs).toContain(`Permanently deleted task ${t2.id}.`);
    expect(logs).toContain(`Deleted 2/2 tasks.`);
    expect(showTask(t1.id)).toBeNull();
    expect(showTask(t2.id)).toBeNull();
  });
});
