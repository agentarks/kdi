// KDI-UI-001 HTTP smoke — the real spec acceptance path.
//
// The unit test (bridge.test.ts) exercises bridge functions directly under the
// Bun runtime, which is necessary but not sufficient: SvelteKit SSR runs the
// route adapters under a server process, and the bridge imports the CLI models
// which pull `bun:sqlite`. `bun:sqlite` only resolves under the Bun runtime, so
// a Node-loaded SSR pipeline 500s on every data route. This test catches that
// wiring by spawning the ACTUAL default dev server (`bun run dev:web`, which
// the package scripts force to run under Bun via `--bun`) against an isolated
// temp HOME + KDI_DB, hitting the create-board / create-task / read POST/GET
// routes over HTTP, and cross-checking the result against the CLI `show` source
// of truth on the same DB.
//
// ponytail: one runtime check that fails if anyone re-breaks SSR/bun:sqlite
// wiring or the dev:web script. It is intentionally an HTTP end-to-end check
// because the bug it guards is a module-loading/runtime bug, not a logic bug —
// logic tests cannot see it.

import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { showTask } from "~/models/task";
import { initDb, closeDb } from "~/db";
import { getTaskLogPath } from "~/observability";

// One level deeper than the KDI-UI-001 comment implied: this file lives at
// apps/web/src/lib/server, so the repo root is five dirs up. (`bun run
// dev:web` tolerated the old four-up path because bun walks up to the nearest
// package.json, but an explicit src/index.ts path needs the real root.)
const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", "..", ".."); // repo root

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;
let port: string;
let baseUrl: string;

function randomPort(): string {
  return String(50000 + Math.floor(Math.random() * 15000));
}

async function waitAlive(timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on :${port} within ${timeoutMs}ms`);
}

async function stopServer(): Promise<void> {
  if (proc) {
    try {
      // Kill the entire process group: `bun run dev:web` parents a Vite dev
      // server that spawns its own children. Killing only the bun parent
      // orphans them and keeps the test process alive (the 20-min hang).
      process.kill(-proc.pid, 9);
      await proc.exited;
    } catch {
      /* already gone */
    }
    proc = null;
  }
  // Give the OS and Vite's file watchers a moment to release the port and
  // clean up child processes before the next dev server starts on a new port.
  await new Promise((res) => setTimeout(res, 500));
}

// Start (or restart) the dev server with the given flag and isolated HOME/KDI_DB.
// ponytail: one helper for the two spawn sites (flag on/off), not two copies.
async function startServer(enabled: boolean): Promise<void> {
  await stopServer();
  if (!tmpHome) {
    tmpHome = `/tmp/kdi-ui001-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(tmpHome, { recursive: true });
  }
  port = randomPort();
  baseUrl = `http://localhost:${port}`;
  // Ensure the test process also points at the same isolated DB so any
  // cross-check later uses the same path, and so the spawned dev server
  // cannot inherit a stale KDI_DB from a previous test.
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: WORKTREE_ROOT,
    // POSIX setsid(): proc.pid becomes the process-group leader so stopServer
    // can reap the whole Vite tree, not just the bun parent.
    detached: true,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: enabled ? "true" : "false",
      NODE_ENV: "development",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitAlive();
}

// Run the kdi CLI as a subprocess against the isolated HOME/KDI_DB. Used by
// AC-14 to prove the activity view reads events the CLI wrote (not just data
// created through the HTTP bridge). Async with a per-call kill timer so a slow
// `bun src/index.ts` cold-start under full-suite load can't monopolize the test.
async function runCli(args: string[]): Promise<{ stdout: string; code: number }> {
  const child = Bun.spawn({
    cmd: ["bun", join(WORKTREE_ROOT, "src/index.ts"), ...args],
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try { child.kill(9); } catch { /* already gone */ }
  }, 40000);
  try {
    const code = await child.exited;
    const stdout = (await new Response(child.stdout).text()).trim();
    if (code !== 0) {
      const stderr = (await new Response(child.stderr).text()).trim();
      throw new Error(`kdi ${args.join(" ")} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
    }
    return { stdout, code };
  } finally {
    clearTimeout(timer);
  }
}

afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-001 HTTP smoke (dev server, isolated HOME/KDI_DB)", () => {
  it("POST/GET boards + tasks over HTTP, flag-off disables writes, activity + logs render", async () => {
    // Close any DB handle left open by earlier tests in this process before
    // the dev server tries to open the same KDI_DB file.
    closeDb();
    await startServer(true);

    // POST /api/boards
    const r1 = await fetch(`${baseUrl}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "smoke", workdir: tmpHome }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { board: Record<string, unknown> };
    expect(b1.board.slug).toBe("smoke");
    for (const k of Object.keys(b1.board)) expect(k.includes("_")).toBe(false);

    // POST /api/boards/smoke/tasks
    const r2 = await fetch(`${baseUrl}/api/boards/smoke/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "HTTP task", body: "hello", assignee: "ralph", priority: 3 }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r2.status).toBe(201);
    const t1 = (await r2.json()) as { task: Record<string, unknown> };
    expect(t1.task.title).toBe("HTTP task");
    for (const k of Object.keys(t1.task)) expect(k.includes("_")).toBe(false);
    const taskId = t1.task.id as number;

    // GET /api/boards/smoke/tasks
    const r3 = await fetch(`${baseUrl}/api/boards/smoke/tasks`, { signal: AbortSignal.timeout(10000) });
    expect(r3.status).toBe(200);
    const listed = (await r3.json()) as { tasks: Array<Record<string, unknown>> };
    expect(listed.tasks.some((t) => t.id === taskId)).toBe(true);

    // GET /boards/smoke renders the Kanban board view with the task card
    const rBoard = await fetch(`${baseUrl}/boards/smoke`, { signal: AbortSignal.timeout(10000) });
    expect(rBoard.status).toBe(200);
    const boardHtml = await rBoard.text();
    expect(boardHtml.includes(String(taskId))).toBe(true);
    expect(boardHtml.includes("HTTP task")).toBe(true);
    expect(boardHtml.includes("Board: smoke")).toBe(true);

    // GET /api/boards/smoke/tasks/<id>
    const r4 = await fetch(`${baseUrl}/api/boards/smoke/tasks/${taskId}`, { signal: AbortSignal.timeout(10000) });
    expect(r4.status).toBe(200);
    const shown = (await r4.json()) as { task: Record<string, unknown> };
    expect(shown.task.title).toBe("HTTP task");

    // GET /api/boards/smoke/tasks/<id>/log returns the worker log tail
    const logPath = getTaskLogPath("smoke", taskId);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "worker log line 1\nworker log line 2\n");
    const r5 = await fetch(`${baseUrl}/api/boards/smoke/tasks/${taskId}/log?tail=30`, { signal: AbortSignal.timeout(10000) });
    expect(r5.status).toBe(200);
    const logs = (await r5.json()) as { present: boolean; content: string };
    expect(logs.present).toBe(true);
    expect(logs.content).toContain("worker log line 2");

    // KDI-UI-008: activity page and event stream endpoints
    const rActivity = await fetch(`${baseUrl}/activity?board=smoke`, { signal: AbortSignal.timeout(10000) });
    expect(rActivity.status).toBe(200);
    const activityHtml = await rActivity.text();
    expect(activityHtml.includes("Activity")).toBe(true);
    expect(activityHtml.includes("smoke")).toBe(true);

    const rEvents = await fetch(`${baseUrl}/api/boards/smoke/events`, { signal: AbortSignal.timeout(10000) });
    expect(rEvents.status).toBe(200);
    const eventsJson = (await rEvents.json()) as { events: Array<{ kind: string; taskId: number }> };
    expect(eventsJson.events.some((e) => e.kind === "created" && e.taskId === taskId)).toBe(true);

    // Stop the dev server before reading the same DB from this process.
    // bun:sqlite WAL tolerates multiple readers, but concurrent open handles
    // from two processes on the same file can cause flaky disk I/O errors
    // when the test suite runs all files together.
    await stopServer();

    // CLI cross-check: read the SAME DB file from this test process (the dev
    // server is a separate process with its own getDb singleton; both point at
    // the same KDI_DB file). initDb caches per-process, so initialize against
    // tmpHome before reading. closeDb when done so the flag-off restart below
    // does not fight for the same WAL handle.
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const truth = showTask(taskId)!;
    expect(truth.title).toBe("HTTP task");
    expect(truth.assignee).toBe("ralph");
    expect(truth.priority).toBe(3);
    closeDb();

    // Restart with the flag OFF: writes must be refused (503) and must NOT
    // have mutated state; the Kanban UI redirects to /disabled.
    await startServer(false);
    const rBoardOff = await fetch(`${baseUrl}/boards/smoke`, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    expect(rBoardOff.status).toBe(307);
    const r6 = await fetch(`${baseUrl}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "should-not-exist", workdir: tmpHome }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r6.status).toBe(503);
    const off = (await r6.json()) as { enabled: boolean };
    expect(off.enabled).toBe(false);

    // Stop the flag-off server. The 503 response above is sufficient evidence
    // that writes were refused; avoid a second direct DB open in this process
    // because other tests in the same process may leave the getDb singleton in
    // a state that makes the extra cross-check flaky.
    await stopServer();
  }, 60000);

  it("POST /api/boards/[slug]/dispatch triggers one-shot dispatch and refreshes counts", async () => {
    closeDb();
    await startServer(true);

    // Ensure the opencode profile resolves so the task is claimed.
    const profilesDir = join(tmpHome, ".config", "kdi");
    mkdirSync(profilesDir, { recursive: true });
    const profilesPath = join(profilesDir, "profiles.yaml");
    writeFileSync(
      profilesPath,
      "- name: opencode\n  command: \"true\"\n- name: pi\n  command: \"true\"\n",
    );
    process.env.KDI_PROFILES_PATH = profilesPath;

    const nonExistentWorkdir = join(tmpHome, "nonexistent");
    const r1 = await fetch(`${baseUrl}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "dispatch", workdir: nonExistentWorkdir }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r1.status).toBe(201);

    const r2 = await fetch(`${baseUrl}/api/boards/dispatch/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ready task", assignee: "opencode", initialStatus: "ready" }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r2.status).toBe(201);

    const r3 = await fetch(`${baseUrl}/api/boards/dispatch/dispatch/status`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(r3.status).toBe(200);
    const status = (await r3.json()) as {
      board: string;
      presence: { present: boolean };
      taskCounts: { ready: number; blocked: number };
    };
    expect(status.board).toBe("dispatch");
    expect(status.presence.present).toBe(false);
    expect(status.taskCounts.ready).toBe(1);

    const r4 = await fetch(`${baseUrl}/api/boards/dispatch/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    expect(r4.status).toBe(201);
    const result = (await r4.json()) as {
      processed: number;
      spawned: number;
      blocked: number;
      skipped: number;
      failed: number;
    };
    expect(result.processed).toBe(1);
    expect(result.spawned).toBe(1);
    expect(result.blocked).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);

    const r5 = await fetch(`${baseUrl}/api/boards/dispatch/dispatch/status`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(r5.status).toBe(200);
    const status2 = (await r5.json()) as {
      taskCounts: { ready: number; blocked: number };
    };
    expect(status2.taskCounts.ready).toBe(0);
    expect(status2.taskCounts.blocked).toBe(1);

    // AC-16: the /dispatch page renders the control center from the server.
    const rPage = await fetch(`${baseUrl}/dispatch?board=dispatch`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(rPage.status).toBe(200);
    const pageHtml = await rPage.text();
    expect(pageHtml).toContain("Dispatcher presence");
    expect(pageHtml).toContain("Task counts");
    expect(pageHtml).toContain("One-shot dispatch");
    expect(pageHtml).toContain("ready");
    expect(pageHtml).toContain("blocked");
    expect(pageHtml).toContain("No tasks are ready to dispatch.");

    await stopServer();
  }, 60000);

  // AC-14: events must originate from the CLI and be readable by the activity
  // view against the same DB. The stream hydrates client-side (BRD NFR), so we
  // assert the SSR board header plus the events endpoint the page fetches.
  it("AC-14: CLI-created task events render in the activity view", async () => {
    closeDb();
    if (!tmpHome) {
      tmpHome = `/tmp/kdi-ui001-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
      mkdirSync(tmpHome, { recursive: true });
    }

    // 1. Create board + task + promote via the CLI (NOT the HTTP bridge). Each
    //    emits a board event ("created", "promoted") into the shared KDI_DB.
    let cli = await runCli(["boards", "create", "ac14", "--workdir", tmpHome]);
    expect(cli.code).toBe(0);
    cli = await runCli(["create", "CLI task", "--board", "ac14"]);
    expect(cli.code).toBe(0);
    const taskId = Number(cli.stdout);
    expect(Number.isInteger(taskId) && taskId > 0).toBe(true);
    cli = await runCli(["promote", String(taskId)]);
    expect(cli.code).toBe(0);

    // 2. Start the dev server against the SAME DB the CLI just wrote to.
    await startServer(true);

    // 3. The activity page SSR-renders the board header for the CLI board.
    const rActivity = await fetch(`${baseUrl}/activity?board=ac14`, { signal: AbortSignal.timeout(10000) });
    expect(rActivity.status).toBe(200);
    const activityHtml = await rActivity.text();
    expect(activityHtml).toContain("Activity");
    expect(activityHtml).toContain("ac14");

    // 4. The event stream the activity page hydrates from returns the CLI
    //    task's "created" and "promoted" events, proving the UI reads the same
    //    events the CLI wrote (and the response carries the board + since cursor).
    const rEvents = await fetch(`${baseUrl}/api/boards/ac14/events`, { signal: AbortSignal.timeout(10000) });
    expect(rEvents.status).toBe(200);
    const eventsJson = (await rEvents.json()) as {
      events: Array<{ kind: string; taskId: number }>;
      board: string;
      since: number | null;
    };
    expect(eventsJson.board).toBe("ac14");
    expect(eventsJson.since).toBeNull();
    const kinds = eventsJson.events.filter((e) => e.taskId === taskId).map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("promoted");

    await stopServer();
  }, 120000);
});
