// KDI-UI-010 AC-16: notification-subscriptions UI smoke test.
//
// Copies the pattern from board-management.http.test.ts: spawn `bun run dev:web`
// against an isolated temp HOME + KDI_DB with FF_NOTIFY_SUBS=true, create the
// board + task via the CLI (kdi boards create / kdi create), exercise the
// SvelteKit form actions the way a browser does, and cross-check every step
// against `kdi notify-list` / `kdi notify-subscribe` / `kdi notify-unsubscribe`
// on the same DB. This proves the UI and CLI read and write the same SQLite
// database with identical behavior.
//
// SvelteKit enhanced forms return a 200 JSON envelope ({type:"redirect"|"failure"});
// a plain form POST would return 303. submitForm accepts either shape as success.

import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "~/db";
import { createBoardJson } from "./bridge";

const REPO_ROOT = process.cwd(); // tests run from repo root

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;

const kdiEnv = (): Record<string, string> => ({
  HOME: tmpHome,
  KDI_DB: join(tmpHome, "kdi.sqlite"),
  FF_SVELTEKIT_FRONTEND: "true",
  VITE_FF_SVELTEKIT_FRONTEND: "true",
  FF_NOTIFY_SUBS: "true",
});

async function waitAlive(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on ${baseUrl} within ${timeoutMs}ms`);
}

async function startServer(): Promise<string> {
  if (proc) {
    try { proc.kill(9); await proc.exited; } catch { /* gone */ }
    proc = null;
  }
  const port = String(50000 + Math.floor(Math.random() * 15000));
  const baseUrl = `http://localhost:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(), NODE_ENV: "development" },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitAlive(baseUrl);
  return baseUrl;
}

// Run the kdi CLI against the same isolated DB. Used both to seed state
// (boards/tasks) and to cross-check UI results (notify-list) per AC-16.
function runKdi(args: string): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv() },
  }).trim();
}

function notifyList(taskId?: number, archived = false): string {
  const parts = ["notify-list"];
  if (taskId !== undefined) parts.push(String(taskId));
  parts.push("--board", "demo");
  if (archived) parts.push("--archived");
  parts.push("--json");
  return runKdi(parts.join(" "));
}

async function submitForm(baseUrl: string, path: string, body: Record<string, string>): Promise<{ status: number; ok: boolean; error?: string }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, v);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: baseUrl, referer: `${baseUrl}${path}` },
    body: params.toString(),
    redirect: "manual",
  });
  const text = await res.text();
  // Success: 303 redirect OR 200 JSON envelope {type:"redirect"|"success"}.
  if (res.status === 303) return { status: 303, ok: true };
  if (res.status === 200) {
    try {
      const json = JSON.parse(text);
      if (json.type === "redirect" || json.type === "success") return { status: 303, ok: true, error: undefined };
      if (json.type === "failure") {
        // Unwrap SvelteKit's serialized failure data to the message string.
        const data = typeof json.data === "string" ? JSON.parse(json.data) : json.data;
        const msg = Array.isArray(data) ? data[1] : data?.error?.message ?? data?.error;
        return { status: json.status, ok: false, error: msg };
      }
    } catch { /* not JSON */ }
  }
  return { status: res.status, ok: false, error: text.slice(0, 200) };
}

afterAll(() => {
  if (proc) { try { proc.kill(9); } catch { /* gone */ } proc = null; }
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-010 notification subscriptions UI smoke (AC-16)", () => {
  it("subscribe via per-task UI -> global list -> toggle -> unsubscribe -> empty (cross-checked with kdi notify-list)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui010-http-"));
    // Seed the DB file in the test process, then create the board + task via the
    // CLI exactly as an operator would (AC-16: "create a board and task").
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    const createOut = runKdi('create "Notify me" --board demo');
    const taskId = Number(createOut.trim());
    expect(taskId).toBeGreaterThan(0);

    const baseUrl = await startServer();

    // AC-16: subscribe to the task via the per-task UI form (log is always available).
    const sub = await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      platform: "telegram", chat_id: "chat-1", notifier_profile: "log",
    });
    expect(sub.ok).toBe(true);

    // Cross-check with `kdi notify-list <task>` on the same DB.
    const cliTaskList = JSON.parse(notifyList(taskId));
    expect(cliTaskList).toHaveLength(1);
    expect(cliTaskList[0].platform).toBe("telegram");
    expect(cliTaskList[0].chat_id).toBe("chat-1");
    expect(cliTaskList[0].notifier_profile).toBe("log");

    // AC-01/AC-16: the subscription appears in the GLOBAL list for the board.
    const globalActive = await (await fetch(`${baseUrl}/notifications?board=demo`)).text();
    expect(globalActive).toContain("chat-1");
    expect(globalActive).toContain("telegram");
    expect(globalActive).not.toContain("No active subscriptions");
    // CLI parity: board-scoped notify-list sees it too.
    const cliBoardList = JSON.parse(notifyList());
    expect(cliBoardList).toHaveLength(1);
    expect(cliBoardList[0].task_id).toBe(taskId);

    // AC-16 (spec step order): toggle "Include unsubscribed" BEFORE unsubscribe —
    // the still-active row appears and is NOT marked unsubscribed.
    const archivedActive = await (await fetch(`${baseUrl}/notifications?board=demo&archived=1`)).text();
    expect(archivedActive).toContain("chat-1");
    expect(archivedActive).toContain(">Unsubscribe</button>");
    expect(archivedActive).not.toContain(">unsubscribed</span>");

    // AC-11/AC-16: unsubscribe from the GLOBAL list.
    const unsub = await submitForm(baseUrl, `/notifications?board=demo&/unsubscribe`, {
      task_id: String(taskId), platform: "telegram", chat_id: "chat-1",
    });
    expect(unsub.ok).toBe(true);

    // AC-16: active global list is now empty.
    const globalAfter = await (await fetch(`${baseUrl}/notifications?board=demo`)).text();
    expect(globalAfter).not.toContain("chat-1");
    expect(globalAfter).toContain("No active subscriptions");

    // AC-02/AC-16: the unsubscribed row reappears ONLY with the toggle on.
    const archivedAfter = await (await fetch(`${baseUrl}/notifications?board=demo&archived=1`)).text();
    expect(archivedAfter).toContain("chat-1");
    expect(archivedAfter).toContain("unsubscribed");

    // CLI parity: active list empty, archived list has the soft-deleted row.
    expect(JSON.parse(notifyList(taskId, false))).toHaveLength(0);
    expect(JSON.parse(notifyList(taskId, true))).toHaveLength(1);
  }, 120000);

  it("AC-09/AC-12/AC-13: unsupported platform rejection + thread-scoped vs no-thread unsubscribe", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui010-http-"));
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    const taskId = Number(runKdi('create "Sem" --board demo').trim());
    const baseUrl = await startServer();

    // AC-09: unsupported platform rejected with CLI-verbatim text via the form.
    const bad = await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      platform: "carrier-pigeon", chat_id: "c", notifier_profile: "log",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Unsupported platform");

    // Create a no-thread + a thread-scoped sub for the same platform/chat.
    expect((await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      platform: "slack", chat_id: "shared", notifier_profile: "log",
    })).ok).toBe(true);
    expect((await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      platform: "slack", chat_id: "shared", thread_id: "t1", notifier_profile: "log",
    })).ok).toBe(true);
    expect(JSON.parse(notifyList(taskId))).toHaveLength(2);

    // AC-12: thread-scoped unsubscribe leaves the no-thread sub intact.
    expect((await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/unsubscribe`, {
      platform: "slack", chat_id: "shared", thread_id: "t1",
    })).ok).toBe(true);
    const afterThread = JSON.parse(notifyList(taskId));
    expect(afterThread).toHaveLength(1);
    expect(afterThread[0].thread_id).toBeNull();

    // AC-13: no-thread unsubscribe removes ALL remaining active subs for that
    // platform/chat (here just the no-thread one).
    expect((await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/unsubscribe`, {
      platform: "slack", chat_id: "shared",
    })).ok).toBe(true);
    expect(JSON.parse(notifyList(taskId, false))).toHaveLength(0);
    expect(JSON.parse(notifyList(taskId, true))).toHaveLength(2);
  }, 120000);

  it("AC-14: FF_NOTIFY_SUBS=false disables mutations (disabled render, rejected POST)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui010-http-"));
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    const taskId = Number(runKdi('create "Gated" --board demo').trim());

    // Re-spawn the server with the feature flag off.
    if (proc) { try { proc.kill(9); await proc.exited; } catch { /* gone */ } proc = null; }
    const port = String(50000 + Math.floor(Math.random() * 15000));
    const baseUrl = `http://localhost:${port}`;
    proc = Bun.spawn({
      cmd: ["bun", "run", "dev:web", "--port", port],
      cwd: REPO_ROOT,
      env: { ...process.env, ...kdiEnv(), FF_NOTIFY_SUBS: "false", NODE_ENV: "development" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitAlive(baseUrl);

    // Disabled render on both routes.
    expect(await (await fetch(`${baseUrl}/notifications?board=demo`)).text()).toContain("Notification subscriptions feature is not enabled");
    expect(await (await fetch(`${baseUrl}/tasks/${taskId}/notifications?board=demo`)).text()).toContain("Notification subscriptions feature is not enabled");

    // Subscribe POST is rejected and creates nothing.
    const sub = await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      platform: "telegram", chat_id: "x", notifier_profile: "log",
    });
    expect(sub.ok).toBe(false);
    expect(sub.status).toBe(403);

    // CLI parity on the same DB: zero subscriptions (the gate is in the bridge;
    // the CLI itself also rejects via requireFlag, so 0 rows is guaranteed).
    expect(JSON.parse(notifyList(taskId, true))).toHaveLength(0);
  }, 120000);
});
