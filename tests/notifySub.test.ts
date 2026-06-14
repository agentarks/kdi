import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask } from "../src/models/task";
import { getEvents } from "../src/models/taskEvent";
import { subscribe, listSubscriptions, unsubscribe } from "../src/models/notifySub";
import { cleanupDb } from "./cleanupDb";
import { clearOverrides } from "../src/flags";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const TEST_DB = "/tmp/kdi-notify-sub-test.db";

function runKdi(args: string, env: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      KDI_DB: TEST_DB,
      FF_NOTIFY_SUBS: "true",
      ...env,
    },
  }).trim();
}

describe("notify subscription model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    clearOverrides();
  });

  it("subscribes to a task and emits a subscribed event", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    const sub = subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

    expect(sub.platform).toBe("telegram");
    expect(sub.chat_id).toBe("-1001");
    expect(sub.thread_id).toBeNull();
    expect(sub.notifier_profile).toBe("log");

    const events = getEvents(task.id);
    const ev = events.find((e) => e.kind === "subscribed");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload ?? "{}")).toEqual({ platform: "telegram", chat_id: "-1001", thread_id: null });
  });

  it("rejects duplicate no-thread subscription", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

    expect(() => subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" })).toThrow(
      "A subscription for this task + platform + chat already exists (no thread). Use --thread-id to add a thread-scoped subscription."
    );
  });

  it("allows a thread-scoped subscription separate from no-thread", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });
    const threadSub = subscribe(task.id, "telegram", "-1001", { notifierProfile: "log", threadId: "topic/1" });

    expect(threadSub.thread_id).toBe("topic/1");
    expect(listSubscriptions(task.id)).toHaveLength(2);
  });

  it("rejects duplicate thread-scoped subscription", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log", threadId: "topic/1" });

    expect(() => subscribe(task.id, "telegram", "-1001", { notifierProfile: "log", threadId: "topic/1" })).toThrow(
      "A subscription for this task + platform + chat + thread already exists."
    );
  });

  it("rejects unsupported platforms", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });

    expect(() => subscribe(task.id, "unknown", "x", { notifierProfile: "log" })).toThrow(
      "Unsupported platform. Valid platforms: telegram, slack, discord, webhook."
    );
  });

  it("rejects missing notifier profile", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });

    expect(() => subscribe(task.id, "telegram", "-1001", { notifierProfile: "nonexistent" })).toThrow(
      "Notifier profile 'nonexistent' not found."
    );
  });

  it("rejects subscription for missing task", () => {
    expect(() => subscribe(99999, "telegram", "-1001", { notifierProfile: "log" })).toThrow(
      "Task 99999 not found."
    );
  });

  it("lists subscriptions per task or per board", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task1 = createTask({ board_id: board.id, title: "t1" });
    const task2 = createTask({ board_id: board.id, title: "t2" });
    subscribe(task1.id, "telegram", "-1001", { notifierProfile: "log" });
    subscribe(task2.id, "slack", "#ch", { notifierProfile: "log" });

    expect(listSubscriptions(task1.id)).toHaveLength(1);
    expect(listSubscriptions(undefined, false, board.id)).toHaveLength(2);
  });

  it("listSubscriptions includes archived subs when requested", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });
    unsubscribe(task.id, "telegram", "-1001");

    expect(listSubscriptions(task.id)).toHaveLength(0);
    expect(listSubscriptions(task.id, true)).toHaveLength(1);
  });

  it("unsubscribe thread-scoped leaves no-thread intact", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log", threadId: "topic/1" });

    const count = unsubscribe(task.id, "telegram", "-1001", "topic/1");
    expect(count).toBe(1);
    expect(listSubscriptions(task.id)).toHaveLength(1);

    const events = getEvents(task.id);
    const ev = events.find((e) => e.kind === "unsubscribed");
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.payload ?? "{}").thread_id).toBe("topic/1");
  });

  it("unsubscribe without thread unsubs all matching subs", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log", threadId: "topic/1" });

    const count = unsubscribe(task.id, "telegram", "-1001");
    expect(count).toBe(2);
    expect(listSubscriptions(task.id)).toHaveLength(0);
  });

  it("unsubscribe throws when no active subscription matches", () => {
    const board = createBoard("nb", "/tmp/nb");
    const task = createTask({ board_id: board.id, title: "t" });

    expect(() => unsubscribe(task.id, "telegram", "-1001")).toThrow(
      "No active subscription found for the given parameters."
    );
  });
});

describe("notify CLI", () => {
  let notifierHome: string;

  beforeEach(() => {
    notifierHome = mkdtempSync(join(tmpdir(), "kdi-notify-cli-"));
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
    rmSync(notifierHome, { recursive: true, force: true });
    clearOverrides();
  });

  function runNotify(args: string, env: Record<string, string> = {}): string {
    return runKdi(args, {
      KDI_NOTIFIERS_PATH: join(notifierHome, "notifiers.yaml"),
      KDI_NOTIFIER_CURSORS_PATH: join(notifierHome, "cursors"),
      ...env,
    });
  }

  it("subscribe creates a subscription and emits an event", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);
    expect(taskId).toBeGreaterThan(0);

    const subOut = runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`);
    expect(subOut).toMatch(/subscribed/i);

    const listOut = runNotify(`notify-list ${taskId}`);
    expect(listOut).toContain(String(taskId));
    expect(listOut).toContain("telegram");
    expect(listOut).toContain("-1001");
  });

  it("rejects duplicate subscription", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`);

    expect(() =>
      runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`)
    ).toThrow(/A subscription for this task \+ platform \+ chat already exists/);
  });

  it("rejects invalid platform", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);

    expect(() => runNotify(`notify-subscribe ${taskId} --platform unknown --chat-id x --notifier-profile log`)).toThrow(
      /Unsupported platform/
    );
  });

  it("rejects missing notifier profile", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);

    expect(() =>
      runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile missing`)
    ).toThrow(/Notifier profile 'missing' not found/);
  });

  it("rejects subscribe for missing task", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    expect(() => runNotify("notify-subscribe 99999 --platform telegram --chat-id -1001 --notifier-profile log")).toThrow(
      /Task 99999 not found/
    );
  });

  it("list active and archived subscriptions", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`);

    const active = runNotify("notify-list --board nb");
    expect(active).toContain("-1001");

    runNotify(`notify-unsubscribe ${taskId} --platform telegram --chat-id -1001`);
    expect(runNotify("notify-list --board nb")).not.toContain("-1001");
    expect(runNotify("notify-list --board nb --archived")).toContain("-1001");
  });

  it("list --json emits a JSON array", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`);

    const jsonOut = runNotify("notify-list --board nb --json");
    const parsed = JSON.parse(jsonOut);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].chat_id).toBe("-1001");
  });

  it("unsubscribe thread-scoped leaves no-thread subscription", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --thread-id topic/1 --notifier-profile log`);

    const unsubOut = runNotify(`notify-unsubscribe ${taskId} --platform telegram --chat-id -1001 --thread-id topic/1`);
    expect(unsubOut).toMatch(/1/);

    const listOut = runNotify(`notify-list ${taskId}`);
    expect(listOut).toContain("-1001");
    expect(listOut).not.toContain("topic/1");
  });

  it("unsubscribe without thread removes all matching subs", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`);
    runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --thread-id topic/1 --notifier-profile log`);

    const unsubOut = runNotify(`notify-unsubscribe ${taskId} --platform telegram --chat-id -1001`);
    expect(unsubOut).toMatch(/2/);
    expect(runNotify(`notify-list ${taskId}`)).not.toContain("-1001");
  });

  it("unsubscribe errors when no active subscription matches", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);

    expect(() => runNotify(`notify-unsubscribe ${taskId} --platform telegram --chat-id -nonexistent`)).toThrow(
      /No active subscription found/
    );
  });

  it("all three commands are gated by FF_NOTIFY_SUBS", () => {
    runNotify("boards create nb --workdir /tmp/nb");
    const out = runNotify('create "t" --board nb');
    const taskId = Number(out.match(/Task (\d+)/)?.[1] ?? out.match(/^(\d+)$/)?.[1]);

    expect(() => runNotify(`notify-subscribe ${taskId} --platform telegram --chat-id -1001 --notifier-profile log`, { FF_NOTIFY_SUBS: "false" })).toThrow(
      /Notification subscriptions feature is not enabled/
    );
    expect(() => runNotify("notify-list --board nb", { FF_NOTIFY_SUBS: "false" })).toThrow(
      /Notification subscriptions feature is not enabled/
    );
    expect(() => runNotify(`notify-unsubscribe ${taskId} --platform telegram --chat-id -1001`, { FF_NOTIFY_SUBS: "false" })).toThrow(
      /Notification subscriptions feature is not enabled/
    );
  });
});
