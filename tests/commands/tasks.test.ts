import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getBoardDataDir } from "../../src/db";
import { cleanupDb } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { createTask } from "../../src/models/task";
import { createRun } from "../../src/models/taskRun";
import { listRunsCommand, attachTaskCommand, showTaskCommand, watchCommand } from "../../src/commands/tasks";
import { setFlag, clearOverrides, FF_TASK_ATTACHMENTS, FF_WATCH_FILTERS, FF_TENANT_NAMESPACE } from "../../src/flags";

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
