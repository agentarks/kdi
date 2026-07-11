// KDI-UI-010 HTTP smoke — exercises the SvelteKit form actions the way a
// browser does, covering AC-16's cross-route flow: subscribe via the per-task
// UI -> subscription appears in the global list -> toggle "Include unsubscribed"
// -> unsubscribe from the global list -> active list empty, unsubscribed row
// visible only with the toggle on. Mirrors the KDI-UI-004 HTTP smoke pattern.

import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listSubscriptions } from "~/models/notifySub";
import { initDb } from "~/db";

const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", ".."); // repo root
const PORT = "5196";
const BASE_URL = `http://localhost:${PORT}`;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;

async function waitAlive(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/`);
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on :${PORT} within ${timeoutMs}ms`);
}

async function startServer(notifySubs: boolean): Promise<void> {
  if (proc) {
    try { proc.kill(); } catch { /* gone */ }
    proc = null;
  }
  tmpHome = `/tmp/kdi-ui010-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", PORT],
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: "true",
      VITE_FF_SVELTEKIT_FRONTEND: "true",
      FF_NOTIFY_SUBS: notifySubs ? "true" : "false",
      NODE_ENV: "development",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitAlive();
}

async function createBoardApi(slug: string): Promise<void> {
  const r = await fetch(`${BASE_URL}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, workdir: tmpHome }),
  });
  expect(r.status).toBe(201);
}

async function createTaskApi(slug: string, title: string): Promise<number> {
  const r = await fetch(`${BASE_URL}/api/boards/${slug}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const j = (await r.json()) as { task: { id: number } };
  return j.task.id;
}

function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function useDb(): void {
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  initDb();
}

afterAll(() => {
  if (proc) {
    try { proc.kill(); } catch { /* gone */ }
    proc = null;
  }
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-010 HTTP smoke (dev server, isolated HOME/KDI_DB)", () => {
  it("AC-16: subscribe via per-task UI -> global list -> toggle -> unsubscribe -> empty", async () => {
    await startServer(true);
    await createBoardApi("smoke");
    const taskId = await createTaskApi("smoke", "Notify me");

    // AC-05/AC-16: subscribe via the per-task form action (notifier_profile=log,
    // the always-available built-in, so getNotifier passes).
    const sub = await postForm(`/tasks/${taskId}/notifications?board=smoke&/subscribe`, {
      platform: "telegram",
      chat_id: "chat-1",
      notifier_profile: "log",
    });
    expect(sub.status).toBe(200);
    const subResult = (await sub.json()) as { type: string };
    expect(subResult.type === "success" || subResult.type === "redirect").toBe(true);

    // Cross-check against the CLI model on the same DB.
    useDb();
    const modelSubs = listSubscriptions(taskId);
    expect(modelSubs.length).toBe(1);
    expect(modelSubs[0].platform).toBe("telegram");
    expect(modelSubs[0].chat_id).toBe("chat-1");

    // AC-01/AC-16: subscription appears in the GLOBAL list for the board.
    const globalActive = await (await fetch(`${BASE_URL}/notifications?board=smoke`)).text();
    expect(globalActive).toContain("chat-1");
    expect(globalActive).toContain("telegram");

    // AC-04: subscription also appears in the per-task page with the task summary.
    const perTask = await (await fetch(`${BASE_URL}/tasks/${taskId}/notifications?board=smoke`)).text();
    expect(perTask).toContain("chat-1");
    expect(perTask).toContain("Notify me");

    // AC-02/AC-03: active list empty-state text is NOT shown while a sub exists.
    expect(globalActive).not.toContain("No active subscriptions");

    // AC-11/AC-16: unsubscribe from the GLOBAL list (uses the row's task/platform/chat).
    const unsub = await postForm(`/notifications?board=smoke&/unsubscribe`, {
      task_id: String(taskId),
      platform: "telegram",
      chat_id: "chat-1",
    });
    expect(unsub.status).toBe(200);
    const unsubResult = (await unsub.json()) as { type: string };
    expect(unsubResult.type === "success" || unsubResult.type === "redirect").toBe(true);

    // AC-16: active global list is now empty.
    const globalAfter = await (await fetch(`${BASE_URL}/notifications?board=smoke`)).text();
    expect(globalAfter).not.toContain("chat-1");
    expect(globalAfter).toContain("No active subscriptions");

    // AC-02/AC-16: toggle "Include unsubscribed" -> the row reappears, marked.
    const globalArchived = await (await fetch(`${BASE_URL}/notifications?board=smoke&archived=1`)).text();
    expect(globalArchived).toContain("chat-1");
    expect(globalArchived).toContain("unsubscribed");

    // Model parity: active=0, archived=1.
    expect(listSubscriptions(taskId, false).length).toBe(0);
    expect(listSubscriptions(taskId, true).length).toBe(1);
  }, 60000);

  it("AC-09/AC-12/AC-13: unsupported platform + thread-scoped unsubscribe semantics", async () => {
    await startServer(true);
    await createBoardApi("sem");
    const taskId = await createTaskApi("sem", "Semantics");

    // AC-09: unsupported platform rejected with CLI text via the form action.
    const bad = await postForm(`/tasks/${taskId}/notifications?board=sem&/subscribe`, {
      platform: "carrier-pigeon",
      chat_id: "c",
      notifier_profile: "log",
    });
    const badResult = (await bad.json()) as { type: string; status: number; data: string };
    expect(badResult.type).toBe("failure");
    expect(badResult.status).toBe(400);
    expect(badResult.data).toContain("Unsupported platform");

    // Subscribe a no-thread + a thread-scoped sub for the same platform/chat.
    await postForm(`/tasks/${taskId}/notifications?board=sem&/subscribe`, {
      platform: "slack", chat_id: "shared", notifier_profile: "log",
    });
    await postForm(`/tasks/${taskId}/notifications?board=sem&/subscribe`, {
      platform: "slack", chat_id: "shared", thread_id: "t1", notifier_profile: "log",
    });

    // AC-12: thread-scoped unsubscribe leaves the no-thread sub intact.
    const tUnsub = await postForm(`/tasks/${taskId}/notifications?board=sem&/unsubscribe`, {
      platform: "slack", chat_id: "shared", thread_id: "t1",
    });
    expect(tUnsub.status).toBe(200);
    useDb();
    const afterThread = listSubscriptions(taskId, true);
    expect(afterThread.length).toBe(2);
    const active = listSubscriptions(taskId, false);
    expect(active.length).toBe(1);
    expect(active[0].thread_id).toBeNull();

    // AC-13: no-thread unsubscribe removes ALL active subs for platform/chat
    // (the thread-scoped one is already unsubscribed, so changes=1 here).
    await postForm(`/tasks/${taskId}/notifications?board=sem&/unsubscribe`, {
      platform: "slack", chat_id: "shared",
    });
    expect(listSubscriptions(taskId, false).length).toBe(0);
    expect(listSubscriptions(taskId, true).length).toBe(2);
  }, 60000);

  it("AC-14: FF_NOTIFY_SUBS=false disables mutations (disabled render, rejected POST)", async () => {
    await startServer(false);
    await createBoardApi("gated");
    const taskId = await createTaskApi("gated", "Gated");

    // Disabled render: the routes still respond but show the disabled message.
    const globalHtml = await (await fetch(`${BASE_URL}/notifications?board=gated`)).text();
    expect(globalHtml).toContain("Notification subscriptions feature is not enabled");
    const taskHtml = await (await fetch(`${BASE_URL}/tasks/${taskId}/notifications?board=gated`)).text();
    expect(taskHtml).toContain("Notification subscriptions feature is not enabled");

    // Subscribe POST is rejected and creates nothing.
    const sub = await postForm(`/tasks/${taskId}/notifications?board=gated&/subscribe`, {
      platform: "telegram", chat_id: "x", notifier_profile: "log",
    });
    const subResult = (await sub.json()) as { type: string; status: number; data: string };
    expect(subResult.type).toBe("failure");
    expect(subResult.status).toBe(403);

    useDb();
    expect(listSubscriptions(taskId, true).length).toBe(0);
  }, 60000);
});
