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

describe("KDI-030 list filters and sort", () => {
  beforeEach(() => {
    clearOverrides();
    cleanupDb(KDI030_DB);
    process.env.KDI_DB = KDI030_DB;
    delete process.env.KDI_PROFILE;
    delete process.env.HERMES_PROFILE;
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

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    let exited = false;
    const originalExit = process.exit;
    process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;

    try {
      await createTaskCommand.parseAsync(["Task", "--board", "kdi030", "--session", "sess-abc"], { from: "user" });
    } catch {
      // expected
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.some((e) => e.includes("List filters and sort feature is not enabled"))).toBe(true);
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

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    let exited = false;
    const originalExit = process.exit;
    process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--mine", "--assignee", "bob"], { from: "user" });
    } catch {
      // expected
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.some((e) => e.includes("--mine and --assignee cannot be used together"))).toBe(true);
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

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    let exited = false;
    const originalExit = process.exit;
    process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--sort", "invalid"], { from: "user" });
    } catch {
      // expected
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.some((e) => e.includes("Invalid sort key"))).toBe(true);
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

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    let exited = false;
    const originalExit = process.exit;
    process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;

    try {
      await listTasksCommand.parseAsync(["--board", "kdi030", "--mine"], { from: "user" });
    } catch {
      // expected
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.some((e) => e.includes("List filters and sort feature is not enabled"))).toBe(true);
  });
});
