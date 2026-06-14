import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { buildTaskContext } from "../src/models/context";
import { contextCommand } from "../src/commands/context";
import { createTask, archiveTask, completeTask, assignTask } from "../src/models/task";
import { createBoard, archiveBoard } from "../src/models/board";
import { addDependency } from "../src/models/dependency";
import { createRun } from "../src/models/taskRun";
import { addEvent } from "../src/models/taskEvent";
import { addComment } from "../src/models/comment";
import { initDb, closeDb, getBoardDataDir } from "../src/db";
import { setFlag, clearOverrides, FF_CONTEXT_BUILDER, FF_CREATED_BY } from "../src/flags";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { cleanupDb } from "./cleanupDb";
import { createAttachment } from "../src/models/taskAttachment";

const TEST_DB = "/tmp/kdi-context-test.db";

function cleanupAttachments(slugs: string[]) {
  for (const slug of slugs) {
    try {
      rmSync(getBoardDataDir(slug), { recursive: true, force: true });
    } catch {}
  }
}

describe("context builder model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    setFlag(FF_CONTEXT_BUILDER, true);
    initDb(TEST_DB);
  });

  afterEach(() => {
    delete process.env.KDI_DB;
    cleanupDb(TEST_DB);
    clearOverrides();
    closeDb();
  });

  it("returns task header and body", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Fix auth", body: "Auth is broken" });
    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.task_id).toBe(task.id);
    expect(ctx.title).toBe("Fix auth");
    expect(ctx.body).toBe("Auth is broken");
  });
});

describe("context CLI", () => {
  let logs: string[] = [];
  let errors: string[] = [];
  let exited = false;
  let exitCode: number | undefined;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  function captureOutput() {
    logs = [];
    errors = [];
    exited = false;
    exitCode = undefined;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      exited = true;
      exitCode = code;
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
  }

  function restoreOutput() {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    setFlag(FF_CONTEXT_BUILDER, true);
    initDb(TEST_DB);
  });

  afterEach(() => {
    delete process.env.KDI_DB;
    cleanupDb(TEST_DB);
    clearOverrides();
    closeDb();
    restoreOutput();
  });

  it("rejects when flag is disabled", async () => {
    setFlag(FF_CONTEXT_BUILDER, false);
    captureOutput();
    try {
      await contextCommand.parseAsync(["1", "--board", "ctx"], { from: "user" });
    } catch {
      // expected exit
    } finally {
      restoreOutput();
    }
    expect(exited).toBe(true);
    expect(errors.some((e) => e.includes("Context builder is not enabled"))).toBe(true);
  });

  it("prints human-readable context", async () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Fix auth", body: "Auth is broken" });
    captureOutput();
    try {
      await contextCommand.parseAsync([String(task.id), "--board", "ctx"], { from: "user" });
    } finally {
      restoreOutput();
    }
    const output = logs.join("\n");
    expect(output).toContain("# Task #" + task.id);
    expect(output).toContain("Fix auth");
    expect(output).toContain("## Body");
    expect(output).toContain("Auth is broken");
  });

  it("outputs JSON context", async () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Fix auth", body: "Auth is broken" });
    captureOutput();
    try {
      await contextCommand.parseAsync([String(task.id), "--board", "ctx", "--json"], { from: "user" });
    } finally {
      restoreOutput();
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.task_id).toBe(task.id);
    expect(parsed.title).toBe("Fix auth");
    expect(parsed.body).toBe("Auth is broken");
  });
});
