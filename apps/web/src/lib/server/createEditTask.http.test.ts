// KDI-UI-004 HTTP smoke — exercises the SvelteKit server-action forms the
// way a browser does. Spawns the dev server against an isolated temp HOME +
// KDI_DB, creates a board via the API bridge, then POSTs form data to the
// create/edit routes and cross-checks the created task against the CLI model.

import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { showTask } from "~/models/task";
import { createBoard } from "~/models/board";
import { initDb } from "~/db";

const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", ".."); // repo root
const PORT = "5194";
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

async function startServer(flag = true): Promise<void> {
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    proc = null;
  }
  tmpHome = `/tmp/kdi-ui004-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", PORT],
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: flag ? "true" : "false",
      VITE_FF_SVELTEKIT_FRONTEND: flag ? "true" : "false",
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

function createBoardModel(slug: string): void {
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  initDb();
  createBoard(slug, tmpHome, "origin/main", {});
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

describe("KDI-UI-004 HTTP smoke (dev server, isolated HOME/KDI_DB)", () => {
  it("POST create and edit forms mutate tasks and match CLI model", async () => {
    await startServer(true);
    await createBoardApi("smoke");

    // POST to the SvelteKit create-task form.
    const form = new URLSearchParams();
    form.set("title", "HTTP form task");
    form.set("body", "from form");
    form.set("assignee", "ralph");
    form.set("status", "todo");
    const r2 = await fetch(`${BASE_URL}/boards/smoke/tasks/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(r2.status).toBe(200);
    const createResult = (await r2.json()) as { type: string; location: string };
    expect(createResult.type).toBe("redirect");
    expect(createResult.location).toMatch(/^\/boards\/smoke\?created=\d+$/);
    const taskId = Number(createResult.location.match(/created=(\d+)/)?.[1]);

    // Cross-check against the CLI model on the same DB.
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const truth = showTask(taskId)!;
    expect(truth.title).toBe("HTTP form task");
    expect(truth.body).toBe("from form");
    expect(truth.assignee).toBe("ralph");
    expect(truth.status).toBe("todo");

    // POST to the edit-task form.
    const editForm = new URLSearchParams();
    editForm.set("body", "updated body");
    const r3 = await fetch(`${BASE_URL}/boards/smoke/tasks/${taskId}/edit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: editForm.toString(),
    });
    expect(r3.status).toBe(200);
    const editResult = (await r3.json()) as { type: string; location: string };
    expect(editResult.type).toBe("redirect");
    expect(editResult.location).toBe(`/boards/smoke/tasks/${taskId}`);

    const updated = showTask(taskId)!;
    expect(updated.body).toBe("updated body");
  }, 60000);

  it("create form rejects missing title and preserves values", async () => {
    await startServer(true);
    await createBoardApi("reject");

    const form = new URLSearchParams();
    form.set("title", "   ");
    form.set("body", "kept");
    const r = await fetch(`${BASE_URL}/boards/reject/tasks/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const result = (await r.json()) as { type: string; status: number; data: string };
    expect(result.type).toBe("failure");
    expect(result.status).toBe(400);
    const data = JSON.parse(result.data) as [{ error: number; values: number; [key: string]: number }, string, { body: number; [key: string]: number | string }, ...unknown[]];
    expect(data[1]).toBe("Title is required.");
    const bodyIndex = data[2].body as number;
    expect(data[bodyIndex]).toBe("kept");
  }, 60000);

  it("form actions reject mutations when FF_SVELTEKIT_FRONTEND is off", async () => {
    // Start a fresh server with the master flag disabled.  The process-tree
    // cleanup above is best-effort; this test gets its own port to avoid any
    // dangling server from earlier tests.
    const offPort = "5195";
    const offBase = `http://localhost:${offPort}`;
    const offHome = `/tmp/kdi-ui004-http-off-${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(offHome, { recursive: true });
    const offProc = Bun.spawn({
      cmd: ["bun", "run", "dev:web", "--port", offPort],
      cwd: WORKTREE_ROOT,
      env: {
        ...process.env,
        HOME: offHome,
        KDI_DB: join(offHome, "kdi.sqlite"),
        FF_SVELTEKIT_FRONTEND: "false",
        VITE_FF_SVELTEKIT_FRONTEND: "false",
        NODE_ENV: "development",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for the disabled server to come up (it will respond to / with a redirect).
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${offBase}/`);
        if (r.status === 307 || r.status === 303 || r.status === 404 || r.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((res) => setTimeout(res, 300));
    }

    // Create a board directly via the model so the API (also gated) is not needed.
    process.env.HOME = offHome;
    process.env.KDI_DB = join(offHome, "kdi.sqlite");
    initDb();
    createBoard("gated", offHome, "origin/main", {});

    // Probe: the API route must also return 503 when the flag is off.
    const probe = await fetch(`${offBase}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "probe", workdir: offHome }),
    });
    expect(probe.status).toBe(503); // bridge gate returns 503 { enabled:false }

    const form = new URLSearchParams();
    form.set("title", "should not create");
    const r1 = await fetch(`${offBase}/boards/gated/tasks/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    const r1Body = (await r1.json()) as { type: string; status: number; location: string };
    expect(r1.status).toBe(200);
    expect(r1Body.type).toBe("redirect");
    expect(r1Body.status).toBe(307);
    expect(r1Body.location).toBe("/disabled");

    const r2 = await fetch(`${offBase}/boards/gated/tasks/1/edit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "should not edit" }).toString(),
      redirect: "manual",
    });
    const r2Body = (await r2.json()) as { type: string; status: number; location: string };
    expect(r2.status).toBe(200);
    expect(r2Body.type).toBe("redirect");
    expect(r2Body.status).toBe(307);
    expect(r2Body.location).toBe("/disabled");

    offProc.kill();
  }, 60000);
});
