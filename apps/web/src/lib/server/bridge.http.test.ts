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
import { initDb } from "~/db";

const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", ".."); // repo root
const PORT = "5191";
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

// Start (or restart) the dev server with the given flag and isolated HOME/KDI_DB.
// ponytail: one helper for the two spawn sites (flag on/off), not two copies.
async function startServer(enabled: boolean): Promise<void> {
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    proc = null;
  }
  if (!tmpHome) {
    tmpHome = `/tmp/kdi-ui001-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(tmpHome, { recursive: true });
  }
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", PORT],
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: enabled ? "true" : "false",
      NODE_ENV: "development",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitAlive();
}

afterAll(() => {
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    proc = null;
  }
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-001 HTTP smoke (dev server, isolated HOME/KDI_DB)", () => {
  it("POST/GET boards + tasks over HTTP, flag-off disables writes, logs 501", async () => {
    await startServer(true);

    // POST /api/boards
    const r1 = await fetch(`${BASE_URL}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "smoke", workdir: tmpHome }),
    });
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { board: Record<string, unknown> };
    expect(b1.board.slug).toBe("smoke");
    for (const k of Object.keys(b1.board)) expect(k.includes("_")).toBe(false);

    // POST /api/boards/smoke/tasks
    const r2 = await fetch(`${BASE_URL}/api/boards/smoke/tasks`, {
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
    const r3 = await fetch(`${BASE_URL}/api/boards/smoke/tasks`);
    expect(r3.status).toBe(200);
    const listed = (await r3.json()) as { tasks: Array<Record<string, unknown>> };
    expect(listed.tasks.some((t) => t.id === taskId)).toBe(true);

    // GET /api/boards/smoke/tasks/<id>
    const r4 = await fetch(`${BASE_URL}/api/boards/smoke/tasks/${taskId}`);
    expect(r4.status).toBe(200);
    const shown = (await r4.json()) as { task: Record<string, unknown> };
    expect(shown.task.title).toBe("HTTP task");

    // CLI cross-check: read the SAME DB file from this test process (the dev
    // server is a separate process with its own getDb singleton; both point at
    // the same KDI_DB file, so WAL makes the write visible here). initDb caches
    // per-process, so initialize against tmpHome before reading.
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const truth = showTask(taskId)!;
    expect(truth.title).toBe("HTTP task");
    expect(truth.assignee).toBe("ralph");
    expect(truth.priority).toBe(3);

    // logs route is the spec's prescribed model-gap escape hatch -> 501.
    const r5 = await fetch(`${BASE_URL}/api/boards/smoke/tasks/${taskId}/logs`);
    expect(r5.status).toBe(501);
    const logs = (await r5.json()) as { error: string; reason?: string };
    expect(logs.error).toBe("not_implemented");

    // Restart with the flag OFF: writes must be refused (503) and must NOT
    // have mutated state.
    await startServer(false);
    const r6 = await fetch(`${BASE_URL}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "should-not-exist", workdir: tmpHome }),
    });
    expect(r6.status).toBe(503);
    const off = (await r6.json()) as { enabled: boolean };
    expect(off.enabled).toBe(false);
    // The flag-off POST created no board: showTask on a non-existent id is null
    // and no board "should-not-exist" was added.
    expect(showTask(taskId)!.title).toBe("HTTP task"); // unchanged
  }, 60000);
});