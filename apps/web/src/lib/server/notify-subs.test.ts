// KDI-UI-010 notification subscriptions UI smoke. Exercises the bridge
// helpers the new SSR routes use (subscribeJson / unsubscribeJson /
// subscriptionsJson / notifySubsFlags) directly against an isolated temp
// HOME + KDI_DB, and asserts the observable contract matches the CLI model
// verbatim (error text, duplicate semantics, archived toggle, flag gate).
// No HTTP process: the +page.server.ts routes are thin adapters over these.
//
// ponytail: test the bridge functions, not SvelteKit RequestEvent plumbing.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  createBoardJson,
  createTaskJson,
  subscriptionsJson,
  subscribeJson,
  unsubscribeJson,
  notifySubsFlags,
  BridgeError,
} from "./bridge";
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";

let tmpHome: string;
const tmpDirs: string[] = [];

function isolate(notifySubs: boolean): void {
  tmpHome = `/tmp/kdi-ui010-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  process.env.FF_NOTIFY_SUBS = notifySubs ? "true" : "false";
}

function cleanup(): void {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
}

async function seedBoardAndTask(): Promise<{ slug: string; taskId: number }> {
  const slug = "smoke";
  await createBoardJson({ slug, workdir: tmpHome });
  const { task } = await createTaskJson(slug, { title: "Notify me" });
  return { slug, taskId: task.id };
}

function qs(pairs: Record<string, string>): URLSearchParams {
  return new URLSearchParams(pairs);
}

// bun:test's rejects.toSatisfy does not unwrap the rejection reliably; catch.
async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    if (!(e instanceof BridgeError) || e.code !== code) {
      throw new Error(`expected BridgeError code ${code}, got ${e instanceof BridgeError ? e.code : e}`);
    }
  }
  if (!threw) throw new Error(`expected promise to reject with ${code}, but it resolved`);
}

describe("KDI-UI-010 notification subscriptions bridge", () => {
  beforeEach(() => isolate(true));
  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanup();
  });

  it("subscribe + list round-trip (per-task and board-scoped) with camelCase keys", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    const { subscription } = await subscribeJson(slug, taskId, "telegram", "chat-1", {
      notifierProfile: "log",
    });
    expect(subscription.taskId).toBe(taskId);
    expect(subscription.platform).toBe("telegram");
    expect(subscription.notifierProfile).toBe("log");
    expect(subscription.unsubscribedAt).toBeNull();
    for (const k of Object.keys(subscription)) expect(k.includes("_")).toBe(false);

    const perTask = await subscriptionsJson(qs({ taskId: String(taskId) }));
    expect(perTask.subscriptions.length).toBe(1);
    expect(perTask.subscriptions[0].id).toBe(subscription.id);

    const boardWide = await subscriptionsJson(qs({ board: slug }));
    expect(boardWide.subscriptions.length).toBe(1);
    expect(boardWide.subscriptions[0].taskId).toBe(taskId);
  });

  it("empty notifier profile defaults to the platform name and is validated", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    // platform telegram -> default profile "telegram" -> missing bot_token.
    await expect(
      subscribeJson(slug, taskId, "telegram", "chat-1", { notifierProfile: undefined }),
    ).rejects.toThrow(/missing required config key 'bot_token'/);
  });

  it("rejects a missing notifier profile with the CLI message", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    await expect(
      subscribeJson(slug, taskId, "telegram", "chat-1", { notifierProfile: "nope" }),
    ).rejects.toThrow(/Notifier profile 'nope' not found/);
  });

  it("rejects an unsupported platform with the CLI message", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    await expect(
      subscribeJson(slug, taskId, "carrier-pigeon", "chat-1", { notifierProfile: "log" }),
    ).rejects.toThrow(/Unsupported platform\. Valid platforms: telegram, slack, discord, webhook/);
  });

  it("rejects duplicate no-thread and thread-scoped subscriptions", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    await subscribeJson(slug, taskId, "slack", "chat-2", { notifierProfile: "log" });
    await expect(
      subscribeJson(slug, taskId, "slack", "chat-2", { notifierProfile: "log" }),
    ).rejects.toThrow(/already exists \(no thread\)/);

    // Thread-scoped is distinct and coexists.
    await subscribeJson(slug, taskId, "slack", "chat-2", {
      notifierProfile: "log",
      threadId: "t1",
    });
    await expect(
      subscribeJson(slug, taskId, "slack", "chat-2", {
        notifierProfile: "log",
        threadId: "t1",
      }),
    ).rejects.toThrow(/already exists/);

    const list = await subscriptionsJson(qs({ taskId: String(taskId) }));
    expect(list.subscriptions.length).toBe(2);
  });

  it("thread-scoped unsubscribe leaves the no-thread subscription (AC-12)", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    await subscribeJson(slug, taskId, "discord", "chat-3", { notifierProfile: "log" });
    await subscribeJson(slug, taskId, "discord", "chat-3", {
      notifierProfile: "log",
      threadId: "t1",
    });

    const { unsubscribed } = await unsubscribeJson(slug, taskId, "discord", "chat-3", "t1");
    expect(unsubscribed).toBe(1);

    const active = await subscriptionsJson(qs({ taskId: String(taskId) }));
    expect(active.subscriptions.length).toBe(1);
    expect(active.subscriptions[0].threadId).toBeNull();

    // Thread sub is gone from active but visible with includeArchived.
    const archived = await subscriptionsJson(
      qs({ taskId: String(taskId), includeArchived: "true" }),
    );
    expect(archived.subscriptions.length).toBe(2);
    const threadSub = archived.subscriptions.find((s) => s.threadId === "t1");
    expect(threadSub?.unsubscribedAt).not.toBeNull();
  });

  it("no-thread unsubscribe removes all active subs for task/platform/chat (AC-13)", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    await subscribeJson(slug, taskId, "webhook", "chat-4", { notifierProfile: "log" });
    await subscribeJson(slug, taskId, "webhook", "chat-4", {
      notifierProfile: "log",
      threadId: "t1",
    });

    const { unsubscribed } = await unsubscribeJson(slug, taskId, "webhook", "chat-4");
    expect(unsubscribed).toBe(2);

    const active = await subscriptionsJson(qs({ taskId: String(taskId) }));
    expect(active.subscriptions.length).toBe(0);
  });

  it("unsubscribe on a non-existent active sub surfaces the CLI error", async () => {
    const { slug, taskId } = await seedBoardAndTask();
    await expect(unsubscribeJson(slug, taskId, "telegram", "ghost")).rejects.toThrow(
      /No active subscription found/,
    );
  });

  it("FF_NOTIFY_SUBS gate: flags reflect env and mutations are rejected when off", async () => {
    // Re-isolate with the flag off in this single test.
    isolate(false);
    expect(notifySubsFlags().notifySubs).toBe(false);

    const { slug, taskId } = await seedBoardAndTask();
    await expectCode(
      subscribeJson(slug, taskId, "telegram", "chat", { notifierProfile: "log" }),
      "feature_disabled",
    );
    await expectCode(unsubscribeJson(slug, taskId, "telegram", "chat"), "feature_disabled");

    // Read-only list still works (no mutation); the disabled gate is on writes.
    const list = await subscriptionsJson(qs({ taskId: String(taskId) }));
    expect(list.subscriptions.length).toBe(0);
  });

  it("assertTaskOnBoard: a task from another board is rejected (FR-18 consistency)", async () => {
    // Two boards, task on board A; targeting it via board B's slug must 404.
    await createBoardJson({ slug: "boardA", workdir: tmpHome });
    await createBoardJson({ slug: "boardB", workdir: tmpHome });
    const { task } = await createTaskJson("boardA", { title: "on A" });

    await expectCode(
      subscribeJson("boardB", task.id, "telegram", "c", { notifierProfile: "log" }),
      "task_not_found",
    );
    await expectCode(
      unsubscribeJson("boardB", task.id, "telegram", "c"),
      "task_not_found",
    );
    // Nothing was created.
    const list = await subscriptionsJson(qs({ taskId: String(task.id) }));
    expect(list.subscriptions.length).toBe(0);
  });

  it("FR-13: missing task surfaces the model message 'Task <id> not found.' verbatim", async () => {
    await createBoardJson({ slug: "solo", workdir: tmpHome });
    // Task 9999 does not exist; subscribeJson must let the model throw its
    // FR-13 message (not assertTaskOnBoard's board-naming variant).
    await expect(
      subscribeJson("solo", 9999, "telegram", "c", { notifierProfile: "log" }),
    ).rejects.toThrow(/^Task 9999 not found\.$/);
  });
});
