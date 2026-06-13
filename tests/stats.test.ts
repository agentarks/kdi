import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { initDb } from "../src/db";
import { createBoard, getBoardStats, archiveBoard } from "../src/models/board";
import { createTask, promoteTask, blockTask, archiveTask } from "../src/models/task";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides, FF_STATS } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const TEST_DB = "/tmp/kdi-stats-test.db";

function runKdi(args: string, env: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: { ...process.env, KDI_DB: TEST_DB, FF_STATS: "true", ...env },
  }).trim();
}

describe("stats model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("returns zero counts and null oldest ready age for an empty board", () => {
    createBoard("myproj", "/tmp/myproj");
    const stats = getBoardStats("myproj");
    expect(stats.board).toBe("myproj");
    expect(stats.status_counts).toEqual({
      triage: 0,
      todo: 0,
      scheduled: 0,
      ready: 0,
      running: 0,
      done: 0,
      blocked: 0,
      review: 0,
    });
    expect(stats.assignee_counts).toEqual({});
    expect(stats.oldest_ready_age_seconds).toBeNull();
  });

  it("counts tasks per status excluding archived tasks", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const todo = createTask({ board_id: board.id, title: "todo task" });
    const ready = createTask({ board_id: board.id, title: "ready task" });
    promoteTask(ready.id);
    const blocked = createTask({ board_id: board.id, title: "blocked task" });
    blockTask(blocked.id, "reason");
    const archived = createTask({ board_id: board.id, title: "archived task" });
    archiveTask(archived.id);

    const stats = getBoardStats("myproj");
    expect(stats.status_counts.todo).toBe(1);
    expect(stats.status_counts.ready).toBe(1);
    expect(stats.status_counts.blocked).toBe(1);
    expect(stats.status_counts.done).toBe(0);
    expect(stats.status_counts.triage).toBe(0);
  });

  it("counts ready and running tasks per assignee", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const ready1 = createTask({ board_id: board.id, title: "ready 1", assignee: "opencode" });
    const ready2 = createTask({ board_id: board.id, title: "ready 2", assignee: "opencode" });
    const ready3 = createTask({ board_id: board.id, title: "ready 3", assignee: "claude" });
    promoteTask(ready1.id);
    promoteTask(ready2.id);
    promoteTask(ready3.id);
    createTask({ board_id: board.id, title: "todo assigned", assignee: "opencode" });
    createTask({ board_id: board.id, title: "ready unassigned" });

    const stats = getBoardStats("myproj");
    expect(stats.assignee_counts).toEqual({
      opencode: 2,
      claude: 1,
    });
  });

  it("returns oldest ready task age in seconds", async () => {
    const board = createBoard("myproj", "/tmp/myproj");
    const ready = createTask({ board_id: board.id, title: "old ready" });
    promoteTask(ready.id);

    await new Promise((r) => setTimeout(r, 1100));

    const stats = getBoardStats("myproj");
    expect(stats.oldest_ready_age_seconds).toBeGreaterThanOrEqual(1);
  });

  it("throws when board is archived", () => {
    createBoard("myproj", "/tmp/myproj");
    createTask({ board_id: 1, title: "task" });
    archiveBoard("myproj");

    expect(() => getBoardStats("myproj")).toThrow(/not found or is archived/);
  });

  it("throws when board does not exist", () => {
    expect(() => getBoardStats("missing")).toThrow(/not found or is archived/);
  });
});

describe("stats CLI", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("rejects stats when flag is disabled", () => {
    expect(() => runKdi("stats", { FF_STATS: "false" })).toThrow(/Stats feature is not enabled/);
  });

  it("prints human-readable stats", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "ready task" --board myproj --assignee opencode --initial-status ready');
    runKdi('create "todo task" --board myproj');
    const output = runKdi("stats --board myproj");
    expect(output).toContain("Board: myproj");
    expect(output).toContain("ready: 1");
    expect(output).toContain("todo: 1");
    expect(output).toContain("opencode: 1");
  });

  it("outputs JSON stats", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "ready task" --board myproj --assignee opencode --initial-status ready');
    const output = runKdi("stats --board myproj --json");
    const stats = JSON.parse(output);
    expect(stats.board).toBe("myproj");
    expect(stats.status_counts.ready).toBe(1);
    expect(stats.assignee_counts.opencode).toBe(1);
    expect(stats.oldest_ready_age_seconds).toBeGreaterThanOrEqual(0);
  });

  it("resolves board via standard chain", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "ready task" --board myproj --assignee opencode --initial-status ready');
    const output = runKdi("stats", { KDI_BOARD: "myproj" });
    expect(output).toContain("Board: myproj");
    expect(output).toContain("ready: 1");
  });

  it("errors for an archived board", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi("boards archive myproj");
    expect(() => runKdi("stats --board myproj")).toThrow(/not found or is archived/);
  });
});
