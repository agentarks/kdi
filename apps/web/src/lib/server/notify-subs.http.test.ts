// KDI-UI-010 AC-16: notification-subscriptions UI smoke test.
//
// Spawns `bun run dev:web` against an isolated temp HOME + KDI_DB with
// FF_NOTIFY_SUBS=true, creates the board + task via the CLI (kdi boards create /
// kdi create), exercises the SvelteKit form actions the way a browser does, and
// cross-checks every step against `kdi notify-list` on the same DB. Proves the
// UI and CLI read and write the same SQLite database with identical behavior.
//
// Process lifecycle (deterministic): the board-management.http.test.ts template
// spawns ONE server per describe and tears it down once in afterAll. Spawning
// per-test orphaned Vite children and held ports between runs. This file matches
// the template: one shared server for the four flags-on tests; each flag-off
// config gets its own single-test describe with its own server. Three servers
// total, no mid-file respawn.

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "~/db";
import { createBoardJson } from "./bridge";

const REPO_ROOT = process.cwd();

function makeTmpHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `kdi-ui010-${label}-`));
  process.env.HOME = home;
  process.env.KDI_DB = join(home, "kdi.sqlite");
  return home;
}

function kdiEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    KDI_DB: join(home, "kdi.sqlite"),
    FF_SVELTEKIT_FRONTEND: "true",
    VITE_FF_SVELTEKIT_FRONTEND: "true",
    FF_NOTIFY_SUBS: "true",
  };
}

function runKdi(home: string, args: string): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(home) },
  }).trim();
}

function notifyList(home: string, taskId?: number, archived = false): string {
  const parts = ["notify-list"];
  if (taskId !== undefined) parts.push(String(taskId));
  parts.push("--board", "demo");
  if (archived) parts.push("--archived");
  parts.push("--json");
  return runKdi(home, parts.join(" "));
}

async function waitAlive(baseUrl: string, timeoutMs = 30000): Promise<void> {
  // Poll /disabled (always 200 regardless of FF_SVELTEKIT_FRONTEND) so the
  // readiness check works for both the flags-on and master-off servers.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/disabled`, { redirect: "manual" });
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on ${baseUrl} within ${timeoutMs}ms`);
}

// Spawn the dev server with the given env. The returned cleanup kills the whole
// process tree (parent + descendants) so no Vite child is orphaned.
async function spawnServer(home: string, envOverrides: Record<string, string> = {}): Promise<{ baseUrl: string; cleanup: () => Promise<void> }> {
  const port = String(50000 + Math.floor(Math.random() * 15000));
  const baseUrl = `http://localhost:${port}`;
  const p = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(home), NODE_ENV: "development", ...envOverrides },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitAlive(baseUrl);
  const cleanup = async () => {
    const pid = p.pid;
    try { execSync(`pkill -9 -P ${pid} >/dev/null 2>&1 || true`); } catch { /* none */ }
    try { process.kill(pid, 9); } catch { /* gone */ }
    try { await Promise.race([p.exited, new Promise<void>((res) => setTimeout(res, 3000))]); } catch { /* gone */ }
  };
  return { baseUrl, cleanup };
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
  if (res.status === 303) return { status: 303, ok: true };
  if (res.status === 200) {
    try {
      const json = JSON.parse(text);
      if (json.type === "redirect" || json.type === "success") return { status: 303, ok: true, error: undefined };
      if (json.type === "failure") {
        const data = typeof json.data === "string" ? JSON.parse(json.data) : json.data;
        const msg = Array.isArray(data) ? data[1] : data?.error?.message ?? data?.error;
        return { status: json.status, ok: false, error: msg };
      }
    } catch { /* not JSON */ }
  }
  return { status: res.status, ok: false, error: text.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Shared-server suite: the four flags-on tests reuse ONE dev server.
// ---------------------------------------------------------------------------

describe("KDI-UI-010 notification subscriptions UI smoke (AC-16)", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;
  let demoTaskId: number;
  let semTaskId: number;

  beforeAll(async () => {
    home = makeTmpHome("http");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    demoTaskId = Number(runKdi(home, 'create "Notify me" --board demo').trim());
    semTaskId = Number(runKdi(home, 'create "Sem" --board demo').trim());
    ({ baseUrl, cleanup } = await spawnServer(home));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("subscribe via per-task UI -> global list -> toggle -> unsubscribe -> empty (cross-checked with kdi notify-list)", async () => {
    const sub = await submitForm(baseUrl, `/tasks/${demoTaskId}/notifications?board=demo&/subscribe`, {
      platform: "telegram", chat_id: "chat-1", notifier_profile: "log",
    });
    expect(sub.ok).toBe(true);

    const cliTaskList = JSON.parse(notifyList(home, demoTaskId));
    expect(cliTaskList).toHaveLength(1);
    expect(cliTaskList[0].platform).toBe("telegram");
    expect(cliTaskList[0].chat_id).toBe("chat-1");
    expect(cliTaskList[0].notifier_profile).toBe("log");

    const globalActive = await (await fetch(`${baseUrl}/notifications?board=demo`)).text();
    expect(globalActive).toContain("chat-1");
    expect(globalActive).toContain("telegram");
    expect(globalActive).not.toContain("No active subscriptions");
    const cliBoardList = JSON.parse(notifyList(home));
    expect(cliBoardList).toHaveLength(1);
    expect(cliBoardList[0].task_id).toBe(demoTaskId);

    // AC-16 (spec step order): toggle BEFORE unsubscribe — still-active row shows
    // the Unsubscribe button, NOT the unsubscribed badge.
    const archivedActive = await (await fetch(`${baseUrl}/notifications?board=demo&archived=1`)).text();
    expect(archivedActive).toContain("chat-1");
    expect(archivedActive).toContain(">Unsubscribe</button>");
    expect(archivedActive).not.toContain(">unsubscribed</span>");

    const unsub = await submitForm(baseUrl, `/notifications?board=demo&/unsubscribe`, {
      task_id: String(demoTaskId), platform: "telegram", chat_id: "chat-1",
    });
    expect(unsub.ok).toBe(true);

    const globalAfter = await (await fetch(`${baseUrl}/notifications?board=demo`)).text();
    expect(globalAfter).not.toContain("chat-1");
    expect(globalAfter).toContain("No active subscriptions");

    const archivedAfter = await (await fetch(`${baseUrl}/notifications?board=demo&archived=1`)).text();
    expect(archivedAfter).toContain("chat-1");
    expect(archivedAfter).toContain("unsubscribed");

    expect(JSON.parse(notifyList(home, demoTaskId, false))).toHaveLength(0);
    expect(JSON.parse(notifyList(home, demoTaskId, true))).toHaveLength(1);
  }, 120000);

  it("AC-09/AC-12/AC-13: unsupported platform rejection + thread-scoped vs no-thread unsubscribe", async () => {
    const bad = await submitForm(baseUrl, `/tasks/${semTaskId}/notifications?board=demo&/subscribe`, {
      platform: "carrier-pigeon", chat_id: "c", notifier_profile: "log",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Unsupported platform");

    expect((await submitForm(baseUrl, `/tasks/${semTaskId}/notifications?board=demo&/subscribe`, {
      platform: "slack", chat_id: "shared", notifier_profile: "log",
    })).ok).toBe(true);
    expect((await submitForm(baseUrl, `/tasks/${semTaskId}/notifications?board=demo&/subscribe`, {
      platform: "slack", chat_id: "shared", thread_id: "t1", notifier_profile: "log",
    })).ok).toBe(true);
    expect(JSON.parse(notifyList(home, semTaskId))).toHaveLength(2);

    expect((await submitForm(baseUrl, `/tasks/${semTaskId}/notifications?board=demo&/unsubscribe`, {
      platform: "slack", chat_id: "shared", thread_id: "t1",
    })).ok).toBe(true);
    const afterThread = JSON.parse(notifyList(home, semTaskId));
    expect(afterThread).toHaveLength(1);
    expect(afterThread[0].thread_id).toBeNull();

    expect((await submitForm(baseUrl, `/tasks/${semTaskId}/notifications?board=demo&/unsubscribe`, {
      platform: "slack", chat_id: "shared",
    })).ok).toBe(true);
    expect(JSON.parse(notifyList(home, semTaskId, false))).toHaveLength(0);
    expect(JSON.parse(notifyList(home, semTaskId, true))).toHaveLength(2);
  }, 120000);

  it("form actions preserve the selected board ( Finding 1 regression )", async () => {
    await createBoardJson({ slug: "real", workdir: home });
    const taskId = Number(runKdi(home, 'create "On real" --board real').trim());
    const { subscribeJson } = await import("./bridge");
    process.env.FF_NOTIFY_SUBS = "true";
    await subscribeJson("real", taskId, "telegram", "c1", { notifierProfile: "log" });

    const html = await (await fetch(`${baseUrl}/notifications?board=real`)).text();
    expect(html).toContain('name="board" value="real"');
    const taskHtml = await (await fetch(`${baseUrl}/tasks/${taskId}/notifications?board=real`)).text();
    expect(taskHtml).toContain('name="board" value="real"');

    const params = new URLSearchParams({ board: "real", task_id: String(taskId), platform: "telegram", chat_id: "c1" });
    const res = await fetch(`${baseUrl}/notifications?/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: baseUrl, referer: `${baseUrl}/notifications` },
      body: params.toString(),
      redirect: "manual",
    });
    const rBody = await res.json();
    expect(["redirect", "success"]).toContain(rBody.type);
    expect(JSON.parse(notifyList(home, taskId))).toHaveLength(0);
  }, 120000);

  it("FR-13: missing-task subscribe returns the model message 'Task <id> not found.' ( Finding 2 regression )", async () => {
    const res = await submitForm(baseUrl, `/tasks/9999/notifications?board=demo&/subscribe`, {
      platform: "telegram", chat_id: "c", notifier_profile: "log",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Task 9999 not found.");
    // Cross-board task (exists on another board) is still blocked.
    await createBoardJson({ slug: "other", workdir: home });
    const xTaskId = Number(runKdi(home, 'create "On other" --board other').trim());
    const xRes = await submitForm(baseUrl, `/tasks/${xTaskId}/notifications?board=demo&/subscribe`, {
      platform: "telegram", chat_id: "c", notifier_profile: "log",
    });
    expect(xRes.ok).toBe(false);
    expect(xRes.error).toBe(`Task ${xTaskId} not found on board "demo".`);
  }, 120000);
});

// ---------------------------------------------------------------------------
// Flag-off suites: each is its own describe so it owns one server start/stop
// with the alternate flag env. No mid-file respawn of a shared server.
// ---------------------------------------------------------------------------

describe("KDI-UI-010 flag gate (AC-14): FF_NOTIFY_SUBS=false", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("notifoff");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    const taskId = Number(runKdi(home, 'create "Gated" --board demo').trim());
    ({ baseUrl, cleanup } = await spawnServer(home, { FF_NOTIFY_SUBS: "false" }));
    // stash for the test body
    (globalThis as Record<string, unknown>).__ui010_notifoff_task = taskId;
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("disabled render + rejected subscribe POST (403) + no subscription created", async () => {
    const taskId = (globalThis as Record<string, unknown>).__ui010_notifoff_task as number;
    expect(await (await fetch(`${baseUrl}/notifications?board=demo`)).text()).toContain("Notification subscriptions feature is not enabled");
    expect(await (await fetch(`${baseUrl}/tasks/${taskId}/notifications?board=demo`)).text()).toContain("Notification subscriptions feature is not enabled");

    const sub = await submitForm(baseUrl, `/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      platform: "telegram", chat_id: "x", notifier_profile: "log",
    });
    expect(sub.ok).toBe(false);
    expect(sub.status).toBe(403);
    expect(JSON.parse(notifyList(home, taskId, true))).toHaveLength(0);
  }, 120000);
});

describe("KDI-UI-010 flag gate (AC-14): FF_SVELTEKIT_FRONTEND=false", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("masteroff");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    const taskId = Number(runKdi(home, 'create "MasterOff" --board demo').trim());
    ({ baseUrl, cleanup } = await spawnServer(home, {
      FF_SVELTEKIT_FRONTEND: "false",
      VITE_FF_SVELTEKIT_FRONTEND: "false",
    }));
    (globalThis as Record<string, unknown>).__ui010_masteroff_task = taskId;
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("redirects every route to /disabled and blocks mutations", async () => {
    const taskId = (globalThis as Record<string, unknown>).__ui010_masteroff_task as number;
    const g1 = await fetch(`${baseUrl}/notifications?board=demo`, { redirect: "manual" });
    expect(g1.status).toBe(307);
    expect(g1.headers.get("location")).toBe("/disabled");
    const g2 = await fetch(`${baseUrl}/tasks/${taskId}/notifications?board=demo`, { redirect: "manual" });
    expect(g2.status).toBe(307);
    expect(g2.headers.get("location")).toBe("/disabled");

    const p = await fetch(`${baseUrl}/tasks/${taskId}/notifications?board=demo&/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: baseUrl, referer: `${baseUrl}/tasks/${taskId}/notifications` },
      body: new URLSearchParams({ platform: "telegram", chat_id: "c", notifier_profile: "log" }).toString(),
      redirect: "manual",
    });
    const pBody = (await p.json()) as { type: string; status: number; location: string };
    expect(pBody.type).toBe("redirect");
    expect(pBody.status).toBe(307);
    expect(pBody.location).toBe("/disabled");
    expect(JSON.parse(notifyList(home, taskId, true))).toHaveLength(0);
  }, 120000);
});
