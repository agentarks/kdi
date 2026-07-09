import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  taskDetailJson,
  taskLogJson,
  taskDependenciesJson,
  taskHandoffJson,
  createBoardJson,
  createTaskJson,
  BridgeError,
  detailFlags,
} from "./bridge";
import { addEvent } from "~/models/taskEvent";
import { completeTask } from "~/models/task";
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";

const FF_KEYS = ["FF_SVELTEKIT_FRONTEND", "FF_WORKER_LOG_CAPTURE", "FF_CONTEXT_BUILDER"];

let tmpHome: string;
const tmpDirs: string[] = [];
const envSnapshot: Record<string, string | undefined> = {};

function isolate(): void {
  tmpHome = `/tmp/kdi-ui005-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  process.env.FF_WORKER_LOG_CAPTURE = "true";
  process.env.FF_CONTEXT_BUILDER = "true";
}

function cleanup(): void {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
}

beforeEach(() => {
  for (const key of FF_KEYS) envSnapshot[key] = process.env[key];
  isolate();
  clearOverrides();
});

afterEach(() => {
  for (const key of FF_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearOverrides();
  closeDb();
  cleanup();
});

afterAll(() => cleanup());

async function freshBoard(slug = "detail-smoke"): Promise<string> {
  await createBoardJson({ slug, workdir: tmpHome });
  return slug;
}

async function expectBridgeError(p: Promise<unknown>, code: string, status: number): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(BridgeError);
    const be = err as BridgeError;
    expect(be.code).toBe(code);
    expect(be.status).toBe(status);
  }
  expect(threw).toBe(true);
}

describe("KDI-UI-005 task detail bridge", () => {
  it("returns the full TaskDetail snapshot", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Detail task", body: "Body text" });

    const detail = await taskDetailJson(slug, task.id);
    expect(detail.task.id).toBe(task.id);
    expect(detail.task.title).toBe("Detail task");
    expect(detail.task.body).toBe("Body text");
    expect(detail.task.status).toBe("todo");
    expect(detail.runs).toEqual([]);
    expect(detail.comments).toEqual([]);
    expect(detail.attachments).toEqual([]);
    expect(detail.context).not.toBeNull();
    expect(detail.log.present).toBe(false);
    expect(detail.handoff).toBeNull();
    expect(detail.parents).toEqual([]);
    expect(detail.children).toEqual([]);
  });

  it("404 when task is missing or not on board", async () => {
    const slug = await freshBoard();
    await expectBridgeError(taskDetailJson(slug, 9999), "task_not_found", 404);
  });

  it("reads worker log from disk", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Log task" });
    const logPath = join(tmpHome, ".local", "share", "kdi", "logs", slug, `${task.id}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "log line one\nlog line two\n");

    const full = await taskLogJson(slug, task.id, new URLSearchParams());
    expect(full.present).toBe(true);
    expect(full.content).toBe("log line one\nlog line two\n");

    const tail = await taskLogJson(slug, task.id, new URLSearchParams({ tail: "10" }));
    expect(tail.present).toBe(true);
    expect(tail.content).toBe(" line two\n");
  });

  it("tails a log from a UTF-8 boundary without a partial leading character", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Utf8 log task" });
    const logPath = join(tmpHome, ".local", "share", "kdi", "logs", slug, `${task.id}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    // "aa" + "é" (UTF-8: C3 A9) + "bb" = 6 bytes total.
    writeFileSync(logPath, "aaébb");

    const tail3 = await taskLogJson(slug, task.id, new URLSearchParams({ tail: "3" }));
    expect(tail3.present).toBe(true);
    // Tail starts at byte A9 (continuation of é), so skip to the next boundary and return "bb".
    expect(tail3.content).toBe("bb");

    const tail4 = await taskLogJson(slug, task.id, new URLSearchParams({ tail: "4" }));
    expect(tail4.present).toBe(true);
    // Tail starts at byte C3 (start of é), so return "ébb".
    expect(tail4.content).toBe("ébb");
  });

  it("truncates large logs to the first 500KB when not tailing", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Huge log task" });
    const logPath = join(tmpHome, ".local", "share", "kdi", "logs", slug, `${task.id}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    const size = 11 * 1024 * 1024;
    writeFileSync(logPath, Buffer.alloc(size, "x"));

    const full = await taskLogJson(slug, task.id, new URLSearchParams());
    expect(full.present).toBe(true);
    expect(full.truncated).toBe(true);
    expect(full.size).toBe(size);
    expect(full.content).toBe("x".repeat(500 * 1024));
  });

  it("returns dependencies for parent and child tasks", async () => {
    const slug = await freshBoard();
    const { task: parent } = await createTaskJson(slug, { title: "Parent task" });
    await completeTask(parent.id, { result: "done" });
    const { task: child } = await createTaskJson(slug, { title: "Child task" }, [parent.id]);

    const deps = await taskDependenciesJson(slug, child.id);
    expect(deps.parents).toHaveLength(1);
    expect(deps.parents[0].id).toBe(parent.id);
    expect(deps.children).toEqual([]);

    const parentDeps = await taskDependenciesJson(slug, parent.id);
    expect(parentDeps.children).toHaveLength(1);
    expect(parentDeps.children[0].id).toBe(child.id);
  });

  it("returns handoff from the latest worktree_handed_off event", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Handoff task" });
    addEvent(task.id, "worktree_handed_off", { branch: "wt/user/1", worktree_path: "/tmp/wt" });

    const handoff = await taskHandoffJson(slug, task.id);
    expect(handoff.present).toBe(true);
    expect(handoff.branch).toBe("wt/user/1");
    expect(handoff.worktreePath).toBe("/tmp/wt");
  });

  it("exposes detail flags for the UI", () => {
    const flags = detailFlags();
    expect(flags.sveltekitFrontend).toBe(true);
    expect(typeof flags.contextBuilder).toBe("boolean");
    expect(typeof flags.showRunFiltering).toBe("boolean");
  });
});
