// KDI-UI-009 Slice 2 unit tests — diagnostics bridge parity (AC-04 / AC-08).
//
// The /diagnostics loader is thin glue (board resolution + Gap 2 severity
// validation + FF_DIAGNOSTICS gate) over `diagnosticsJson`. The loader's
// severity-validation and disabled-state behaviors are covered by the HTTP
// smoke test (diagnostics-page.http.test.ts), which exercises the real dev
// server. This unit test proves the data contract: bridge findings match the
// CLI model source of truth (`runDiagnostics`) for the full board, a severity
// filter, and a per-task filter — so the page can never diverge from the CLI.
//
// Pattern: isolate temp HOME + KDI_DB, seed via the bridge, cross-check via
// `~/models/diagnostic` (allowed — this is a server-side bridge test).

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { createBoardJson, createTaskJson, diagnosticsJson } from "./bridge";
import { runDiagnostics } from "~/models/diagnostic";
import { getDb, closeDb, initDb } from "~/db";
import { clearOverrides } from "~/flags";

const FF_KEYS = ["FF_SVELTEKIT_FRONTEND", "FF_DIAGNOSTICS"];

let tmpHome: string;
const envSnapshot: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];

function isolate(): void {
  tmpHome = `/tmp/kdi-ui009s2-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  for (const key of FF_KEYS) {
    if (key !== "FF_SVELTEKIT_FRONTEND") delete process.env[key];
  }
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
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

afterAll(() => {
  closeDb();
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/** Backdate a task's created_at so the stranded_in_ready rule fires (>24h). */
function backdateTask(taskId: number, ageSeconds: number): void {
  const old = Math.floor(Date.now() / 1000) - ageSeconds;
  getDb().query("UPDATE tasks SET created_at = ? WHERE id = ?").run(old, taskId);
}

/** Strip the unstable `message` seconds count so comparisons are stable. */
function core(f: { rule: string; severity: string; taskId?: number; task_id?: number; actions: string[] }) {
  return {
    rule: f.rule,
    severity: f.severity,
    taskId: (f as { taskId?: number; task_id?: number }).taskId ?? (f as { task_id?: number }).task_id,
    actions: f.actions,
  };
}

describe("KDI-UI-009 Slice 2 — diagnosticsJson parity with runDiagnostics", () => {
  it("bridge findings match the CLI model for the full board (AC-04)", async () => {
    await createBoardJson({ slug: "diag", workdir: tmpHome });
    const { task: ready } = await createTaskJson("diag", { title: "stale ready", initialStatus: "ready" });
    backdateTask(ready.id, 25 * 60 * 60); // 25h → stranded_in_ready

    const params = new URLSearchParams();
    const { diagnostics } = await diagnosticsJson("diag", params);
    const model = runDiagnostics("diag", {});

    expect(diagnostics.length).toBe(model.length);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.map(core)).toEqual(model.map(core));
    const found = diagnostics.find((f) => f.rule === "stranded_in_ready");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("warning");
    expect(found!.taskId).toBe(ready.id);
  });

  it("severity filter narrows identically to the CLI model", async () => {
    await createBoardJson({ slug: "diag", workdir: tmpHome });
    const { task: ready } = await createTaskJson("diag", { title: "stale ready", initialStatus: "ready" });
    backdateTask(ready.id, 25 * 60 * 60);
    // stranded_in_ready is a warning; filtering to error+ must drop it.
    const { diagnostics } = await diagnosticsJson("diag", new URLSearchParams("severity=error"));
    const model = runDiagnostics("diag", { severity: "error" });
    expect(diagnostics.map(core)).toEqual(model.map(core));
    expect(diagnostics.find((f) => f.rule === "stranded_in_ready")).toBeUndefined();
  });

  it("per-task filter matches runDiagnostics(slug, { taskId }) (AC-08)", async () => {
    await createBoardJson({ slug: "diag", workdir: tmpHome });
    const { task: t1 } = await createTaskJson("diag", { title: "first", initialStatus: "ready" });
    const { task: t2 } = await createTaskJson("diag", { title: "second", initialStatus: "ready" });
    backdateTask(t1.id, 25 * 60 * 60);
    backdateTask(t2.id, 25 * 60 * 60);

    const { diagnostics } = await diagnosticsJson("diag", new URLSearchParams(`taskId=${t1.id}`));
    const model = runDiagnostics("diag", { taskId: t1.id });
    expect(diagnostics.map(core)).toEqual(model.map(core));
    expect(diagnostics.every((f) => f.taskId === t1.id)).toBe(true);
  });

  it("invalid/unknown task id on a valid board throws task_not_found", async () => {
    await createBoardJson({ slug: "diag", workdir: tmpHome });
    await expect(diagnosticsJson("diag", new URLSearchParams("taskId=9999"))).rejects.toThrow(
      /not found/,
    );
  });

  it("findings are sorted severity desc, taskId asc, rule asc (model contract)", async () => {
    await createBoardJson({ slug: "diag", workdir: tmpHome });
    const { task: ready } = await createTaskJson("diag", { title: "stale", initialStatus: "ready" });
    backdateTask(ready.id, 25 * 60 * 60);
    const { diagnostics } = await diagnosticsJson("diag", new URLSearchParams());
    const ranks: Record<string, number> = { critical: 3, error: 2, warning: 1 };
    for (let i = 1; i < diagnostics.length; i++) {
      const a = diagnostics[i - 1];
      const b = diagnostics[i];
      const sev = ranks[b.severity] - ranks[a.severity];
      const task = (a.taskId - b.taskId) || 0;
      const rule = a.rule.localeCompare(b.rule);
      expect(sev > 0 || (sev === 0 && (task < 0 || (task === 0 && rule <= 0)))).toBe(true);
    }
  });
});
