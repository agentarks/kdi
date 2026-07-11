// KDI-UI-006 HTTP smoke — proves the lifecycle action routes wire correctly
// under the real dev server and that each mutation lands in the same DB the
// CLI reads (AC-28 single loop, AC-29 bulk, AC-26 master flag). Mirrors the
// KDI-UI-001 harness: spawn `bun run dev:web` against an isolated HOME/KDI_DB.
import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { showTask } from "~/models/task";
import { initDb, closeDb } from "~/db";
import type { BulkLifecycleResult } from "$lib/types";

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
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on :${port} within ${timeoutMs}ms`);
}

async function stopServer(): Promise<void> {
  if (proc) {
    try {
      process.kill(-proc.pid, 9);
      await proc.exited;
    } catch {
      /* already gone */
    }
    proc = null;
  }
  await new Promise((res) => setTimeout(res, 500));
}

async function startServer(enabled: boolean): Promise<void> {
  await stopServer();
  if (!tmpHome) {
    tmpHome = `/tmp/kdi-ui006-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(tmpHome, { recursive: true });
  }
  port = randomPort();
  baseUrl = `http://localhost:${port}`;
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: WORKTREE_ROOT,
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

async function createBoard(slug: string): Promise<void> {
  const r = await fetch(`${baseUrl}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, workdir: tmpHome }),
    signal: AbortSignal.timeout(10000),
  });
  expect(r.status).toBe(201);
}

async function createTask(slug: string, title: string, init?: Record<string, unknown>): Promise<number> {
  const r = await fetch(`${baseUrl}/api/boards/${slug}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, ...init }),
    signal: AbortSignal.timeout(10000),
  });
  expect(r.status).toBe(201);
  const data = (await r.json()) as { task: { id: number } };
  return data.task.id;
}

interface ActionResult {
  result: { taskId: number; status: string; message: string; currentStatus?: string };
}

async function postAction(slug: string, id: number, action: string, fields: Record<string, unknown> = {}): Promise<ActionResult> {
  const r = await fetch(`${baseUrl}/api/boards/${slug}/tasks/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(10000),
  });
  return (await r.json()) as ActionResult;
}

async function postBulk(slug: string, action: string, taskIds: number[], fields: Record<string, unknown> = {}): Promise<BulkLifecycleResult> {
  const r = await fetch(`${baseUrl}/api/boards/${slug}/tasks/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, taskIds, fields }),
    signal: AbortSignal.timeout(10000),
  });
  return (await r.json()) as BulkLifecycleResult;
}

// Read the SAME DB file from this process to cross-check the CLI/model state.
function statusOf(id: number): string | null {
  initDb();
  const t = showTask(id);
  return t ? t.status : null;
}

afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-006 HTTP lifecycle smoke", () => {
  it("per-action endpoints return FR-21 shape {taskId, status, message, currentStatus?}", async () => {
    closeDb();
    await startServer(true);
    await createBoard("shape");
    const id = await createTask("shape", "S");
    const r = await postAction("shape", id, "promote");
    expect(r.result.taskId).toBe(id);
    expect(["success", "skipped", "error"]).toContain(r.result.status);
    expect(typeof r.result.message).toBe("string");
    expect(r.result.currentStatus).toBe("ready");
    await stopServer();
  }, 60000);

  it("AC-28 single-task lifecycle loop, state matches the DB", async () => {
    closeDb();
    await startServer(true);
    await createBoard("lc");

    // promote todo → ready
    const promote = await createTask("lc", "P");
    expect((await postAction("lc", promote, "promote")).result.status).toBe("success");

    // block (reason) → blocked
    const blocked = await createTask("lc", "B");
    await postAction("lc", blocked, "promote");
    const br = await postAction("lc", blocked, "block", { reason: "waiting on dep" });
    expect(br.result.status).toBe("success");

    // unblock blocked → todo
    const ur = await postAction("lc", blocked, "unblock");
    expect(ur.result.status).toBe("success");

    // schedule → scheduled
    const sched = await createTask("lc", "S");
    const future = Math.floor(Date.now() / 1000) + 3600;
    const sr = await postAction("lc", sched, "schedule", { at: future, reason: "later" });
    expect(sr.result.status).toBe("success");

    // review → review
    const rev = await createTask("lc", "R");
    await postAction("lc", rev, "promote");
    const rr = await postAction("lc", rev, "review", { reason: "pls" });
    expect(rr.result.status).toBe("success");

    // assign
    const ar = await postAction("lc", rev, "assign", { profile: "ralph" });
    expect(ar.result.status).toBe("success");

    // claim ready → running
    const claimed = await createTask("lc", "C", { initialStatus: "ready" });
    const cr = await postAction("lc", claimed, "claim", { ttl: 600 });
    expect(cr.result.status).toBe("success");

    // heartbeat on the running task
    const hr = await postAction("lc", claimed, "heartbeat", { note: "alive" });
    expect(hr.result.status).toBe("success");

    // complete → done
    const cmp = await postAction("lc", claimed, "complete", { result: "ok", summary: "fin" });
    expect(cmp.result.status).toBe("success");

    // archive → archived
    const avr = await postAction("lc", claimed, "archive");
    expect(avr.result.status).toBe("success");

    // Stop server, then cross-check state from the same DB the CLI would read.
    await stopServer();
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    expect(statusOf(promote)).toBe("ready");
    expect(statusOf(blocked)).toBe("todo");
    expect(statusOf(sched)).toBe("scheduled");
    expect(statusOf(rev)).toBe("review");
    // claimed task was completed then archived → archived_at set, showTask returns null
    closeDb();
  }, 90000);

  it("AC-29 bulk actions report per-task results + summary", async () => {
    closeDb();
    await startServer(true);
    await createBoard("bulk");

    const ids = await Promise.all([
      createTask("bulk", "t1"),
      createTask("bulk", "t2"),
      createTask("bulk", "t3", { initialStatus: "ready" }), // wrong status for promote
    ]);

    const promoted = await postBulk("bulk", "promote", ids);
    expect(promoted.summary.succeeded).toBe(2);
    expect(promoted.summary.skipped).toBe(1);
    expect(promoted.results).toHaveLength(3);

    const blocked = await postBulk("bulk", "block", ids, { reason: "bulk block" });
    // the two promoted are ready, not blocked → blockable; the ready one too
    expect(blocked.summary.succeeded).toBe(3);

    const unblocked = await postBulk("bulk", "unblock", ids);
    expect(unblocked.summary.succeeded).toBe(3);

    const archived = await postBulk("bulk", "archive", ids);
    expect(archived.summary.succeeded).toBe(3);

    await stopServer();
  }, 90000);

  it("AC-26 master flag off → actions unavailable (503), no mutation", async () => {
    closeDb();
    await startServer(true);
    await createBoard("gate");
    const id = await createTask("gate", "G");

    await stopServer();
    await startServer(false);

    const r = await fetch(`${baseUrl}/api/boards/gate/tasks/${id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);

    await stopServer();
    // Task must still exist (not archived) — verify against the DB.
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const t = showTask(id);
    expect(t).not.toBeNull();
    expect(t!.status).toBe("todo");
    expect(t!.archived_at).toBeNull();
    closeDb();
  }, 90000);
});
