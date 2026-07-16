// KDI-UI-009 Slice 4 — AC-14 integration smoke + cross-links + AC-13 gate.
//
// The FINAL acceptance spine. The Slice 1/2/3 HTTP smokes each prove ONE page
// in isolation (stats parity; diagnostics parity + comment POST/GET round-trip).
// This test proves the whole works on ONE coherent CLI-seeded dataset and
// closes the gaps the per-slice smokes cannot reach:
//
// - AC-14: a single temp HOME + KDI_DB is seeded ENTIRELY via the CLI (mixed
//   statuses + a finding condition), then /stats and /diagnostics are loaded and
//   their rendered numbers are cross-checked against `kdi stats --json` and
//   `kdi diagnostics --json` on the same DB. This is the end-to-end CLI↔UI
//   parity the BRD acceptance demands (the per-slice smokes seed stats via CLI
//   but diagnostics via the bridge).
// - FR-20/21/22: the bidirectional stats↔diagnostics links, the board-preserving
//   task-id links, and the board-view → stats/diagnostics links — none covered
//   by the per-slice smokes.
// - #97 review carry-forward: comment persistence is cross-checked against
//   `kdi show <id>` (the CLI source of truth). Slice 3's tests substituted a
//   GET round-trip for the comment; the integration smoke is the designated
//   place to close that CLI↔UI parity gap.
// - AC-13: FF_SVELTEKIT_FRONTEND=false redirects both routes to /disabled.
//
// Process lifecycle mirrors stats.http.test.ts / notify-subs.http.test.ts: one
// shared server per flags-on describe; the master-off describe owns its own.

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "~/db";
import { createBoardJson } from "./bridge";

const REPO_ROOT = process.cwd();
const BOARD = "integ";
const PROFILE = "integration";

function makeTmpHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `kdi-ui009s4-${label}-`));
  process.env.HOME = home;
  process.env.KDI_DB = join(home, "kdi.sqlite");
  return home;
}

function kdiEnv(home: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    KDI_DB: join(home, "kdi.sqlite"),
    KDI_PROFILE: PROFILE,
    FF_SVELTEKIT_FRONTEND: "true",
    VITE_FF_SVELTEKIT_FRONTEND: "true",
    FF_STATS: "true",
    FF_DIAGNOSTICS: "true",
    FF_COMMENT_ENHANCEMENTS: "true",
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

// ---------------------------------------------------------------------------
// Flags-on suite: ONE CLI-seeded DB, ONE shared dev server.
// ---------------------------------------------------------------------------

describe("KDI-UI-009 Slice 4 — AC-14 integration smoke + cross-links", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;
  let staleTaskId: number;

  beforeAll(async () => {
    home = makeTmpHome("http");
    initDb();
    await createBoardJson({ slug: BOARD, workdir: home });

    // AC-14: seed the board ENTIRELY via the CLI in mixed statuses.
    runKdi(home, `create "in triage" --board ${BOARD} --triage`);
    runKdi(home, `create "todo one" --board ${BOARD} --initial-status todo`);
    runKdi(home, `create "ready one" --board ${BOARD} --initial-status ready`);
    runKdi(home, `create "ready two" --board ${BOARD} --initial-status ready`);
    runKdi(home, `create "running" --board ${BOARD} --initial-status running --assignee alice`);
    runKdi(home, `create "done" --board ${BOARD} --initial-status done`);

    // Create a finding condition: a ready task stuck >24h → stranded_in_ready.
    // The CLI cannot backdate, so promote the row's created_at directly (same
    // technique as diagnostics-page.http.test.ts). Proves parity against the
    // CLI diagnostic on a CLI-created task.
    staleTaskId = Number(runKdi(home, `create "stale ready" --board ${BOARD} --initial-status ready`));
    backdateTask(staleTaskId, 25 * 60 * 60);

    ({ baseUrl, cleanup } = await spawnServer(home));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("/stats rendered numbers match kdi stats --json (AC-14/AC-03)", async () => {
    const cli = JSON.parse(runKdi(home, `stats --board ${BOARD} --json`));
    const html = await (await fetch(`${baseUrl}/stats?board=${BOARD}`)).text();

    expect(html).toContain("Status counts");
    // AC-03: each rendered status count equals the CLI source of truth (zeros explicit).
    for (const [status, count] of Object.entries(cli.status_counts)) {
      expect(html).toContain(status);
      expect(html).toContain(`>${count}<`);
    }
    // Assignee load (alice has the running task → ready/running bucket).
    expect(html).toContain("alice");
    expect(cli.assignee_counts.alice).toBe(1);
    // Oldest ready age present (there are ready tasks).
    expect(html).toContain("Oldest ready age");
    expect(cli.oldest_ready_age_seconds).not.toBeNull();
  }, 120000);

  it("/diagnostics rendered findings match kdi diagnostics --json (AC-14/AC-04)", async () => {
    const cliJson = JSON.parse(runKdi(home, `diagnostics --board ${BOARD} --json`)) as Array<{
      rule: string; severity: string; task_id: number;
    }>;
    expect(cliJson.length).toBeGreaterThan(0);

    const html = await (await fetch(`${baseUrl}/diagnostics?board=${BOARD}`)).text();
    // The CLI-created stale task must surface as stranded_in_ready on both sides.
    const hasStale = cliJson.some((f) => f.task_id === staleTaskId);
    expect(hasStale).toBe(true);
    expect(html).toContain("stranded_in_ready");
    expect(html).toContain(`#${staleTaskId}`);
    // Every CLI finding's rule + severity renders on the page.
    for (const f of cliJson) {
      expect(html).toContain(f.rule);
      expect(html).toContain(f.severity);
    }
  }, 120000);

  it("FR-20: stats ↔ diagnostics bidirectional links render on both pages", async () => {
    const statsHtml = await (await fetch(`${baseUrl}/stats?board=${BOARD}`)).text();
    expect(statsHtml).toContain(`href="/diagnostics?board=${BOARD}"`);
    const diagHtml = await (await fetch(`${baseUrl}/diagnostics?board=${BOARD}`)).text();
    expect(diagHtml).toContain(`href="/stats?board=${BOARD}"`);
  }, 120000);

  it("FR-21: diagnostics task-id links preserve the board (?board=<slug>)", async () => {
    const html = await (await fetch(`${baseUrl}/diagnostics?board=${BOARD}`)).text();
    expect(html).toContain(`href="/tasks/${staleTaskId}?board=${BOARD}"`);
  }, 120000);

  it("FR-22: board view links to /stats and /diagnostics", async () => {
    const html = await (await fetch(`${baseUrl}/boards/${BOARD}`)).text();
    expect(html).toContain(`href="/stats?board=${BOARD}"`);
    expect(html).toContain(`href="/diagnostics?board=${BOARD}"`);
  }, 120000);

  // #97 review carry-forward: Slice 3's tests substituted a GET round-trip for
  // the comment. AC-14 is the designated place to close the CLI↔UI parity gap —
  // a comment posted through the UI must be visible to `kdi show <id>` (the CLI
  // source of truth), proving the UI and CLI write the same SQLite rows.
  it("comment posted via UI is visible to `kdi show <id>` (CLI parity)", async () => {
    const res = await fetch(`${baseUrl}/api/boards/${BOARD}/tasks/${staleTaskId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "diagnostic note from UI" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { comment: { author: string } };
    expect(created.comment.author).toBe(PROFILE);

    const showOut = runKdi(home, `show ${staleTaskId}`);
    expect(showOut).toContain("Comments:");
    expect(showOut).toContain("diagnostic note from UI");
    // Author renders because FF_COMMENT_ENHANCEMENTS=true; resolves via KDI_PROFILE.
    expect(showOut).toContain(`${PROFILE}:`);
  }, 120000);
});

// ---------------------------------------------------------------------------
// AC-13: FF_SVELTEKIT_FRONTEND=false redirects both routes to /disabled.
// ---------------------------------------------------------------------------

describe("KDI-UI-009 Slice 4 — AC-13 master-off gate", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("masteroff");
    initDb();
    await createBoardJson({ slug: BOARD, workdir: home });
    runKdi(home, `create "gated" --board ${BOARD} --initial-status ready`);
    ({ baseUrl, cleanup } = await spawnServer(home, {
      FF_SVELTEKIT_FRONTEND: "false",
      VITE_FF_SVELTEKIT_FRONTEND: "false",
    }));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("/stats and /diagnostics redirect to /disabled (307)", async () => {
    const stats = await fetch(`${baseUrl}/stats?board=${BOARD}`, { redirect: "manual" });
    expect(stats.status).toBe(307);
    expect(stats.headers.get("location")).toBe("/disabled");
    const diag = await fetch(`${baseUrl}/diagnostics?board=${BOARD}`, { redirect: "manual" });
    expect(diag.status).toBe(307);
    expect(diag.headers.get("location")).toBe("/disabled");
  }, 120000);
});
