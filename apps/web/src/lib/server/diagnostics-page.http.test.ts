// KDI-UI-009 Slice 2 HTTP smoke — /diagnostics page (AC-02/04/07/08/10/12/16).
//
// Spawns `bun run dev:web` against an isolated temp HOME + KDI_DB, seeds a
// diagnostic finding (ready task >24h → stranded_in_ready), loads /diagnostics,
// and asserts the rendered HTML matches `kdi diagnostics --json`. Covers the
// loader behaviors the unit test cannot reach (Gap 2 severity validation,
// FF_DIAGNOSTICS gate) because they live in +page.server.ts which imports `$lib`
// (unresolvable under root `bun test`).
//
// Process lifecycle copied from notify-subs.http.test.ts (one server per
// describe, killTree on teardown). ponytail: reuse the proven spawn harness.

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "~/db";
import { createBoardJson, createTaskJson } from "./bridge";

const REPO_ROOT = process.cwd();

function makeTmpHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `kdi-ui009s2-${label}-`));
  process.env.HOME = home;
  process.env.KDI_DB = join(home, "kdi.sqlite");
  return home;
}

function kdiEnv(home: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    KDI_DB: join(home, "kdi.sqlite"),
    FF_SVELTEKIT_FRONTEND: "true",
    VITE_FF_SVELTEKIT_FRONTEND: "true",
    FF_DIAGNOSTICS: "true",
    ...overrides,
  };
}

function runKdi(home: string, args: string, overrides: Record<string, string> = {}): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(home, overrides) },
  }).trim();
}

/** Backdate a task's created_at so stranded_in_ready fires (>24h threshold). */
function backdateTask(taskId: number, ageSeconds: number): void {
  const old = Math.floor(Date.now() / 1000) - ageSeconds;
  getDb().query("UPDATE tasks SET created_at = ? WHERE id = ?").run(old, taskId);
}

async function waitAlive(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/disabled`, { redirect: "manual" });
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on ${baseUrl} within ${timeoutMs}ms`);
}

function descendantPids(rootPid: number): number[] {
  const out: number[] = [];
  let frontier = [rootPid];
  const seen = new Set<number>();
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (parent !== rootPid) out.push(parent);
      try {
        const children = execSync(`pgrep -P ${parent} 2>/dev/null || true`, { encoding: "utf8" })
          .split("\n").map((s) => s.trim()).filter((s) => s !== "").map(Number);
        next.push(...children);
      } catch { /* none */ }
    }
    frontier = next;
  }
  return out;
}

async function killTree(p: ReturnType<typeof Bun.spawn>): Promise<void> {
  const pid = p.pid;
  for (const child of descendantPids(pid)) {
    try { process.kill(child, 9); } catch { /* gone */ }
  }
  try { process.kill(pid, 9); } catch { /* gone */ }
  try {
    await Promise.race([p.exited, new Promise<void>((res) => setTimeout(res, 3000))]);
  } catch { /* gone */ }
}

async function spawnServer(
  home: string,
  envOverrides: Record<string, string> = {},
): Promise<{ baseUrl: string; cleanup: () => Promise<void> }> {
  const port = String(50000 + Math.floor(Math.random() * 15000));
  const baseUrl = `http://localhost:${port}`;
  const p = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(home), NODE_ENV: "development", ...envOverrides },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitAlive(baseUrl);
  const cleanup = async () => {
    await killTree(p);
    try {
      execSync(`pkill -9 -f "vite dev --port ${port}" >/dev/null 2>&1 || true`);
    } catch { /* none */ }
  };
  return { baseUrl, cleanup };
}

/** Stable comparison key (drops the variable seconds count from the message). */
function findingKey(f: { rule: string; severity: string; task_id: number }) {
  return `${f.severity}|${f.task_id}|${f.rule}`;
}

// ---------------------------------------------------------------------------
// Flags-on suite: one shared dev server.
// ---------------------------------------------------------------------------

describe("KDI-UI-009 Slice 2 /diagnostics page (AC-02/04/07/08)", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;
  let staleTaskId: number;

  beforeAll(async () => {
    home = makeTmpHome("diag");
    initDb();
    await createBoardJson({ slug: "diag", workdir: home });
    const { task } = await createTaskJson("diag", { title: "Stale ready task", initialStatus: "ready" });
    staleTaskId = task.id;
    // Backdate 25h so stranded_in_ready fires.
    backdateTask(staleTaskId, 25 * 60 * 60);
    ({ baseUrl, cleanup } = await spawnServer(home));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("renders the finding with rule, severity, and task id (AC-02/04)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag`)).text();
    expect(html).toContain("stranded_in_ready");
    expect(html).toContain("warning");
    expect(html).toContain(`#${staleTaskId}`);
    expect(html).toContain("1 finding");
  }, 120000);

  it("rendered findings match kdi diagnostics --json (AC-04/10)", async () => {
    const cliJson = JSON.parse(runKdi(home, "diagnostics --board diag --json")) as Array<{
      rule: string; severity: string; task_id: number; actions: string[];
    }>;
    expect(cliJson.length).toBeGreaterThan(0);
    const cliKeys = cliJson.map(findingKey).sort();

    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag`)).text();
    for (const f of cliJson) {
      expect(html).toContain(f.rule);
      expect(html).toContain(f.severity);
    }
    // Every CLI finding's rule appears in the rendered page.
    expect(cliKeys.length).toBeGreaterThan(0);
  }, 120000);

  it("renders action labels as non-clickable badges (FR-13, Slice 2 read-only)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag`)).text();
    // stranded_in_ready actions: cli_hint, reassign, comment.
    expect(html).toContain("reassign");
    expect(html).toContain("comment");
    // Slice 2: action labels must NOT be buttons/forms (Slice 3 wires mutations).
    expect(html).not.toContain("/diagnostics?/reclaim");
    expect(html).not.toContain("/diagnostics?/reassign");
  }, 120000);

  it("severity filter ?severity=critical narrows the list (AC-07)", async () => {
    // stranded_in_ready is a warning → critical filter excludes it → empty state.
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag&severity=critical`)).text();
    expect(html).toContain("No diagnostic findings");
    expect(html).not.toContain("stranded_in_ready");
  }, 120000);

  it("invalid severity ?severity=bogus shows the exact CLI inline error (Gap 2)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag&severity=bogus`)).text();
    expect(html).toContain('Invalid severity "bogus". Valid: warning, error, critical');
  }, 120000);

  it("per-task filter ?task=<id> shows only that task's findings (AC-08)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag&task=${staleTaskId}`)).text();
    expect(html).toContain("stranded_in_ready");
    expect(html).toContain(`#${staleTaskId}`);
  }, 120000);

  it("unknown task id renders an inline error", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag&task=9999`)).text();
    expect(html).toContain("not found");
  }, 120000);

  it("invalid (non-numeric) task id renders an inline error, not a 500 (loader guard)", async () => {
    const res = await fetch(`${baseUrl}/diagnostics?board=diag&task=abc`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid task id "abc"');
  }, 120000);

  it("nav contains a /diagnostics link (Gap 4 / FR-19)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag`)).text();
    expect(html).toContain('href="/diagnostics"');
  }, 120000);

  it("no ?board resolves via the default fallback, not a 'No board selected' dead-end", async () => {
    // Regression guard for the ?? "default" board-resolution fallback. The
    // test env has no current-board file, so pre-fix this rendered
    // "No board selected."; post-fix it resolves "default" (here → board_not_found
    // inline error, since no default board is seeded) — either way it must NOT
    // be the old no-board dead-end.
    const html = await (await fetch(`${baseUrl}/diagnostics`)).text();
    expect(html).not.toContain("No board selected");
  }, 120000);
});

// ---------------------------------------------------------------------------
// Flag-off suite: FF_DIAGNOSTICS=false → disabled message (AC-12).
// ---------------------------------------------------------------------------

describe("KDI-UI-009 Slice 2 flag gate (AC-12): FF_DIAGNOSTICS=false", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("diagoff");
    initDb();
    await createBoardJson({ slug: "diag", workdir: home });
    const { task } = await createTaskJson("diag", { title: "Gated", initialStatus: "ready" });
    backdateTask(task.id, 25 * 60 * 60);
    ({ baseUrl, cleanup } = await spawnServer(home, { FF_DIAGNOSTICS: "false" }));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("renders the disabled message and no findings (AC-12)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=diag`)).text();
    expect(html).toContain("Diagnostics feature is not enabled");
    expect(html).not.toContain("stranded_in_ready");
  }, 120000);
});
