// KDI-UI-006 task lifecycle actions bridge — single + bulk.
// Exercises every action's success/skip/error mapping, server-side flag gates,
// preconditions, and bulk summary counts against an isolated HOME/KDI_DB.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  performTaskAction,
  performBulkAction,
  lifecycleFlags,
  createBoardJson,
  createTaskJson,
  BridgeError,
} from "./bridge";
import { addDependency } from "~/models/dependency";
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";
import type { LifecycleAction, LifecycleResult } from "$lib/types";

const FF_KEYS = [
  "FF_SVELTEKIT_FRONTEND",
  "FF_BULK_OPERATIONS",
  "FF_SCHEDULED_STATUS",
  "FF_REVIEW_STATUS",
  "FF_COMPLETE_METADATA",
  "FF_ASSIGN_REASSIGN",
  "FF_HEARTBEAT",
];

let tmpHome: string;
const tmpDirs: string[] = [];
const envSnapshot: Record<string, string | undefined> = {};

function isolate(): void {
  tmpHome = `/tmp/kdi-ui006-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  // All lifecycle flags default ON in the registry; tests toggle specific ones off.
  process.env.FF_SVELTEKIT_FRONTEND = "true";
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

afterAll(() => cleanup());

async function freshBoard(slug = "lc-smoke"): Promise<string> {
  await createBoardJson({ slug, workdir: tmpHome });
  return slug;
}

async function expectBridgeError(p: Promise<unknown>, code: string, status: number): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(BridgeError);
    const be = err as BridgeError;
    expect(be.code).toBe(code);
    expect(be.status).toBe(status);
  }
  expect(threw).toBe(true);
}

// Toggle a flag OFF for one test body (env var wins over registry + overrides).
function flagOff(name: string): void {
  process.env[name] = "false";
}

async function act(slug: string, id: number, action: LifecycleAction, fields: Record<string, unknown> = {}): Promise<LifecycleResult> {
  const { result } = await performTaskAction(slug, id, action, fields);
  return result;
}

describe("KDI-UI-006 lifecycle flags", () => {
  it("exposes the capability map", () => {
    const f = lifecycleFlags();
    expect(f.bulkOperations).toBe(true);
    expect(f.scheduledStatus).toBe(true);
    expect(f.reviewStatus).toBe(true);
    expect(f.completeMetadata).toBe(true);
    expect(f.assignReassign).toBe(true);
    expect(f.heartbeat).toBe(true);
  });
});

describe("KDI-UI-006 single-task actions", () => {
  it("AC-01 promote: todo → ready", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "P" });
    const r = await act(slug, task.id, "promote");
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("ready");
    expect(r.message).toContain("Promoted");
  });

  it("AC-02 promote wrong_status skip carries current status", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "P", initialStatus: "ready" });
    const r = await act(slug, task.id, "promote");
    expect(r.status).toBe("skipped");
    expect(r.message).toContain("wrong_status");
    expect(r.message).toContain("ready");
    expect(r.currentStatus).toBe("ready");
  });

  it("AC-03 promote dry-run returns would_promote without mutating", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "P" });
    const r = await act(slug, task.id, "promote", { dryRun: true });
    expect(r.status).toBe("success");
    expect(r.message).toContain("would promote");
    // second dry-run still would_promote → not mutated
    const r2 = await act(slug, task.id, "promote", { dryRun: true });
    expect(r2.status).toBe("success");
  });

  it("AC-04 promote force bypasses parent dependency", async () => {
    const slug = await freshBoard();
    const { task: parent } = await createTaskJson(slug, { title: "parent" });
    const { task: child } = await createTaskJson(slug, { title: "child" });
    addDependency(parent.id, child.id); // parent not done → blocks child
    const blocked = await act(slug, child.id, "promote");
    expect(blocked.status).toBe("skipped");
    expect(blocked.message).toBe("blocked_by_dependencies");
    const forced = await act(slug, child.id, "promote", { force: true });
    expect(forced.status).toBe("success");
    expect(forced.currentStatus).toBe("ready");
  });

  it("AC-06 block sets blocked status; AC-07 already-blocked skips", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "B" });
    const r = await act(slug, task.id, "block", { reason: "waiting" });
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("blocked");
    const again = await act(slug, task.id, "block", { reason: "x" });
    expect(again.status).toBe("skipped");
    expect(again.message).toContain("already blocked");
  });

  it("block requires a reason", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "B" });
    await expectBridgeError(act(slug, task.id, "block", {}), "invalid_input", 400);
  });

  it("AC-09 unblock: blocked → todo, scheduled → ready", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "U" });
    await act(slug, task.id, "block", { reason: "x" });
    const r = await act(slug, task.id, "unblock");
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("todo");

    // scheduled → ready
    const { task: s } = await createTaskJson(slug, { title: "S", initialStatus: "scheduled", scheduledAt: Math.floor(Date.now() / 1000) + 3600 });
    const r2 = await act(slug, s.id, "unblock");
    expect(r2.status).toBe("success");
    expect(r2.currentStatus).toBe("ready");
  });

  it("AC-11 schedule sets scheduled status; past time rejected", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "S" });
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = await act(slug, task.id, "schedule", { at: future, reason: "later" });
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("scheduled");
    expect(r.message).toContain(new Date(future * 1000).toISOString());

    const { task: t2 } = await createTaskJson(slug, { title: "S2" });
    await expectBridgeError(act(slug, t2.id, "schedule", { at: 1 }), "invalid_input", 400);
  });

  it("AC-13 review sets review status", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "R" });
    const r = await act(slug, task.id, "review", { reason: "pls check" });
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("review");
  });

  it("AC-14 archive sets archived status", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "A" });
    const r = await act(slug, task.id, "archive");
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("archived");
  });

  it("AC-16 complete with result/summary/metadata", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "C" });
    const r = await act(slug, task.id, "complete", { result: "ok", summary: "done", metadata: '{"k":1}' });
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("done");
  });

  it("AC-19 assign + none unassigns", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "AS" });
    const r = await act(slug, task.id, "assign", { profile: "ralph" });
    expect(r.status).toBe("success");
    expect(r.message).toContain("ralph");
    const r2 = await act(slug, task.id, "assign", { profile: "none" });
    expect(r2.status).toBe("success");
    expect(r2.message).toContain("Unassigned");
  });

  it("AC-20 reassign with reclaim on a running task", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "RE", initialStatus: "ready" });
    await act(slug, task.id, "claim");
    const r = await act(slug, task.id, "reassign", { profile: "opencode", reclaim: true, reason: "swap" });
    expect(r.status).toBe("success");
  });

  it("AC-21 claim ready → running", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "CL", initialStatus: "ready" });
    const r = await act(slug, task.id, "claim", { ttl: 600 });
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("running");
  });

  it("AC-22 reclaim running → ready", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "RC", initialStatus: "ready" });
    await act(slug, task.id, "claim");
    const r = await act(slug, task.id, "reclaim", { reason: "manual" });
    expect(r.status).toBe("success");
    expect(r.currentStatus).toBe("ready");
  });

  it("AC-23 heartbeat records for a running task", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "HB", initialStatus: "ready" });
    await act(slug, task.id, "claim");
    const r = await act(slug, task.id, "heartbeat", { note: "alive" });
    expect(r.status).toBe("success");
  });

  it("claim on non-ready skips", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "X" });
    const r = await act(slug, task.id, "claim");
    expect(r.status).toBe("skipped");
    expect(r.message).toContain("wrong_status");
  });

  it("heartbeat on non-running skips", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "X" });
    const r = await act(slug, task.id, "heartbeat");
    expect(r.status).toBe("skipped");
  });

  it("404 when task not on board", async () => {
    const slug = await freshBoard();
    await expectBridgeError(performTaskAction(slug, 9999, "archive"), "task_not_found", 404);
  });

  it("rejects unknown action", async () => {
    const slug = await freshBoard();
    await expectBridgeError(performTaskAction(slug, 1, "frobnicate" as LifecycleAction), "invalid_action", 400);
  });

  it("AC-25: malformed field types return 400, never 500", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "M" });
    // reason must be string, not number
    await expectBridgeError(performTaskAction(slug, task.id, "block", { reason: 123 as unknown as string }), "invalid_input", 400);
    // at must be number, not string
    await expectBridgeError(performTaskAction(slug, task.id, "schedule", { at: "not-a-number" as unknown as number }), "invalid_input", 400);
    // force must be boolean, not string
    await expectBridgeError(performTaskAction(slug, task.id, "promote", { force: "yes" as unknown as boolean }), "invalid_input", 400);
    // profile must be string, not number
    await expectBridgeError(performTaskAction(slug, task.id, "assign", { profile: 99 as unknown as string }), "invalid_input", 400);
    // fields must be object, not primitive/array
    await expectBridgeError(performTaskAction(slug, task.id, "archive", "string" as unknown as Record<string, never>), "invalid_input", 400);
    await expectBridgeError(performTaskAction(slug, task.id, "archive", [1, 2] as unknown as Record<string, never>), "invalid_input", 400);
    // task must be unchanged after all rejections
    const check = await performTaskAction(slug, task.id, "archive");
    expect(check.result.status).toBe("success");
  });

  it("AC-25: bulk validates taskIds as positive integers", async () => {
    const slug = await freshBoard();
    await expectBridgeError(performBulkAction(slug, "archive", [1.5] as unknown as number[]), "invalid_input", 400);
    await expectBridgeError(performBulkAction(slug, "archive", [-1] as unknown as number[]), "invalid_input", 400);
    await expectBridgeError(performBulkAction(slug, "archive", ["x"] as unknown as number[]), "invalid_input", 400);
  });

  it("claim TTL must be a positive integer (matching CLI)", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "CL", initialStatus: "ready" });
    await expectBridgeError(act(slug, task.id, "claim", { ttl: 0 }), "invalid_input", 400);
    await expectBridgeError(act(slug, task.id, "claim", { ttl: -5 }), "invalid_input", 400);
    await expectBridgeError(act(slug, task.id, "claim", { ttl: 1.5 }), "invalid_input", 400);
    // valid TTL still works
    const r = await act(slug, task.id, "claim", { ttl: 300 });
    expect(r.status).toBe("success");
  });
});

describe("KDI-UI-006 server-side flag gates (AC-25)", () => {
  it("schedule off → 403 feature_disabled", async () => {
    flagOff("FF_SCHEDULED_STATUS");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "S" });
    await expectBridgeError(act(slug, task.id, "schedule", { at: Math.floor(Date.now() / 1000) + 60 }), "feature_disabled", 403);
  });

  it("review off → 403", async () => {
    flagOff("FF_REVIEW_STATUS");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "R" });
    await expectBridgeError(act(slug, task.id, "review"), "feature_disabled", 403);
  });

  it("assign off → 403", async () => {
    flagOff("FF_ASSIGN_REASSIGN");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "A" });
    await expectBridgeError(act(slug, task.id, "assign", { profile: "x" }), "feature_disabled", 403);
  });

  it("AC-17 complete metadata off + metadata → rejected with CLI text", async () => {
    flagOff("FF_COMPLETE_METADATA");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "C" });
    await expectBridgeError(act(slug, task.id, "complete", { metadata: "{}" }), "feature_disabled", 403);
  });

  it("complete metadata off without metadata still works", async () => {
    flagOff("FF_COMPLETE_METADATA");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "C" });
    const r = await act(slug, task.id, "complete", { result: "ok" });
    expect(r.status).toBe("success");
  });

  it("heartbeat off → 403", async () => {
    flagOff("FF_HEARTBEAT");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "H", initialStatus: "ready" });
    await act(slug, task.id, "claim");
    await expectBridgeError(act(slug, task.id, "heartbeat"), "feature_disabled", 403);
  });

  it("reclaim reason off → 403 (base reclaim ungated)", async () => {
    flagOff("FF_ASSIGN_REASSIGN");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "RC", initialStatus: "ready" });
    await act(slug, task.id, "claim");
    await expectBridgeError(act(slug, task.id, "reclaim", { reason: "x" }), "feature_disabled", 403);
  });

  it("promote force off → 403 (bulk gate)", async () => {
    flagOff("FF_BULK_OPERATIONS");
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "P" });
    await expectBridgeError(act(slug, task.id, "promote", { force: true }), "feature_disabled", 403);
  });
});

describe("KDI-UI-006 bulk actions", () => {
  it("AC-05 bulk promote with summary counts", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const { task: b } = await createTaskJson(slug, { title: "b" });
    const { task: c } = await createTaskJson(slug, { title: "c", initialStatus: "ready" }); // wrong status
    const res = await performBulkAction(slug, "promote", [a.id, b.id, c.id]);
    expect(res.summary).toEqual({ attempted: 3, succeeded: 2, skipped: 1, failed: 0 });
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => typeof r.taskId === "number" && typeof r.message === "string")).toBe(true);
  });

  it("AC-08 bulk block skips already-blocked", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const { task: b } = await createTaskJson(slug, { title: "b" });
    await act(slug, b.id, "block", { reason: "first" }); // already blocked
    const res = await performBulkAction(slug, "block", [a.id, b.id], { reason: "bulk" });
    expect(res.summary.succeeded).toBe(1);
    expect(res.summary.skipped).toBe(1);
  });

  it("AC-10 bulk unblock", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const { task: b } = await createTaskJson(slug, { title: "b" });
    await act(slug, a.id, "block", { reason: "x" });
    await act(slug, b.id, "block", { reason: "x" });
    const res = await performBulkAction(slug, "unblock", [a.id, b.id]);
    expect(res.summary.succeeded).toBe(2);
  });

  it("AC-12 bulk schedule", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const { task: b } = await createTaskJson(slug, { title: "b" });
    const future = Math.floor(Date.now() / 1000) + 7200;
    const res = await performBulkAction(slug, "schedule", [a.id, b.id], { at: future });
    expect(res.summary.succeeded).toBe(2);
  });

  it("AC-15 bulk archive", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const { task: b } = await createTaskJson(slug, { title: "b" });
    const res = await performBulkAction(slug, "archive", [a.id, b.id]);
    expect(res.summary.succeeded).toBe(2);
  });

  it("AC-18 bulk complete result-only; summary/metadata rejected", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const { task: b } = await createTaskJson(slug, { title: "b" });
    const res = await performBulkAction(slug, "complete", [a.id, b.id], { result: "ok" });
    expect(res.summary.succeeded).toBe(2);
    await expectBridgeError(performBulkAction(slug, "complete", [a.id], { summary: "x" }), "invalid_input", 400);
  });

  it("bulk skips off-board / missing tasks", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const res = await performBulkAction(slug, "archive", [a.id, 987654]);
    expect(res.summary.succeeded).toBe(1);
    expect(res.summary.skipped).toBe(1);
    expect(res.results.find((r) => r.taskId === 987654)?.message).toBe("not_found");
  });

  it("bulk requires FF_BULK_OPERATIONS", async () => {
    flagOff("FF_BULK_OPERATIONS");
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    await expectBridgeError(performBulkAction(slug, "archive", [a.id]), "feature_disabled", 403);
  });

  it("bulk rejects non-bulk action", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    await expectBridgeError(performBulkAction(slug, "claim", [a.id]), "invalid_action", 400);
  });

  it("bulk requires non-empty taskIds", async () => {
    const slug = await freshBoard();
    await expectBridgeError(performBulkAction(slug, "archive", []), "invalid_input", 400);
  });

  it("AC-24 result shape: every result has taskId, status, message", async () => {
    const slug = await freshBoard();
    const { task: a } = await createTaskJson(slug, { title: "a" });
    const res = await performBulkAction(slug, "promote", [a.id]);
    for (const r of res.results) {
      expect(["success", "skipped", "error"]).toContain(r.status);
      expect(typeof r.taskId).toBe("number");
      expect(typeof r.message).toBe("string");
    }
  });
});
