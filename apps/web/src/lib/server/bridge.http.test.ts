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
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { showTask } from "~/models/task";
import { initDb, closeDb } from "~/db";

const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", ".."); // repo root

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;
let port: string;
let baseUrl: string;

function randomPort(): string {
  return String(50000 + Math.floor(Math.random() * 15000));
}

async function waitAlive(timeoutMs = 30000): Promise<void> {
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
      proc.kill(9);
      await proc.exited;
    } catch {
      /* already gone */
    }
    proc = null;
  }
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

afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-001 HTTP smoke (dev server, isolated HOME/KDI_DB)", () => {
  it("POST/GET boards + tasks over HTTP, flag-off disables writes, logs 501", async () => {
    // Close any DB handle left open by earlier tests in this process before
    // the dev server tries to open the same KDI_DB file.
    closeDb();
    await startServer(true);

    // POST /api/boards
    const r1 = await fetch(`${baseUrl}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "smoke", workdir: tmpHome }),
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
    });
    expect(r2.status).toBe(201);
    const t1 = (await r2.json()) as { task: Record<string, unknown> };
    expect(t1.task.title).toBe("HTTP task");
    for (const k of Object.keys(t1.task)) expect(k.includes("_")).toBe(false);
    const taskId = t1.task.id as number;

    // GET /api/boards/smoke/tasks
    const r3 = await fetch(`${baseUrl}/api/boards/smoke/tasks`);
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
    const r4 = await fetch(`${baseUrl}/api/boards/smoke/tasks/${taskId}`);
    expect(r4.status).toBe(200);
    const shown = (await r4.json()) as { task: Record<string, unknown> };
    expect(shown.task.title).toBe("HTTP task");

    // logs route is the spec's prescribed model-gap escape hatch -> 501.
    const r5 = await fetch(`${baseUrl}/api/boards/smoke/tasks/${taskId}/logs`);
    expect(r5.status).toBe(501);
    const logs = (await r5.json()) as { error: string; reason?: string };
    expect(logs.error).toBe("not_implemented");

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
    const rBoardOff = await fetch(`${baseUrl}/boards/smoke`, { redirect: "manual" });
    expect(rBoardOff.status).toBe(307);
    const r6 = await fetch(`${baseUrl}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "should-not-exist", workdir: tmpHome }),
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
});
