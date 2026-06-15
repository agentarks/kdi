import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { buildTaskContext, capText } from "../src/models/context";
import { createContextCommand, contextCommand } from "../src/commands/context";
import { createTask, archiveTask, completeTask, assignTask } from "../src/models/task";
import { createBoard, archiveBoard } from "../src/models/board";
import { addDependency } from "../src/models/dependency";
import { createRun } from "../src/models/taskRun";
import { addEvent } from "../src/models/taskEvent";
import { addComment } from "../src/models/comment";
import { initDb, closeDb, getBoardDataDir, getDb } from "../src/db";
import { setFlag, clearOverrides, FF_CONTEXT_BUILDER, FF_CREATED_BY } from "../src/flags";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename } from "node:path";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-context-test.db";

function cleanupAttachments(slugs: string[]) {
  for (const slug of slugs) {
    try {
      rmSync(getBoardDataDir(slug), { recursive: true, force: true });
    } catch {}
  }
}

describe("capText", () => {
  it("returns trimmed text when under cap", () => {
    expect(capText("  hello  ", 10)).toBe("hello");
  });

  it("truncates long text and appends marker", () => {
    const text = "a".repeat(100);
    const result = capText(text, 10);
    expect(result).toBe("a".repeat(10) + "\n[truncated]");
  });

  it("treats null as empty string", () => {
    expect(capText(null, 10)).toBe("");
  });
});

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
    expect(ctx.status).toBe("todo");
    expect(ctx.priority).toBe(0);
    expect(ctx.assignee).toBeUndefined();
    expect(ctx.tenant).toBeUndefined();
    expect(ctx.created_by).toBeUndefined();
  });

  it("includes assignee and tenant when set", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({
      board_id: board.id,
      title: "Task",
      assignee: "opencode",
      tenant: "backend",
    });
    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.assignee).toBe("opencode");
    expect(ctx.tenant).toBe("backend");
  });

  it("includes created_by only when FF_CREATED_BY is enabled", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task", created_by: "orchestrator" });

    setFlag(FF_CREATED_BY, false);
    let ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.created_by).toBeUndefined();

    setFlag(FF_CREATED_BY, true);
    ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.created_by).toBe("orchestrator");
  });

  it("truncates body longer than 8000 characters", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const body = "b".repeat(9000);
    const task = createTask({ board_id: board.id, title: "Task", body });
    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.body.endsWith("\n[truncated]")).toBe(true);
    expect(ctx.body.length).toBe(8000 + "\n[truncated]".length);
  });

  it("throws for missing board", () => {
    expect(() => buildTaskContext(1, "missing")).toThrow(/Board "missing" not found/);
  });

  it("throws for archived board", () => {
    createBoard("ctx", "/tmp/ctx");
    archiveBoard("ctx");
    expect(() => buildTaskContext(1, "ctx")).toThrow(/Board "ctx" not found or is archived/);
  });

  it("throws for missing task", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    expect(() => buildTaskContext(999, "ctx")).toThrow(/Task 999 not found/);
  });

  it("throws for archived task", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    archiveTask(task.id);
    expect(() => buildTaskContext(task.id, "ctx")).toThrow(/Task \d+ not found/);
  });

  it("throws for task on a different board", () => {
    const boardA = createBoard("a", "/tmp/a");
    const boardB = createBoard("b", "/tmp/b");
    const task = createTask({ board_id: boardA.id, title: "Task" });
    expect(() => buildTaskContext(task.id, "b")).toThrow(/Task \d+ not found/);
  });

  it("includes only done parents in insertion order", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const parentDone = createTask({ board_id: board.id, title: "Done parent" });
    completeTask(parentDone.id, { result: "done result", summary: "done summary" });
    const parentNotDone = createTask({ board_id: board.id, title: "Not done" });
    const child = createTask({ board_id: board.id, title: "Child" });

    addDependency(parentNotDone.id, child.id);
    addDependency(parentDone.id, child.id);

    const ctx = buildTaskContext(child.id, "ctx");
    expect(ctx.parents).toHaveLength(1);
    expect(ctx.parents[0].task_id).toBe(parentDone.id);
    expect(ctx.parents[0].title).toBe("Done parent");
    expect(ctx.parents[0].result).toBe("done result");
    expect(ctx.parents[0].summary).toBe("done summary");
  });

  it("caps parent count at 10", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const child = createTask({ board_id: board.id, title: "Child" });
    const parents: number[] = [];
    for (let i = 0; i < 12; i++) {
      const p = createTask({ board_id: board.id, title: `Parent ${i}` });
      completeTask(p.id);
      addDependency(p.id, child.id);
      parents.push(p.id);
    }

    const ctx = buildTaskContext(child.id, "ctx");
    expect(ctx.parents).toHaveLength(10);
    expect(ctx.older_parents_omitted).toBe(2);
    expect(ctx.parents[0].task_id).toBe(parents[0]);
  });

  it("caps per-parent fields at 2000 characters", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    completeTask(parent.id, { result: "r".repeat(3000), summary: "s".repeat(3000) });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const ctx = buildTaskContext(child.id, "ctx");
    expect(ctx.parents[0].result.endsWith("\n[truncated]")).toBe(true);
    expect(ctx.parents[0].summary.endsWith("\n[truncated]")).toBe(true);
  });

  it("includes prior attempts ordered newest first and capped at 20", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    const runIds: number[] = [];
    for (let i = 0; i < 22; i++) {
      const run = createRun({
        task_id: task.id,
        status: "done",
        started_at: 1000 + i,
        ended_at: 2000 + i,
      });
      runIds.push(run.id);
    }

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.prior_attempts).toHaveLength(20);
    expect(ctx.older_attempts_omitted).toBe(2);
    expect(ctx.prior_attempts[0].run_id).toBe(runIds[21]);
    expect(ctx.prior_attempts[19].run_id).toBe(runIds[2]);
  });

  it("caps attempt summary and error", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    createRun({
      task_id: task.id,
      status: "crashed",
      started_at: 1000,
      ended_at: 1001,
    });

    const db = getDb();
    db.run(
      "UPDATE task_runs SET summary = ?, error = ? WHERE task_id = ?",
      ["s".repeat(3000), "e".repeat(3000), task.id]
    );

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.prior_attempts[0].summary.endsWith("\n[truncated]")).toBe(true);
    expect(ctx.prior_attempts[0].error.endsWith("\n[truncated]")).toBe(true);
  });

  it("derives role history actors per event kind", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task", created_by: "orchestrator" });
    assignTask(task.id, "opencode");

    const run = createRun({ task_id: task.id, profile: "claude", status: "running", started_at: 1000 });
    addEvent(task.id, "claimed", {}, run.id);
    addEvent(task.id, "reclaimed", { reason: "reclaim reason" }, run.id);

    const ctx = buildTaskContext(task.id, "ctx");
    const created = ctx.role_history.find((e) => e.event === "created");
    const assigned = ctx.role_history.find((e) => e.event === "assigned");
    const claimed = ctx.role_history.find((e) => e.event === "claimed");
    const reclaimed = ctx.role_history.find((e) => e.event === "reclaimed");

    expect(created?.actor).toBe("orchestrator");
    expect(assigned?.actor).toBe("opencode");
    expect(claimed?.actor).toBe("claude");
    expect(reclaimed?.actor).toBe("claude");
    expect(reclaimed?.note).toBe("reclaim reason");
  });

  it("falls back to payload profile when run is missing for claimed", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    addEvent(task.id, "claimed", { profile: "pi" });

    const ctx = buildTaskContext(task.id, "ctx");
    const claimed = ctx.role_history.find((e) => e.event === "claimed");
    expect(claimed?.actor).toBe("pi");
  });

  it("extracts notes for blocked, reviewed, and heartbeat events", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    addEvent(task.id, "blocked", { reason: "blocked reason" });
    addEvent(task.id, "reviewed", { reason: "review reason" });
    addEvent(task.id, "heartbeat", { note: "heartbeat note" });

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.role_history.some((e) => e.event === "blocked" && e.note === "blocked reason")).toBe(true);
    expect(ctx.role_history.some((e) => e.event === "reviewed" && e.note === "review reason")).toBe(true);
    expect(ctx.role_history.some((e) => e.event === "heartbeat" && e.note === "heartbeat note")).toBe(true);
  });

  it("caps role history at 100 entries", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    // createTask emits a 'created' event, so emit 109 more heartbeats for 110 total relevant events.
    for (let i = 0; i < 109; i++) {
      addEvent(task.id, "heartbeat", { note: `note ${i}` });
    }

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.role_history).toHaveLength(100);
    expect(ctx.older_role_history_omitted).toBe(10);
  });

  it("caps role history note at 500 characters", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    addEvent(task.id, "blocked", { reason: "r".repeat(1000) });

    const ctx = buildTaskContext(task.id, "ctx");
    const blocked = ctx.role_history.find((e) => e.event === "blocked");
    expect(blocked?.note?.endsWith("\n[truncated]")).toBe(true);
    expect(blocked!.note!.length).toBe(500 + "\n[truncated]".length);
  });

  it("includes comments in chronological order capped at 50", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    for (let i = 0; i < 55; i++) {
      addComment({ task_id: task.id, text: `comment ${i}` });
    }

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.comments).toHaveLength(50);
    expect(ctx.older_comments_omitted).toBe(5);
    expect(ctx.comments[0].text).toBe("comment 0");
    expect(ctx.comments[49].text).toBe("comment 49");
  });

  it("caps comment text at 2000 characters", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    addComment({ task_id: task.id, text: "c".repeat(3000) });

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.comments[0].text.endsWith("\n[truncated]")).toBe(true);
  });

  it("defaults comment author to user when author is NULL", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });

    // Simulate legacy comment with NULL author
    const db = getDb();
    db.run("INSERT INTO comments (task_id, text) VALUES (?, ?)", [task.id, "legacy"]);

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.comments[0].author).toBe("user");
  });

  it("uses comments.author column when present", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    addComment({ task_id: task.id, text: "hello", author: "alice" });

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.comments[0].author).toBe("alice");
  });

  it("returns empty attachments when task_attachments table is missing", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    const db = getDb();
    db.exec("DROP TABLE task_attachments");

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.attachments).toEqual([]);
  });

  it("resolves relative attachment paths to absolute", () => {
    const slug = "attach-ctx";
    cleanupAttachments([slug]);
    const board = createBoard(slug, `/tmp/${slug}`);
    const task = createTask({ board_id: board.id, title: "Task" });
    const db = getDb();
    db.run(
      "INSERT INTO task_attachments (task_id, filename, stored_path, size) VALUES (?, ?, ?, ?)",
      [task.id, "notes.txt", "notes.txt", 10]
    );

    const ctx = buildTaskContext(task.id, slug);
    expect(ctx.attachments).toHaveLength(1);
    expect(ctx.attachments[0].filename).toBe("notes.txt");
    expect(isAbsolute(ctx.attachments[0].absolute_path)).toBe(true);
    expect(basename(ctx.attachments[0].absolute_path)).toBe("notes.txt");
  });

  it("uses absolute stored paths as-is", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    const absolutePath = "/absolute/path/to/file.txt";
    const db = getDb();
    db.run(
      "INSERT INTO task_attachments (task_id, filename, stored_path, size) VALUES (?, ?, ?, ?)",
      [task.id, "file.txt", absolutePath, 10]
    );

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.attachments[0].absolute_path).toBe(absolutePath);
  });

  it("caps attachments at 20", () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Task" });
    const db = getDb();
    for (let i = 0; i < 25; i++) {
      db.run(
        "INSERT INTO task_attachments (task_id, filename, stored_path, size) VALUES (?, ?, ?, ?)",
        [task.id, `file${i}.txt`, `file${i}.txt`, 10]
      );
    }

    const ctx = buildTaskContext(task.id, "ctx");
    expect(ctx.attachments).toHaveLength(20);
  });
});

describe("context CLI", () => {
  let logs: string[] = [];
  let errors: string[] = [];
  let exited = false;
  let exitCode: number | undefined;
  let contextCommand: ReturnType<typeof createContextCommand>;
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
    contextCommand = createContextCommand();
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
    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Context builder is not enabled"))).toBe(true);
  });

  it("rejects invalid task IDs", async () => {
    captureOutput();
    try {
      await contextCommand.parseAsync(["abc"], { from: "user" });
    } catch {
      // expected exit
    } finally {
      restoreOutput();
    }
    expect(exited).toBe(true);
    expect(errors.some((e) => e.includes("Invalid task ID"))).toBe(true);
  });

  it("prints human-readable context with all sections", async () => {
    const board = createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: board.id, title: "Fix auth", body: "Auth is broken" });
    captureOutput();
    try {
      await contextCommand.parseAsync([String(task.id), "--board", "ctx"], { from: "user" });
    } finally {
      restoreOutput();
    }
    const output = logs.join("\n");
    expect(output).toContain(`# Task #${task.id}: Fix auth`);
    expect(output).toContain("## Body");
    expect(output).toContain("Auth is broken");
    expect(output).toContain("## Parent Results");
    expect(output).toContain("## Prior Attempts");
    expect(output).toContain("## Role History");
    expect(output).toContain("## Comments");
    expect(output).toContain("## Attachments");
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
    expect(Array.isArray(parsed.parents)).toBe(true);
    expect(Array.isArray(parsed.prior_attempts)).toBe(true);
    expect(Array.isArray(parsed.role_history)).toBe(true);
    expect(Array.isArray(parsed.comments)).toBe(true);
    expect(Array.isArray(parsed.attachments)).toBe(true);
  });

  it("resolves board via standard chain", async () => {
    createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: 1, title: "Task" });
    captureOutput();
    try {
      await contextCommand.parseAsync([String(task.id)], {
        from: "user",
      });
    } catch {
      // expected exit
    } finally {
      restoreOutput();
    }
    // Without --board, falls back to default, which has no task.
    expect(exited).toBe(true);
    expect(errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("uses KDI_BOARD env for board resolution", async () => {
    createBoard("ctx", "/tmp/ctx");
    const task = createTask({ board_id: 1, title: "Task" });
    process.env.KDI_BOARD = "ctx";
    captureOutput();
    try {
      await contextCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      restoreOutput();
      delete process.env.KDI_BOARD;
    }
    expect(exited).toBe(false);
    const output = logs.join("\n");
    expect(output).toContain("Task #");
  });

  it("errors for a missing task", async () => {
    createBoard("ctx", "/tmp/ctx");
    captureOutput();
    try {
      await contextCommand.parseAsync(["999", "--board", "ctx"], { from: "user" });
    } catch {
      // expected exit
    } finally {
      restoreOutput();
    }
    expect(exited).toBe(true);
    expect(errors.some((e) => e.includes("Task 999 not found"))).toBe(true);
  });
});
