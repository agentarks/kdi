// KDI-UI-009 Slice 1: /stats page HTTP smoke (AC-01, AC-03, AC-05, AC-10, AC-11).
//
// Spawns `bun run dev:web` against an isolated temp HOME + KDI_DB with
// FF_STATS=true, creates a board + tasks in mixed statuses via the CLI, loads
// /stats, and asserts the rendered HTML contains each status count and the
// oldest-ready age. Cross-checks every number against `kdi stats --json` on the
// same DB (AC-03 parity). Also verifies the FF_STATS=false disabled render
// (AC-11) and the board-not-found inline error (FR-1).
//
// Process lifecycle mirrors notify-subs.http.test.ts: one shared server per
// flags-on describe; the flag-off suite owns its own server.
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "~/db";
import { createBoardJson } from "./bridge";

const REPO_ROOT = process.cwd();

function makeTmpHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `kdi-ui009s1-${label}-`));
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
    FF_STATS: "true",
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

function kdiStatsJson(home: string, slug: string): any {
  return JSON.parse(runKdi(home, `stats --board ${slug} --json`));
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

async function spawnServer(home: string, envOverrides: Record<string, string> = {}): Promise<{ baseUrl: string; cleanup: () => Promise<void> }> {
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
    try { execSync(`pkill -9 -f "vite dev --port ${port}" >/dev/null 2>&1 || true`); } catch { /* none */ }
  };
  return { baseUrl, cleanup };
}

describe("KDI-UI-009 Slice 1 — /stats HTTP smoke (AC-01/03/05/10/11)", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("http");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    // Mixed statuses so multiple buckets are non-zero.
    runKdi(home, 'create "in triage" --board demo --triage');
    runKdi(home, 'create "todo one" --board demo --initial-status todo');
    runKdi(home, 'create "ready one" --board demo --initial-status ready');
    runKdi(home, 'create "ready two" --board demo --initial-status ready');
    runKdi(home, 'create "running" --board demo --initial-status running --assignee alice');
    runKdi(home, 'create "done" --board demo --initial-status done');
    ({ baseUrl, cleanup } = await spawnServer(home));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("renders the board header and every status count (AC-01), cross-checked vs kdi stats --json (AC-03)", async () => {
    const html = await (await fetch(`${baseUrl}/stats?board=demo`)).text();
    expect(html).toContain("Stats");
    expect(html).toContain("demo");
    expect(html).toContain("Status counts");

    const cli = kdiStatsJson(home, "demo");
    // AC-03: each rendered count equals the CLI source of truth.
    for (const status of Object.keys(cli.status_counts)) {
      const count = cli.status_counts[status];
      expect(html).toContain(status);
      // The count cell must render (zeros explicit too).
      expect(html).toContain(`>${count}<`);
    }
    // Assignee load (alice has the running task → ready/running bucket).
    expect(html).toContain("alice");
    expect(cli.assignee_counts.alice).toBe(1);
    // Oldest ready age present (there are ready tasks).
    expect(html).toContain("Oldest ready age");
    expect(cli.oldest_ready_age_seconds).not.toBeNull();
  }, 120000);

  it("status rows link to the board view with ?status= (AC-05)", async () => {
    const html = await (await fetch(`${baseUrl}/stats?board=demo`)).text();
    expect(html).toContain('href="/boards/demo?status=ready"');
    expect(html).toContain('href="/boards/demo?status=todo"');
  }, 120000);

  it("export payload values match kdi stats --json (AC-10)", async () => {
    const api = await (await fetch(`${baseUrl}/api/boards/demo/stats`)).json();
    const cli = kdiStatsJson(home, "demo");
    expect(api.stats.statusCounts).toEqual(cli.status_counts);
    expect(api.stats.assigneeCounts).toEqual(cli.assignee_counts);
    expect(api.stats.oldestReadyAgeSeconds).not.toBeNull();
  }, 120000);

  it("board-not-found renders an inline error (FR-1)", async () => {
    const html = await (await fetch(`${baseUrl}/stats?board=ghost`)).text();
    expect(html).toContain("not found");
  }, 120000);
});

describe("KDI-UI-009 Slice 1 — /stats disabled when FF_STATS=false (AC-11)", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("statsoff");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    runKdi(home, 'create "gated" --board demo --initial-status ready');
    ({ baseUrl, cleanup } = await spawnServer(home, { FF_STATS: "false" }));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("renders the disabled message and no status counts", async () => {
    const html = await (await fetch(`${baseUrl}/stats?board=demo`)).text();
    expect(html).toContain("Stats feature is not enabled");
    expect(html).not.toContain("Status counts");
  }, 120000);
});
