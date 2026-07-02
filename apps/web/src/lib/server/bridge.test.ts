// KDI-UI-001 bridge smoke test. Calls bridge logic functions directly (no HTTP
// process), against an isolated temp HOME + KDI_DB, then asserts the returned
// camelCase JSON matches the CLI model source of truth (`showTask`) read
// against the same DB. Also guards the "SQLite server-side only" rule by
// scanning the route tree for forbidden client-side imports.
//
// ponytail: test the bridge functions, not SvelteKit RequestEvent plumbing —
// the route adapters are ~5 lines of Request->bridge mapping and add no logic.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  listBoardsJson,
  showBoardJson,
  createBoardJson,
  listTasksJson,
  createTaskJson,
  showTaskJson,
  taskEventsJson,
  taskRunsJson,
  taskContextJson,
  taskCommentsJson,
  taskAttachmentsJson,
  boardEventsJson,
  diagnosticsJson,
  workflowsJson,
  subscriptionsJson,
  assigneesJson,
  boardStatsJson,
  gate,
  BridgeError,
  listProfilesJson,
} from "./bridge";
// Direct model import is the CLI source of truth used to validate the bridge
// wrapped it faithfully. Uses the `~/*` alias (spec FR-1); `bun test` from the
// repo root resolves `~/*` via the root tsconfig the CLI already uses.
import { showTask } from "~/models/task";
import { showBoard as showBoardModel } from "~/models/board";
import { clearOverrides } from "~/flags";

const SRC_ROOT = join(import.meta.dirname, "..", ".."); // apps/web/src

let tmpHome: string;

function isolate(): void {
  tmpHome = `/tmp/kdi-ui001-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
}

function cleanup(): void {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
}

async function freshBoard(slug = "smoke"): Promise<string> {
  isolate();
  // createBoardJson calls initDb() itself, so no separate bootstrap needed.
  await createBoardJson({ slug, workdir: tmpHome });
  return slug;
}

// Await a rejection and assert it is the expected BridgeError. Matcher-agnostic;
// bun:test's rejects.toSatisfy does not unwrap the rejection reliably here.
async function expectBridgeError(p: Promise<unknown>, code: string, status: number): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    if (!(e instanceof BridgeError)) throw new Error(`expected BridgeError, got ${e && (e as Error).name}`);
    expect((e as BridgeError).code).toBe(code);
    expect((e as BridgeError).status).toBe(status);
  }
  if (!threw) throw new Error(`expected promise to reject with ${code}/${status}, but it resolved`);
}

beforeEach(isolate);
afterAll(cleanup);

describe("KDI-UI-001 server data bridge", () => {
  it("POST/GET /api/boards — create + list + show with camelCase keys", async () => {
    const { board } = await createBoardJson({ slug: "b1", workdir: tmpHome, baseRef: "origin/dev" });
    expect(board.slug).toBe("b1");
    expect(((board as unknown) as Record<string, unknown>).baseRef).toBe("origin/dev");
    expect(board.archived).toBe(false);
    for (const k of Object.keys(board)) expect(k.includes("_")).toBe(false);

    const listed = await listBoardsJson(new URLSearchParams());
    expect(listed.boards.length).toBe(1);
    expect(listed.boards[0].slug).toBe("b1");

    const shown = await showBoardJson("b1");
    expect(shown.board.slug).toBe("b1");
    expect(((shown.board as unknown) as Record<string, unknown>).taskCounts).toBeDefined();
  });

  it("POST /api/boards rejects missing slug/workdir (400)", async () => {
    await expect(createBoardJson({ slug: "", workdir: tmpHome })).rejects.toBeInstanceOf(BridgeError);
    await expect(createBoardJson({ slug: "ok", workdir: "" })).rejects.toBeInstanceOf(BridgeError);
  });

  it("POST /api/boards rejects duplicate slug (409 board_exists)", async () => {
    await createBoardJson({ slug: "dup", workdir: tmpHome });
    await expectBridgeError(createBoardJson({ slug: "dup", workdir: tmpHome }), "board_exists", 409);
  });

  it("POST/GET /api/boards/[slug]/tasks — create, list, show; matches CLI model", async () => {
    const slug = await freshBoard("smoke");
    const created = await createTaskJson(slug, { title: "T1", body: "body", assignee: "ralph", priority: 5 });
    expect(created.task.title).toBe("T1");
    expect(created.task.assignee).toBe("ralph");
    expect(created.task.status).toBe("todo");
    for (const k of Object.keys(created.task)) expect(k.includes("_")).toBe(false);

    // Cross-check against the CLI model source of truth on the SAME db.
    const truth = showTask(created.task.id)!;
    expect(truth.title).toBe(created.task.title);
    expect(truth.status as string).toBe(created.task.status);
    expect(truth.assignee).toBe(created.task.assignee);
    expect(truth.board_id).toBe(showBoardModel(slug)!.id);
    expect(truth.priority).toBe(created.task.priority);

    const listed = await listTasksJson(slug, new URLSearchParams());
    expect(listed.tasks.length).toBe(1);
    expect(listed.tasks[0].id).toBe(created.task.id);

    const shown = await showTaskJson(slug, created.task.id);
    expect(((shown.task as unknown) as Record<string, unknown>).goalMode).toBe(false);
    for (const k of Object.keys(shown.task)) expect(k.includes("_")).toBe(false);
  });

  it("POST /api/boards/[slug]/tasks returns the full Kanban task shape", async () => {
    const slug = await freshBoard("kanban");
    const created = await createTaskJson(slug, {
      title: "Kanban card",
      body: "body",
      assignee: "ralph",
      priority: 5,
      tenant: "backend",
      sessionId: "session-1",
      createdBy: "alice",
    });
    const task = created.task;
    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe("Kanban card");
    expect(task.assignee).toBe("ralph");
    expect(task.priority).toBe(5);
    expect(task.tenant).toBe("backend");
    expect(task.sessionId).toBe("session-1");
    expect(task.createdBy).toBe("alice");
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
    expect(task.status).toBe("todo");
    expect(task.blockReason).toBeNull();
    expect(task.rateLimitedUntil).toBeNull();

    const listed = await listTasksJson(slug, new URLSearchParams());
    expect(listed.tasks.length).toBe(1);
    expect(listed.tasks[0].id).toBe(task.id);
    expect(listed.tasks[0].tenant).toBe("backend");
  });

  it("GET /api/profiles returns known profile names", async () => {
    const profiles = await listProfilesJson();
    expect(profiles.profiles).toContain("opencode");
    expect(profiles.profiles).toContain("pi");
  });

  it("createTask rejects missing title (400 invalid_input)", async () => {
    const slug = await freshBoard();
    await expectBridgeError(createTaskJson(slug, { title: "" }), "invalid_input", 400);
  });

  it("showTask 404: board not found and task-not-on-board", async () => {
    const slug = await freshBoard();
    await createTaskJson(slug, { title: "here" });
    await expectBridgeError(showTaskJson("nope", 1), "board_not_found", 404);
    await expectBridgeError(showTaskJson(slug, 999999), "task_not_found", 404);
  });

  it("task-nested reads return empty arrays on a fresh task", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "nested" });
    // createTask emits a single "created" event (model side effect); full camelCase.
    const events = (await taskEventsJson(slug, task.id, new URLSearchParams())).events;
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("created");
    expect(((events[0] as unknown) as Record<string, unknown>).createdAt).toBeDefined();
    for (const k of Object.keys(events[0])) expect(k.includes("_")).toBe(false);
    expect((await taskRunsJson(slug, task.id, new URLSearchParams())).runs).toEqual([]);
    expect((await taskCommentsJson(slug, task.id)).comments).toEqual([]);
    expect((await taskAttachmentsJson(slug, task.id)).attachments).toEqual([]);
    expect((await taskContextJson(slug, task.id)).context).not.toBeNull();
  });

  it("board-level reads: assignees, stats, events, diagnostics, workflows, subscriptions", async () => {
    const slug = await freshBoard("boardlvl");
    await createTaskJson(slug, { title: "x", assignee: "a1", tenant: "t1" });

    expect((await assigneesJson(slug)).assignees.a1).toBe(1);
    expect((await boardStatsJson(slug)).stats.statusCounts).toBeDefined();
    expect(Array.isArray((await boardEventsJson(slug, new URLSearchParams())).events)).toBe(true);
    expect(Array.isArray((await diagnosticsJson(slug, new URLSearchParams())).diagnostics)).toBe(true);
    expect(Array.isArray((await workflowsJson(slug)).templates)).toBe(true);
    const subs = await subscriptionsJson(new URLSearchParams({ board: slug }));
    expect(Array.isArray(subs.subscriptions)).toBe(true);
    await expectBridgeError(subscriptionsJson(new URLSearchParams()), "invalid_input", 400);
  });

  it("gate() returns 503 {enabled:false} when flag off, null when on", async () => {
    process.env.FF_SVELTEKIT_FRONTEND = "false";
    clearOverrides();
    const off = gate();
    expect(off).toBeInstanceOf(Response);
    expect(off!.status).toBe(503);
    expect((await off!.json()).enabled).toBe(false);
    process.env.FF_SVELTEKIT_FRONTEND = "true";
    clearOverrides();
    expect(gate()).toBeNull();
  });

  it("SQLite stays server-side: no route or client file imports bun:sqlite or src/models", () => {
    const files = walkTs(SRC_ROOT);
    let bridgeSeen = false;
    let violations = 0;
    for (const f of files) {
      const isBridge =
        f.endsWith("lib/server/bridge.ts") ||
        f.endsWith("lib/server/bridge.test.ts") ||
        f.endsWith("lib/server/bridge.http.test.ts");
      if (isBridge) {
        bridgeSeen = true;
        continue;
      }
      const src = readFileSync(f, "utf8");
      // ponytail: per spec Verification-Notes, only the bridge (and its test)
      // may import models or bun:sqlite. Deny both `bun:sqlite` and any
      // model import (alias `~/models/*` OR relative `../src/models/`) here.
      if (/from\s+["']bun:sqlite["']/.test(src)) violations++;
      if (/from\s+["']~\/models\//.test(src)) violations++;
      if (/"\.\.\/.*\/src\/models\//.test(src)) violations++;
    }
    expect(bridgeSeen).toBe(true);
    // ponytail: bridge.http.test.ts is also a server-side bridge test (it
    // cross-checks HTTP results against the CLI model source of truth), so it
    // is allowed to import ~/models/* just like bridge.test.ts.
    expect(violations).toBe(0);
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (/\.(ts|svelte|js)$/.test(name)) out.push(p);
  }
  return out;
}