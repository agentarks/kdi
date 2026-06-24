import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadNotifiers,
  getNotifier,
  ensureNotifiers,
  BUILTIN_LOG_NOTIFIER,
  sendNotification,
  runNotifierWatcher,
  getLastSeenEventId,
  setLastSeenEventId,
  type NotifierProfile,
} from "../src/notifiers";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask, completeTask } from "../src/models/task";
import { subscribe, listSubscriptions, unsubscribe } from "../src/models/notifySub";
import { cleanupDb, restoreEnv } from "./cleanupDb";

const ORIGINAL_KDI_DB = process.env.KDI_DB;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kdi-notifiers-"));
}

describe("notifier registry", () => {
  let home: string;
  let notifiersPath: string;

  beforeEach(() => {
    home = tmpDir();
    notifiersPath = join(home, "notifiers.yaml");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("ensureNotifiers writes a default file when missing", () => {
    ensureNotifiers(notifiersPath);
    expect(existsSync(notifiersPath)).toBe(true);
    const profiles = loadNotifiers(notifiersPath);
    const names = profiles.map((p) => p.name);
    expect(names).toContain("log");
    expect(names).toContain("telegram");
    expect(names).toContain("slack");
    expect(names).toContain("discord");
    expect(names).toContain("webhook");
  });

  it("loadNotifiers always includes the built-in log profile", () => {
    const profiles = loadNotifiers(notifiersPath);
    const log = profiles.find((p) => p.name === "log");
    expect(log).toBeDefined();
    expect(log!.transport).toBe("log");
  });

  it("getNotifier returns a built-in log profile", () => {
    const profile = getNotifier("log", notifiersPath);
    expect(profile).toEqual(BUILTIN_LOG_NOTIFIER);
  });

  it("getNotifier throws when profile is missing", () => {
    expect(() => getNotifier("missing", notifiersPath)).toThrow("Notifier profile 'missing' not found.");
  });

  it("loadNotifiers parses object-style notifiers.yaml", () => {
    writeFileSync(
      notifiersPath,
      `notifiers:\n  telegram:\n    transport: telegram\n    config:\n      bot_token: "\${TEST_TG_TOKEN}"\n  my-webhook:\n    transport: webhook\n    config:\n      url: https://example.com/hook\n      secret: "\${TEST_SECRET}"\n`,
      "utf-8"
    );
    process.env.TEST_TG_TOKEN = "tg-secret";
    process.env.TEST_SECRET = "shh";
    const profiles = loadNotifiers(notifiersPath);
    const names = profiles.map((p) => p.name);
    expect(names).toContain("log");
    expect(names).toContain("telegram");
    expect(names).toContain("my-webhook");

    const tg = profiles.find((p) => p.name === "telegram")!;
    expect(tg.transport).toBe("telegram");
    expect(tg.config.bot_token).toBe("tg-secret");

    const hook = profiles.find((p) => p.name === "my-webhook")!;
    expect(hook.config.url).toBe("https://example.com/hook");
    expect(hook.config.secret).toBe("shh");

    delete process.env.TEST_TG_TOKEN;
    delete process.env.TEST_SECRET;
  });

  it("loadNotifiers parses array-style notifiers.yaml", () => {
    writeFileSync(
      notifiersPath,
      `- name: slack\n  transport: slack\n  config:\n    webhook_url: https://hooks.slack.com/test\n`,
      "utf-8"
    );
    const profiles = loadNotifiers(notifiersPath);
    const slack = profiles.find((p) => p.name === "slack")!;
    expect(slack.transport).toBe("slack");
    expect(slack.config.webhook_url).toBe("https://hooks.slack.com/test");
  });

  it("loadNotifiers rejects unknown transports", () => {
    writeFileSync(
      notifiersPath,
      `notifiers:\n  bad:\n    transport: unknown\n    config: {}\n`,
      "utf-8"
    );
    expect(() => loadNotifiers(notifiersPath)).toThrow(/unknown transport/i);
  });

  it("getNotifier validates required config keys for telegram", () => {
    writeFileSync(
      notifiersPath,
      `notifiers:\n  telegram:\n    transport: telegram\n    config: {}\n`,
      "utf-8"
    );
    expect(() => getNotifier("telegram", notifiersPath)).toThrow("missing required config key 'bot_token'");
  });

  it("getNotifier validates required config keys for webhook", () => {
    writeFileSync(
      notifiersPath,
      `notifiers:\n  hook:\n    transport: webhook\n    config: {}\n`,
      "utf-8"
    );
    expect(() => getNotifier("hook", notifiersPath)).toThrow("missing required config key 'url'");
  });
});

describe("notifier transport handlers", () => {
  let originalFetch: typeof fetch;
  let fetchCalls: { url: string; init: RequestInit }[];
  let stderrWrites: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    fetchCalls = [];
    stderrWrites = [];
    originalFetch = globalThis.fetch;
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: any[]) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return originalStderrWrite(chunk, ...args);
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
  });

  it("sendNotification log writes JSON to stderr", async () => {
    const profile: NotifierProfile = { name: "log", transport: "log", config: {} };
    const payload = {
      boardSlug: "test-board",
      taskId: 42,
      title: "Task title",
      eventKind: "completed",
      eventPayload: { tests: 12 },
      text: "hello",
    };
    await sendNotification(profile, { chat_id: "-1001", thread_id: null, user_id: null }, payload);
    expect(stderrWrites.length).toBeGreaterThan(0);
    const logged = JSON.parse(stderrWrites[0]);
    expect(logged.transport).toBe("log");
    expect(logged.taskId).toBe(42);
    expect(logged.text).toBe("hello");
  });

  it("sendNotification telegram calls the Telegram API", async () => {
    const profile: NotifierProfile = { name: "telegram", transport: "telegram", config: { bot_token: "bot123" } };
    const payload = {
      boardSlug: "b",
      taskId: 1,
      title: "t",
      eventKind: "completed",
      eventPayload: null,
      text: "msg",
    };
    await sendNotification(profile, { chat_id: "-1001", thread_id: "topic/1", user_id: "@me" }, payload);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("https://api.telegram.org/botbot123/sendMessage");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.chat_id).toBe("-1001");
    expect(body.message_thread_id).toBe("topic/1");
    expect(body.text).toBe("msg");
  });

  it("sendNotification slack posts to webhook_url", async () => {
    const profile: NotifierProfile = { name: "slack", transport: "slack", config: { webhook_url: "https://hooks.slack.com/x" } };
    const payload = {
      boardSlug: "b",
      taskId: 2,
      title: "t",
      eventKind: "blocked",
      eventPayload: null,
      text: "slack msg",
    };
    await sendNotification(profile, { chat_id: "#channel", thread_id: null, user_id: null }, payload);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("https://hooks.slack.com/x");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.channel).toBe("#channel");
    expect(body.text).toBe("slack msg");
  });

  it("sendNotification discord posts content to webhook", async () => {
    const profile: NotifierProfile = { name: "discord", transport: "discord", config: { webhook_url: "https://discord.com/api/webhooks/x" } };
    const payload = {
      boardSlug: "b",
      taskId: 3,
      title: "t",
      eventKind: "completed",
      eventPayload: null,
      text: "discord msg",
    };
    await sendNotification(profile, { chat_id: "123", thread_id: null, user_id: null }, payload);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("https://discord.com/api/webhooks/x");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.content).toBe("discord msg");
  });

  it("sendNotification webhook posts JSON payload", async () => {
    const profile: NotifierProfile = { name: "hook", transport: "webhook", config: { url: "https://example.com/hook" } };
    const payload = {
      boardSlug: "b",
      taskId: 4,
      title: "t",
      eventKind: "completed",
      eventPayload: { ok: true },
      text: "webhook msg",
    };
    await sendNotification(profile, { chat_id: "cid", thread_id: "th", user_id: "@u" }, payload);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("https://example.com/hook");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.chat_id).toBe("cid");
    expect(body.thread_id).toBe("th");
    expect(body.user_id).toBe("@u");
    expect(body.text).toBe("webhook msg");
  });

  it("sendNotification swallows fetch errors and does not throw", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
    const profile: NotifierProfile = { name: "telegram", transport: "telegram", config: { bot_token: "bot123" } };
    await expect(
      sendNotification(profile, { chat_id: "x", thread_id: null, user_id: null }, {
        boardSlug: "b", taskId: 5, title: "t", eventKind: "completed", eventPayload: null, text: "x",
      })
    ).resolves.toBeUndefined();
  });
});

describe("notifier watcher", () => {
  let testDbPath: string;
  let cursorsDir: string;
  let notifiersPath: string;
  let stderrWrites: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `kdi-notify-watcher-${Date.now()}.db`);
    cursorsDir = join(tmpdir(), `kdi-cursors-${Date.now()}`);
    notifiersPath = join(tmpdir(), `kdi-notify-${Date.now()}.yaml`);
    process.env.KDI_DB = testDbPath;
    process.env.KDI_NOTIFIER_CURSORS_PATH = cursorsDir;
    process.env.KDI_NOTIFIERS_PATH = notifiersPath;
    cleanupDb(testDbPath);
    initDb(testDbPath);

    stderrWrites = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: any[]) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return originalStderrWrite(chunk, ...args);
    }) as any;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    restoreEnv("KDI_DB", ORIGINAL_KDI_DB);
    delete process.env.KDI_NOTIFIER_CURSORS_PATH;
    delete process.env.KDI_NOTIFIERS_PATH;
    closeDb();
    cleanupDb(testDbPath);
    rmSync(cursorsDir, { recursive: true, force: true });
    try { rmSync(notifiersPath); } catch {}
  });

  it("delivers a completed event to a log subscriber", async () => {
    const board = createBoard("notify-board", "/tmp/notify-board");
    const task = createTask({ board_id: board.id, title: "Subscribed task" });
    promoteTask(task.id);
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

    completeTask(task.id, { result: "done" });

    const lastSeen = getLastSeenEventId("notify-board");
    const newLastSeen = await runNotifierWatcher("notify-board", lastSeen);
    setLastSeenEventId("notify-board", newLastSeen);

    expect(newLastSeen).toBeGreaterThan(lastSeen);
    expect(stderrWrites.length).toBeGreaterThan(0);
    const completed = stderrWrites
      .map((line) => JSON.parse(line))
      .find((entry) => entry.eventKind === "completed");
    expect(completed).toBeDefined();
    expect(completed.taskId).toBe(task.id);
  });

  it("skips delivery when no active subscriptions exist", async () => {
    const board = createBoard("empty-board", "/tmp/empty-board");
    const task = createTask({ board_id: board.id, title: "Unsubscribed task" });
    promoteTask(task.id);
    completeTask(task.id, { result: "done" });

    const lastSeen = getLastSeenEventId("empty-board");
    const newLastSeen = await runNotifierWatcher("empty-board", lastSeen);
    setLastSeenEventId("empty-board", newLastSeen);

    expect(newLastSeen).toBe(lastSeen);
    expect(stderrWrites.length).toBe(0);
  });

  it("does not redeliver events already seen by cursor", async () => {
    const board = createBoard("cursor-board", "/tmp/cursor-board");
    const task = createTask({ board_id: board.id, title: "Cursor task" });
    promoteTask(task.id);
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

    completeTask(task.id, { result: "done" });

    const first = await runNotifierWatcher("cursor-board", 0);
    setLastSeenEventId("cursor-board", first);
    expect(stderrWrites.length).toBeGreaterThan(0);

    stderrWrites.length = 0;
    const second = await runNotifierWatcher("cursor-board", first);
    expect(second).toBe(first);
    expect(stderrWrites.length).toBe(0);
  });

  it("persists and reads cursor", () => {
    setLastSeenEventId("my-board", 42);
    expect(getLastSeenEventId("my-board")).toBe(42);
  });

  it("skips events for archived tasks", async () => {
    const board = createBoard("archived-board", "/tmp/archived-board");
    const task = createTask({ board_id: board.id, title: "Archived task" });
    promoteTask(task.id);
    subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });

    const db = (await import("../src/db")).getDb();
    db.run("UPDATE tasks SET status = 'archived', archived_at = unixepoch() WHERE id = ?", [task.id]);
    // inject an event manually for the archived task
    const { addEvent } = await import("../src/models/taskEvent");
    addEvent(task.id, "completed", { result: "done" });

    const lastSeen = getLastSeenEventId("archived-board");
    const newLastSeen = await runNotifierWatcher("archived-board", lastSeen);
    setLastSeenEventId("archived-board", newLastSeen);

    expect(newLastSeen).toBe(lastSeen);
    expect(stderrWrites.length).toBe(0);
  });
});
