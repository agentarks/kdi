import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { initDb, getDb, closeDb } from "../src/db";
import { createBoard, archiveBoard } from "../src/models/board";
import {
  createTask,
  promoteTask,
  blockTask,
  unblockTask,
  archiveTask,
} from "../src/models/task";
import { createRun, finishRun } from "../src/models/taskRun";
import { runDiagnostics } from "../src/models/diagnostic";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, FF_DIAGNOSTICS } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const TEST_DB = "/tmp/kdi-diagnostics-test.db";

function runKdi(args: string, env: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: { ...process.env, KDI_DB: TEST_DB, FF_DIAGNOSTICS: "true", ...env },
  }).trim();
}

function setTaskCreatedAt(taskId: number, createdAt: number): void {
  const db = getDb();
  db.run("UPDATE tasks SET created_at = ? WHERE id = ?", [createdAt, taskId]);
}

describe("diagnostics model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("returns no findings for a healthy board", () => {
    createBoard("myproj", "/tmp/myproj");
    createTask({ board_id: 1, title: "todo task" });
    const findings = runDiagnostics("myproj");
    expect(findings).toEqual([]);
  });

  it("detects stranded_in_ready", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "old ready" });
    promoteTask(task.id);
    setTaskCreatedAt(task.id, Math.floor(Date.now() / 1000) - 25 * 60 * 60);

    const findings = runDiagnostics("myproj");
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("stranded_in_ready");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].task_id).toBe(task.id);
    expect(findings[0].actions).toContain("reassign");
  });

  it("detects stuck_in_blocked", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "old blocked" });
    blockTask(task.id, "stuck");
    setTaskCreatedAt(task.id, Math.floor(Date.now() / 1000) - 25 * 60 * 60);

    const findings = runDiagnostics("myproj");
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("stuck_in_blocked");
    expect(findings[0].actions).toContain("unblock");
  });

  it("detects repeated_failures", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "failing" });
    const db = getDb();
    db.run("UPDATE tasks SET consecutive_failures = 5 WHERE id = ?", [task.id]);

    const findings = runDiagnostics("myproj");
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("repeated_failures");
    expect(findings[0].severity).toBe("error");
  });

  it("detects repeated_crashes", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "crashing" });
    for (let i = 0; i < 3; i++) {
      const run = createRun({ task_id: task.id, status: "running", started_at: Math.floor(Date.now() / 1000) });
      finishRun(run.id, "crashed");
    }

    const findings = runDiagnostics("myproj");
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("repeated_crashes");
    expect(findings[0].severity).toBe("error");
  });

  it("detects block_unblock_cycling", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "cycling" });
    for (let i = 0; i < 3; i++) {
      blockTask(task.id, `block ${i}`);
      unblockTask(task.id);
    }

    const findings = runDiagnostics("myproj");
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("block_unblock_cycling");
  });

  it("detects hallucinated_cards for missing same-board reference", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "refs missing" });
    const db = getDb();
    db.run("UPDATE tasks SET body = ? WHERE id = ?", ["see task #99999", task.id]);

    const findings = runDiagnostics("myproj");
    expect(findings.some((f) => f.rule === "hallucinated_cards" && f.task_id === task.id)).toBe(true);
  });

  it("detects hallucinated_cards for archived same-board reference", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const ref = createTask({ board_id: board.id, title: "ref" });
    archiveTask(ref.id);
    const task = createTask({ board_id: board.id, title: "refs archived" });
    const db = getDb();
    db.run("UPDATE tasks SET body = ? WHERE id = ?", [`see task #${ref.id}`, task.id]);

    const findings = runDiagnostics("myproj");
    expect(findings.some((f) => f.rule === "hallucinated_cards" && f.task_id === task.id)).toBe(true);
  });

  it("detects prose_phantom_refs for cross-board reference", () => {
    const boardA = createBoard("boardA", "/tmp/boardA");
    const boardB = createBoard("boardB", "/tmp/boardB");
    const ref = createTask({ board_id: boardB.id, title: "other board task" });
    const task = createTask({ board_id: boardA.id, title: "refs other board" });
    const db = getDb();
    db.run("UPDATE tasks SET body = ? WHERE id = ?", [`see task #${ref.id}`, task.id]);

    const findings = runDiagnostics("boardA");
    expect(findings.some((f) => f.rule === "prose_phantom_refs" && f.task_id === task.id)).toBe(true);
  });

  it("does not flag valid same-board references", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const ref = createTask({ board_id: board.id, title: "ref" });
    const task = createTask({ board_id: board.id, title: "refs valid" });
    const db = getDb();
    db.run("UPDATE tasks SET body = ? WHERE id = ?", [`see task #${ref.id}`, task.id]);

    const findings = runDiagnostics("myproj");
    expect(findings.some((f) => f.rule === "hallucinated_cards" || f.rule === "prose_phantom_refs")).toBe(false);
  });

  it("detects triage_aux_unavailable", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const task = createTask({ board_id: board.id, title: "triage", triage: true });
    setTaskCreatedAt(task.id, Math.floor(Date.now() / 1000) - 2 * 60 * 60);

    const findings = runDiagnostics("myproj");
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("triage_aux_unavailable");
  });

  it("filters findings by minimum severity", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const ready = createTask({ board_id: board.id, title: "old ready" });
    promoteTask(ready.id);
    setTaskCreatedAt(ready.id, Math.floor(Date.now() / 1000) - 25 * 60 * 60);

    const failing = createTask({ board_id: board.id, title: "failing" });
    const db = getDb();
    db.run("UPDATE tasks SET consecutive_failures = 5 WHERE id = ?", [failing.id]);

    const findings = runDiagnostics("myproj", { severity: "error" });
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("repeated_failures");
  });

  it("restricts diagnostics to a single task", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const oldReady = createTask({ board_id: board.id, title: "old ready" });
    promoteTask(oldReady.id);
    setTaskCreatedAt(oldReady.id, Math.floor(Date.now() / 1000) - 25 * 60 * 60);

    const oldBlocked = createTask({ board_id: board.id, title: "old blocked" });
    blockTask(oldBlocked.id, "stuck");
    setTaskCreatedAt(oldBlocked.id, Math.floor(Date.now() / 1000) - 25 * 60 * 60);

    const findings = runDiagnostics("myproj", { taskId: oldReady.id });
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("stranded_in_ready");
  });

  it("throws when board is archived", () => {
    createBoard("myproj", "/tmp/myproj");
    archiveBoard("myproj");

    expect(() => runDiagnostics("myproj")).toThrow(/not found or is archived/);
  });

  it("throws when task does not belong to board", () => {
    const boardA = createBoard("boardA", "/tmp/boardA");
    const boardB = createBoard("boardB", "/tmp/boardB");
    const task = createTask({ board_id: boardB.id, title: "other task" });

    expect(() => runDiagnostics("boardA", { taskId: task.id })).toThrow(/not found on board/);
  });
});

describe("diagnostics CLI", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("rejects diagnostics when flag is disabled", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    expect(() => runKdi("diagnostics --board myproj", { FF_DIAGNOSTICS: "false" })).toThrow(
      /Diagnostics feature is not enabled/
    );
  });

  it("prints no findings message", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "todo task" --board myproj');
    const output = runKdi("diagnostics --board myproj");
    expect(output).toContain("No diagnostic findings.");
  });

  it("prints human-readable findings", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "old ready" --board myproj --initial-status ready');
    const db = getDb();
    db.run("UPDATE tasks SET created_at = ? WHERE title = ?", [
      Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      "old ready",
    ]);

    const output = runKdi("diagnostics --board myproj");
    expect(output).toContain("Board: myproj");
    expect(output).toContain("stranded_in_ready");
    expect(output).toContain("[WARNING]");
  });

  it("outputs JSON findings", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "old ready" --board myproj --initial-status ready');
    const db = getDb();
    db.run("UPDATE tasks SET created_at = ? WHERE title = ?", [
      Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      "old ready",
    ]);

    const output = runKdi("diagnostics --board myproj --json");
    const findings = JSON.parse(output);
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("stranded_in_ready");
    expect(findings[0].severity).toBe("warning");
  });

  it("filters by severity", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "old ready" --board myproj --initial-status ready');
    runKdi('create "failing" --board myproj');
    const db = getDb();
    db.run("UPDATE tasks SET created_at = ? WHERE title = ?", [
      Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      "old ready",
    ]);
    db.run("UPDATE tasks SET consecutive_failures = 5 WHERE title = ?", ["failing"]);

    const output = runKdi("diagnostics --board myproj --severity error --json");
    const findings = JSON.parse(output);
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("repeated_failures");
  });

  it("restricts to a single task", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "old ready" --board myproj --initial-status ready');
    runKdi('create "old blocked" --board myproj');
    runKdi("block 2 --reason stuck");
    const db = getDb();
    db.run("UPDATE tasks SET created_at = ? WHERE title IN (?, ?)", [
      Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      "old ready",
      "old blocked",
    ]);

    const output = runKdi("diagnostics --board myproj --task 1 --json");
    const findings = JSON.parse(output);
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("stranded_in_ready");
  });

  it("errors for invalid severity", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    expect(() => runKdi("diagnostics --board myproj --severity fatal")).toThrow(
      /Invalid severity/
    );
  });

  it("errors for invalid task id", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    expect(() => runKdi("diagnostics --board myproj --task abc")).toThrow(/Invalid task id/);
  });

  it("resolves board via standard chain", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    const output = runKdi("diagnostics", { KDI_BOARD: "myproj" });
    expect(output).toContain("No diagnostic findings.");
  });
});
