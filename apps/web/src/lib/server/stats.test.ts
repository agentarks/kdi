// KDI-UI-009 Slice 1: stats bridge + loader parity and flag-gate unit test.
//
// Seeding happens through the bridge (createTaskJson) and parity is cross-checked
// against `kdi stats --json` (the CLI is the source of truth), so this test file
// imports NO `~/models/*` and NO `bun:sqlite` — it stays inside the
// "SQLite server-side only" guard enforced by bridge.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createBoardJson, createTaskJson, boardStatsJson, statsFlags } from "./bridge";
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";
import { loadStatsPage } from "./statsPage";

const REPO_ROOT = process.cwd();
let tmpHome: string;
const envSnapshot: Record<string, string | undefined> = {};

function isolate(): void {
  tmpHome = `/tmp/kdi-ui009s1-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  process.env.FF_STATS = "true";
  delete process.env.KDI_BOARD;
}

function cleanup(): void {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
}

function kdiStatsJson(slug: string): any {
  return JSON.parse(
    execSync(`bun run src/index.ts stats --board ${slug} --json`, {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: { ...process.env, FF_SVELTEKIT_FRONTEND: "true", FF_STATS: "true" },
    }),
  );
}

beforeEach(() => {
  envSnapshot.FF_STATS = process.env.FF_STATS;
  isolate();
  clearOverrides();
});

afterEach(() => {
  const v = envSnapshot.FF_STATS;
  if (v === undefined) delete process.env.FF_STATS;
  else process.env.FF_STATS = v;
  clearOverrides();
  closeDb();
  cleanup();
});

describe("KDI-UI-009 Slice 1 — boardStatsJson + loader", () => {
  it("statusCounts reflect tasks seeded in multiple statuses (AC-03 parity vs kdi stats --json)", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    await createTaskJson("demo", { title: "t-todo", initialStatus: "todo" });
    await createTaskJson("demo", { title: "r1", initialStatus: "ready" });
    await createTaskJson("demo", { title: "r2", initialStatus: "ready" });
    await createTaskJson("demo", { title: "run", initialStatus: "running", assignee: "alice" });
    await createTaskJson("demo", { title: "blk", initialStatus: "blocked" });
    await createTaskJson("demo", { title: "dn", initialStatus: "done" });

    const { stats } = await boardStatsJson("demo");
    expect(stats.statusCounts).toEqual({
      triage: 0,
      todo: 1,
      scheduled: 0,
      ready: 2,
      running: 1,
      done: 1,
      blocked: 1,
      review: 0,
    });
    expect(stats.assigneeCounts).toEqual({ alice: 1 });
    // oldestReadyAgeSeconds is non-null because there are ready tasks.
    expect(stats.oldestReadyAgeSeconds).not.toBeNull();
    expect(typeof stats.oldestReadyAgeSeconds).toBe("number");

    // AC-03: rendered numbers must equal the CLI source of truth.
    const cli = kdiStatsJson("demo");
    expect(stats.statusCounts).toEqual(cli.status_counts);
    expect(stats.assigneeCounts).toEqual(cli.assignee_counts);
    expect(stats.oldestReadyAgeSeconds).not.toBeNull();
  });

  it("empty board → all eight buckets explicit zero, empty assignees, null oldest-ready", async () => {
    await createBoardJson({ slug: "empty", workdir: tmpHome });
    const { stats } = await boardStatsJson("empty");
    expect(stats.statusCounts).toEqual({
      triage: 0,
      todo: 0,
      scheduled: 0,
      ready: 0,
      running: 0,
      done: 0,
      blocked: 0,
      review: 0,
    });
    expect(stats.assigneeCounts).toEqual({});
    expect(stats.oldestReadyAgeSeconds).toBeNull();
    const cli = kdiStatsJson("empty");
    expect(cli.oldest_ready_age_seconds).toBeNull();
  });

  it("boardStatsJson throws board_not_found for a missing board", async () => {
    await expect(boardStatsJson("ghost")).rejects.toThrow(/not found/);
  });
});

describe("KDI-UI-009 Slice 1 — statsFlags() + loader disabled payload (FR-2 / AC-11)", () => {
  it("statsFlags() reflects FF_STATS", () => {
    process.env.FF_STATS = "true";
    clearOverrides();
    expect(statsFlags().stats).toBe(true);
    process.env.FF_STATS = "false";
    clearOverrides();
    expect(statsFlags().stats).toBe(false);
  });

  it("loader returns a disabled payload when FF_STATS=false", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    process.env.FF_STATS = "false";
    clearOverrides();
    const url = new URL("http://x/stats?board=demo");
    const out = await loadStatsPage(url);
    expect(out.enabled).toBe(false);
    // No stats payload must be attached in the disabled state.
    expect(out.stats).toBeUndefined();
  });

  it("loader returns stats payload + board when FF_STATS=true", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    await createTaskJson("demo", { title: "r", initialStatus: "ready" });
    process.env.FF_STATS = "true";
    clearOverrides();
    const url = new URL("http://x/stats?board=demo");
    const out = await loadStatsPage(url);
    expect(out.enabled).toBe(true);
    expect(out.board!.slug).toBe("demo");
    expect(out.stats!.statusCounts.ready).toBe(1);
    expect(typeof out.snapshotAt).toBe("number");
  });

  it("loader renders board-not-found inline error (FR-1)", async () => {
    process.env.FF_STATS = "true";
    clearOverrides();
    const url = new URL("http://x/stats?board=ghost");
    const out = await loadStatsPage(url);
    expect(out.enabled).toBe(true);
    expect(out.error).toContain("not found");
    expect(out.stats).toBeUndefined();
  });

  it("loader falls back to 'default' when ?board is omitted (FR-1)", async () => {
    await createBoardJson({ slug: "default", workdir: tmpHome });
    process.env.FF_STATS = "true";
    clearOverrides();
    const url = new URL("http://x/stats");
    const out = await loadStatsPage(url);
    expect(out.enabled).toBe(true);
    expect(out.board!.slug).toBe("default");
  });
});
