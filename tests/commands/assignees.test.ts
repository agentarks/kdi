import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initDb } from "../../src/db";
import { createBoard, showBoard } from "../../src/models/board";
import { createTask, archiveTask, getAssigneeCounts } from "../../src/models/task";
import { cleanupDb } from "../cleanupDb";
import { clearOverrides } from "../../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const TEST_DB = "/tmp/kdi-assignees-test.db";

let profilesDir: string;
let profilesPath: string;

function writeProfiles(names: string[]) {
  const entries = names.map((name) => `- name: ${name}\n  command: echo ${name}`);
  writeFileSync(profilesPath, entries.join("\n"), "utf-8");
}

function runKdi(args: string, env: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      KDI_DB: TEST_DB,
      KDI_PROFILES_PATH: profilesPath,
      FF_ASSIGNEES_LISTING: "true",
      ...env,
    },
  }).trim();
}

describe("assignees model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("returns empty counts for a board with no assigned tasks", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    expect(getAssigneeCounts(board.id)).toEqual({});
  });

  it("counts non-archived tasks per assignee and excludes null assignees", () => {
    const board = createBoard("myproj", "/tmp/myproj");
    createTask({ board_id: board.id, title: "t1", assignee: "alpha" });
    createTask({ board_id: board.id, title: "t2", assignee: "alpha" });
    createTask({ board_id: board.id, title: "t3", assignee: "beta" });
    createTask({ board_id: board.id, title: "unassigned" });
    const archived = createTask({ board_id: board.id, title: "archived", assignee: "alpha" });
    archiveTask(archived.id);

    expect(getAssigneeCounts(board.id)).toEqual({ alpha: 2, beta: 1 });
  });

  it("only counts tasks for the requested board", () => {
    const a = createBoard("a", "/tmp/a");
    const b = createBoard("b", "/tmp/b");
    createTask({ board_id: a.id, title: "t1", assignee: "alpha" });
    createTask({ board_id: b.id, title: "t2", assignee: "alpha" });

    expect(getAssigneeCounts(a.id)).toEqual({ alpha: 1 });
  });
});

describe("assignees CLI", () => {
  beforeEach(() => {
    profilesDir = mkdtempSync(join(tmpdir(), "kdi-assignees-profiles-"));
    profilesPath = resolve(profilesDir, "profiles.yaml");
    writeProfiles(["alpha", "beta"]);
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
    rmSync(profilesDir, { recursive: true, force: true });
  });

  it("rejects assignees when flag is disabled", () => {
    expect(() =>
      runKdi("assignees --board myproj", { FF_ASSIGNEES_LISTING: "false" })
    ).toThrow(/Assignees listing feature is not enabled/);
  });

  it("lists known profiles with zero counts on an empty board", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    const output = runKdi("assignees --board myproj");
    expect(output).toContain("Board: myproj");
    expect(output).toContain("alpha: 0");
    expect(output).toContain("beta: 0");
  });

  it("shows per-profile task counts and includes board-only assignees", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "t1" --board myproj --assignee alpha');
    runKdi('create "t2" --board myproj --assignee alpha');
    runKdi('create "t3" --board myproj --assignee gamma');
    const output = runKdi("assignees --board myproj");
    expect(output).toContain("alpha: 2");
    expect(output).toContain("beta: 0");
    expect(output).toContain("gamma: 1");
  });

  it("excludes archived tasks from counts", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "kept" --board myproj --assignee alpha');
    const board = showBoard("myproj", false);
    expect(board).toBeDefined();
    const toArchive = createTask({ board_id: board!.id, title: "old", assignee: "alpha" });
    archiveTask(toArchive.id);

    const output = runKdi("assignees --board myproj");
    expect(output).toContain("alpha: 1");
  });

  it("outputs JSON", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "t1" --board myproj --assignee alpha');
    const output = runKdi("assignees --board myproj --json");
    const parsed = JSON.parse(output);
    expect(parsed.board).toBe("myproj");
    expect(parsed.assignees).toBeInstanceOf(Array);
    const alpha = parsed.assignees.find((row: { profile: string; count: number }) => row.profile === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha.count).toBe(1);
  });

  it("resolves board via standard chain", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi('create "t1" --board myproj --assignee alpha');
    const output = runKdi("assignees", { KDI_BOARD: "myproj" });
    expect(output).toContain("Board: myproj");
    expect(output).toContain("alpha: 1");
  });

  it("errors for a missing board", () => {
    expect(() => runKdi("assignees --board missing")).toThrow(/not found or is archived/);
  });

  it("errors for an archived board", () => {
    runKdi("boards create myproj --workdir /tmp/myproj");
    runKdi("boards archive myproj");
    expect(() => runKdi("assignees --board myproj")).toThrow(/not found or is archived/);
  });
});
