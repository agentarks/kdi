// KDI-UI-006 AC-28/AC-29: task lifecycle actions UI smoke test.
//
// Drives the full single-task lifecycle over HTTP (per-action endpoints),
// cross-checking EACH state transition against `kdi show` CLI output on the
// same isolated HOME + KDI_DB. Then a bulk-action pass with
// FF_BULK_OPERATIONS=true.
//
// Pattern copied from board-management.http.test.ts + bridge.http.test.ts:
// spawn `bun run dev:web` against temp HOME + temp KDI_DB, use execSync for
// CLI cross-checks.
import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "~/db";
import { createBoardJson } from "./bridge";

// apps/web/src/lib/server → repo root is five dirs up.
const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;
let port: string;
let baseUrl: string;

const kdiEnv = (): Record<string, string> => ({
  HOME: tmpHome,
  KDI_DB: join(tmpHome, "kdi.sqlite"),
  FF_SVELTEKIT_FRONTEND: "true",
  VITE_FF_SVELTEKIT_FRONTEND: "true",
  FF_BULK_OPERATIONS: "true",
  FF_SCHEDULED_STATUS: "true",
  FF_REVIEW_STATUS: "true",
  FF_COMPLETE_METADATA: "true",
  FF_ASSIGN_REASSIGN: "true",
  FF_HEARTBEAT: "true",
});

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
    try { process.kill(-proc.pid, 9); await proc.exited; } catch { /* already gone */ }
    proc = null;
  }
  await new Promise((res) => setTimeout(res, 500));
}

async function startServer(flags: Record<string, string> = {}): Promise<void> {
  await stopServer();
  port = String(50000 + Math.floor(Math.random() * 15000));
  baseUrl = `http://localhost:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: WORKTREE_ROOT,
    detached: true,
    env: { ...process.env, ...kdiEnv(), ...flags, NODE_ENV: "development" },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitAlive();
}

function runKdi(args: string): string {
  return execSync(`bun ${join(WORKTREE_ROOT, "src/index.ts")} ${args}`, {
    encoding: "utf-8",
    cwd: WORKTREE_ROOT,
    env: { ...process.env, ...kdiEnv() },
    timeout: 30000,
  }).trim();
}

function showStatus(id: number): string {
  const out = runKdi(`show ${id}`);
  const match = out.match(/^Status:\s*(\S+)/m);
  if (!match) throw new Error(`Could not parse Status from kdi show:\n${out}`);
  return match[1];
}

function showAssignee(id: number): string | null {
  const out = runKdi(`show ${id}`);
  const match = out.match(/^Assignee:\s*(\S+)/m);
  return match ? match[1] : null;
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

interface BulkResult {
  results: Array<{ taskId: number; status: string; message: string }>;
  summary: { attempted: number; succeeded: number; skipped: number; failed: number };
}

async function postBulk(slug: string, action: string, taskIds: number[], fields: Record<string, unknown> = {}): Promise<BulkResult> {
  const r = await fetch(`${baseUrl}/api/boards/${slug}/tasks/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, taskIds, fields }),
    signal: AbortSignal.timeout(10000),
  });
  return (await r.json()) as BulkResult;
}

afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-006 AC-28 single-task lifecycle over HTTP, cross-checked with kdi show", () => {
  it("promote→block→unblock→schedule→review→assign→claim→heartbeat→complete→archive, each state verified via kdi show", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui006-http-"));
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    await createBoardJson({ slug: "lc", workdir: tmpHome });
    closeDb();

    await startServer();

    // --- promote: todo → ready ---
    const promoteId = await createTask("lc", "Promote task");
    expect((await postAction("lc", promoteId, "promote")).result.status).toBe("success");
    expect(showStatus(promoteId)).toBe("ready");

    // --- block: ready → blocked ---
    const blockId = await createTask("lc", "Block task");
    await postAction("lc", blockId, "promote");
    expect((await postAction("lc", blockId, "block", { reason: "waiting on dep" })).result.status).toBe("success");
    expect(showStatus(blockId)).toBe("blocked");

    // --- unblock: blocked → todo ---
    expect((await postAction("lc", blockId, "unblock")).result.status).toBe("success");
    expect(showStatus(blockId)).toBe("todo");

    // --- schedule: todo → scheduled ---
    const schedId = await createTask("lc", "Schedule task");
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect((await postAction("lc", schedId, "schedule", { at: future, reason: "later" })).result.status).toBe("success");
    expect(showStatus(schedId)).toBe("scheduled");

    // --- review: promote then review ---
    const reviewId = await createTask("lc", "Review task");
    await postAction("lc", reviewId, "promote");
    expect((await postAction("lc", reviewId, "review", { reason: "pls check" })).result.status).toBe("success");
    expect(showStatus(reviewId)).toBe("review");

    // --- assign: set assignee ---
    expect((await postAction("lc", reviewId, "assign", { profile: "ralph" })).result.status).toBe("success");
    expect(showAssignee(reviewId)).toBe("ralph");

    // --- claim: ready → running ---
    const claimId = await createTask("lc", "Claim task", { initialStatus: "ready" });
    expect((await postAction("lc", claimId, "claim", { ttl: 600 })).result.status).toBe("success");
    expect(showStatus(claimId)).toBe("running");

    // --- heartbeat on running task ---
    expect((await postAction("lc", claimId, "heartbeat", { note: "alive" })).result.status).toBe("success");

    // --- complete: running → done ---
    expect((await postAction("lc", claimId, "complete", { result: "ok", summary: "fin" })).result.status).toBe("success");
    expect(showStatus(claimId)).toBe("done");

    // --- archive: done → archived ---
    expect((await postAction("lc", claimId, "archive")).result.status).toBe("success");
    // kdi show on archived task exits 1; verify via list --archived
    const listOut = runKdi("list --board lc --archived");
    expect(listOut).toContain(String(claimId));

    await stopServer();
  }, 120000);
});

describe("KDI-UI-006 AC-29 bulk actions over HTTP with FF_BULK_OPERATIONS=true", () => {
  it("bulk promote→block→unblock→complete→archive with per-task results and summary", async () => {
    if (!tmpHome) {
      tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui006-http-"));
      process.env.HOME = tmpHome;
      process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
      initDb();
      await createBoardJson({ slug: "bulk", workdir: tmpHome });
      closeDb();
    } else {
      initDb();
      await createBoardJson({ slug: "bulk", workdir: tmpHome });
      closeDb();
    }

    await startServer();

    const ids = await Promise.all([
      createTask("bulk", "t1"),
      createTask("bulk", "t2"),
      createTask("bulk", "t3", { initialStatus: "ready" }), // wrong status for promote
    ]);

    // --- bulk promote: 2 succeed, 1 skipped ---
    const promoted = await postBulk("bulk", "promote", ids);
    expect(promoted.summary.succeeded).toBe(2);
    expect(promoted.summary.skipped).toBe(1);
    expect(promoted.results).toHaveLength(3);
    expect(showStatus(ids[0])).toBe("ready");
    expect(showStatus(ids[1])).toBe("ready");

    // --- bulk block: all 3 ---
    const blocked = await postBulk("bulk", "block", ids, { reason: "bulk block" });
    expect(blocked.summary.succeeded).toBe(3);
    expect(showStatus(ids[0])).toBe("blocked");

    // --- bulk unblock: all 3 ---
    const unblocked = await postBulk("bulk", "unblock", ids);
    expect(unblocked.summary.succeeded).toBe(3);

    // --- bulk schedule: all 3 to same future time ---
    const future = Math.floor(Date.now() / 1000) + 7200;
    const scheduled = await postBulk("bulk", "schedule", ids, { at: future, reason: "later" });
    expect(scheduled.summary.succeeded).toBe(3);
    expect(showStatus(ids[0])).toBe("scheduled");

    // --- bulk unblock scheduled → ready ---
    const unblocked2 = await postBulk("bulk", "unblock", ids);
    expect(unblocked2.summary.succeeded).toBe(3);

    // --- bulk complete: all 3 ---
    const completed = await postBulk("bulk", "complete", ids, { result: "done" });
    expect(completed.summary.succeeded).toBe(3);
    expect(showStatus(ids[0])).toBe("done");

    // --- bulk archive: all 3 ---
    const archived = await postBulk("bulk", "archive", ids);
    expect(archived.summary.succeeded).toBe(3);

    await stopServer();
  }, 120000);
});

describe("KDI-UI-006 AC-26 master flag off → 503, no mutation", () => {
  it("POST action returns 503 when FF_SVELTEKIT_FRONTEND=false; task unchanged", async () => {
    if (!tmpHome) {
      tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui006-http-"));
      process.env.HOME = tmpHome;
      process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
      initDb();
      await createBoardJson({ slug: "gate", workdir: tmpHome });
      closeDb();
    } else {
      initDb();
      await createBoardJson({ slug: "gate", workdir: tmpHome });
      closeDb();
    }

    // Start with flag ON to create board + task.
    await startServer();
    const id = await createTask("gate", "G");
    await stopServer();

    // Restart with flag OFF.
    await startServer({ FF_SVELTEKIT_FRONTEND: "false", VITE_FF_SVELTEKIT_FRONTEND: "false" });

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

    // Task must still be todo (not archived).
    expect(showStatus(id)).toBe("todo");
  }, 120000);
});
