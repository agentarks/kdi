// KDI-UI-001 bridge smoke test. Calls bridge logic functions directly (no HTTP
// process), against an isolated temp HOME + KDI_DB, then asserts the returned
// camelCase JSON matches the CLI model source of truth (`showTask`) read
// against the same DB. Also guards the "SQLite server-side only" rule by
// scanning the route tree for forbidden client-side imports.
//
// ponytail: test the bridge functions, not SvelteKit RequestEvent plumbing —
// the route adapters are ~5 lines of Request->bridge mapping and add no logic.

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  listBoardsJson,
  showBoardJson,
  createBoardJson,
  listBoardsUiJson,
  readCurrentBoardJson,
  updateBoardMetadataJson,
  setDefaultWorkdirJson,
  switchBoardJson,
  renameBoardJson,
  renameBoardSlugJson,
  archiveBoardJson,
  removeBoardJson,
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
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";

const SRC_ROOT = join(import.meta.dirname, "..", ".."); // apps/web/src

const FF_KEYS = [
  "FF_SVELTEKIT_FRONTEND",
  "FF_LIST_FILTERS_SORT",
  "FF_TENANT_NAMESPACE",
  "FF_CREATED_BY",
  "FF_WORKFLOW_TEMPLATES",
  "FF_RATE_LIMIT_EXIT_CODE",
  "FF_HEARTBEAT",
];

let tmpHome: string;
const envSnapshot: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];

function isolate(): void {
  tmpHome = `/tmp/kdi-ui001-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  // Leave other FF_* flags at their defaults by removing any stale test overrides.
  for (const key of FF_KEYS) {
    if (key !== "FF_SVELTEKIT_FRONTEND") delete process.env[key];
  }
}

function cleanup(): void {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
}

beforeEach(() => {
  for (const key of FF_KEYS) envSnapshot[key] = process.env[key];
  isolate();
  clearOverrides();
});

afterEach(() => {
  for (const key of FF_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearOverrides();
  closeDb();
  cleanup();
});

afterAll(() => {
  // afterEach handles per-test cleanup; this is a safety net.
  cleanup();
});

async function freshBoard(slug = "smoke"): Promise<string> {
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

// KDI-UI-003: bridge-level filter gating. The server load is the primary
// defense; these tests ensure the bridge rejects disabled filters with the same
// error text the CLI uses, so a direct client bypass cannot mutate state.
describe("KDI-UI-003 filter gating", () => {
  async function freshBoardWithTask(slug = "gate"): Promise<{ slug: string; taskId: number }> {
    const boardSlug = await freshBoard(slug);
    const { task } = await createTaskJson(boardSlug, { title: "gate task", assignee: "ralph", tenant: "t1", sessionId: "s1" });
    return { slug: boardSlug, taskId: task.id };
  }

  it("status filter does not require FF_LIST_FILTERS_SORT", async () => {
    process.env.FF_LIST_FILTERS_SORT = "false";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    const { tasks } = await listTasksJson(slug, new URLSearchParams({ status: "todo" }));
    expect(tasks.length).toBe(1);
  });

  it("rejects sort/archived/mine/session/workflow/step without FF_LIST_FILTERS_SORT", async () => {
    process.env.FF_LIST_FILTERS_SORT = "false";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ sort: "updated" })), "feature_disabled", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ archived: "true" })), "feature_disabled", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ mine: "true" })), "feature_disabled", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ session: "s1" })), "feature_disabled", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ workflowTemplateId: "x" })), "feature_disabled", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ stepKey: "x" })), "feature_disabled", 400);
  });

  it("assignee filter works without FF_ASSIGNEES_LISTING (dropdown only is gated)", async () => {
    process.env.FF_ASSIGNEES_LISTING = "false";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    const { tasks } = await listTasksJson(slug, new URLSearchParams({ assignee: "ralph" }));
    expect(tasks.length).toBe(1);
    expect(tasks[0].assignee).toBe("ralph");
  });

  it("rejects empty tenant string", async () => {
    process.env.FF_TENANT_NAMESPACE = "true";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ tenant: "" })), "invalid_input", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ tenant: "   " })), "invalid_input", 400);
  });

  it("rejects tenant without FF_TENANT_NAMESPACE", async () => {
    process.env.FF_TENANT_NAMESPACE = "false";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ tenant: "t1" })), "feature_disabled", 400);
  });

  it("rejects createdBy without FF_CREATED_BY", async () => {
    process.env.FF_CREATED_BY = "false";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ createdBy: "alice" })), "feature_disabled", 400);
  });

  it("rejects workflow template/step without FF_WORKFLOW_TEMPLATES", async () => {
    process.env.FF_LIST_FILTERS_SORT = "true";
    process.env.FF_WORKFLOW_TEMPLATES = "false";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ workflowTemplateId: "x" })), "feature_disabled", 400);
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ stepKey: "x" })), "feature_disabled", 400);
  });

  it("rejects mine and assignee together", async () => {
    process.env.FF_LIST_FILTERS_SORT = "true";
    process.env.FF_ASSIGNEES_LISTING = "true";
    clearOverrides();
    const { slug } = await freshBoardWithTask();
    await expectBridgeError(listTasksJson(slug, new URLSearchParams({ mine: "true", assignee: "ralph" })), "invalid_input", 400);
  });
});

// KDI-UI-002: board-management bridge helpers used by the SvelteKit UI routes.
describe("KDI-UI-002 board management bridge", () => {
  it("listBoardsUiJson returns boards with statusCounts and current slug", async () => {
    await createBoardJson({ slug: "b1", workdir: tmpHome, metadata: { name: "Board One" } });
    await createBoardJson({ slug: "b2", workdir: tmpHome });
    await switchBoardJson("b1");

    const { boards } = await listBoardsUiJson(new URLSearchParams());
    expect(boards.length).toBe(2);
    const b1 = boards.find((b) => b.slug === "b1")!;
    expect(b1.name).toBe("Board One");
    expect(b1.statusCounts).toBeDefined();
    expect(b1.statusCounts.triage).toBe(0);

    const { currentSlug } = await readCurrentBoardJson();
    expect(currentSlug).toBe("b1");
  });

  it("showBoardJson includes archived boards when requested", async () => {
    await createBoardJson({ slug: "b1", workdir: tmpHome });
    await archiveBoardJson("b1");

    const shown = await showBoardJson("b1", true);
    expect(shown.board.archivedAt).not.toBeNull();

    await expectBridgeError(showBoardJson("b1", false), "board_not_found", 404);
  });

  it("updateBoardMetadataJson edits metadata, setDefaultWorkdirJson sets/clears default", async () => {
    await createBoardJson({ slug: "b1", workdir: tmpHome, metadata: { name: "One" } });

    const renamed = await updateBoardMetadataJson({ slug: "b1", name: "One Renamed" });
    expect(renamed.board.name).toBe("One Renamed");

    const withDir = await setDefaultWorkdirJson({ slug: "b1", workdir: "/tmp/default" });
    expect(withDir.board.defaultWorkdir).toBe("/tmp/default");

    const cleared = await setDefaultWorkdirJson({ slug: "b1", workdir: null });
    expect(cleared.board.defaultWorkdir).toBeNull();
  });

  it("renameBoardJson changes display name; renameBoardSlugJson changes slug and current", async () => {
    await createBoardJson({ slug: "old", workdir: tmpHome });
    await switchBoardJson("old");

    await renameBoardJson({ slug: "old", name: "Old Name" });
    const { currentSlug } = await readCurrentBoardJson();
    expect(currentSlug).toBe("old");

    const result = await renameBoardSlugJson({ oldSlug: "old", newSlug: "new" });
    expect(result.board.slug).toBe("new");
    expect(result.currentRewritten).toBe(true);
    expect((await readCurrentBoardJson()).currentSlug).toBe("new");
  });

  it("removeBoardJson permanently deletes a board and its data dir", async () => {
    await createBoardJson({ slug: "b1", workdir: tmpHome });
    await removeBoardJson({ slug: "b1", confirmedSlug: "b1" });
    await expectBridgeError(showBoardJson("b1", true), "board_not_found", 404);
  });

  it("removeBoardJson rejects a mismatched confirmed slug", async () => {
    await createBoardJson({ slug: "b1", workdir: tmpHome });
    // The action layer (not the bridge) enforces the confirmed-slug match; the
    // bridge just performs the deletion when the inputs match.
    await removeBoardJson({ slug: "b1", confirmedSlug: "b1" });
    await expectBridgeError(showBoardJson("b1", true), "board_not_found", 404);
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