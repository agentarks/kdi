// KDI-UI-009 Slice 4 — hydrated browser test for /stats + /diagnostics.
//
// The HTTP smokes (stats.http.test.ts, diagnostics-page.http.test.ts,
// stats-diagnostics.http.test.ts) prove the SSR HTML and CLI parity. This test
// proves the two behaviors that only a real browser can:
//   1. the severity <select> drives CLIENT-SIDE navigation (onchange → goto),
//      narrowing and broadening the findings list without a full reload;
//   2. the FR-20 cross-links navigate between /stats and /diagnostics via the
//      client router.
//
// Self-contained lifecycle (matches activity.e2e.ts / lifecycle.e2e.ts): seed
// via the CLI, backdate one ready task via a spawned `bun -e` (the CLI cannot
// backdate, and Playwright runs under node so it cannot import bun:sqlite
// directly), spawn the dev server in its own process group, launch chromium,
// tear down. Uses node:child_process (not Bun.*) because Playwright runs tests
// under node.

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/web/e2e -> apps/web -> apps -> repo root (3 ups).
const REPO_ROOT = join(__dirname, "..", "..", "..");
const BOARD = "e2e";

let tmpHome: string;
let baseUrl: string;
let serverProc: ChildProcess | null = null;

function cliEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpHome,
    KDI_DB: join(tmpHome, "kdi.sqlite"),
    FF_SVELTEKIT_FRONTEND: "true",
    FF_STATS: "true",
    FF_DIAGNOSTICS: "true",
  };
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [join(REPO_ROOT, "src/index.ts"), ...args], {
      cwd: REPO_ROOT,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 40_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code !== 0) reject(new Error(`kdi ${args.join(" ")} exited ${code}\nstderr: ${stderr.trim()}`));
      else resolve(out);
    });
  });
}

/** Backdate a task via a spawned `bun -e` so stranded_in_ready fires. */
function backdateTask(taskId: number, ageSeconds: number): Promise<void> {
  const old = Math.floor(Date.now() / 1000) - ageSeconds;
  const script =
    'const{Database}=require("bun:sqlite");' +
    "const db=new Database(process.env.KDI_DB);" +
    `db.query("UPDATE tasks SET created_at=? WHERE id=?").run(${old},${taskId});`;
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", script], { cwd: REPO_ROOT, env: cliEnv(), stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 30_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`backdate exited ${code} for task ${taskId}`));
      else resolve();
    });
  });
}

// OS-assigned free port via node:net port 0. A pure random pick in a fixed
// range can collide with stale orphaned `vite dev` servers that accumulate on
// a shared dev machine, making waitAlive time out non-deterministically.
// getFreePort() returns a port the OS guarantees free at call time.
function getFreePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = String(addr.port);
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not determine a free port"));
      }
    });
  });
}

async function startServer(): Promise<void> {
  const port = await getFreePort();
  baseUrl = `http://localhost:${port}`;
  serverProc = spawn("bun", ["run", "dev:web", "--port", port], {
    cwd: REPO_ROOT,
    // setsid(): proc.pid leads a process group so stopServer reaps the whole
    // Vite tree, not just the bun parent.
    detached: true,
    stdio: "inherit",
    env: { ...process.env, ...cliEnv(), NODE_ENV: "development" },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/disabled`, { redirect: "manual" });
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive at ${baseUrl}`);
}

async function stopServer(): Promise<void> {
  if (serverProc && serverProc.pid) {
    try { process.kill(-serverProc.pid, 9); } catch { /* already gone */ }
    await new Promise<void>((res) => {
      serverProc!.once("exit", () => res());
      setTimeout(res, 2000);
    });
    serverProc = null;
  }
  await new Promise((res) => setTimeout(res, 500));
}

test.beforeAll(async () => {
  tmpHome = `/tmp/kdi-ui009s4-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });

  await runCli(["boards", "create", BOARD, "--workdir", tmpHome]);
  // Mixed statuses so /stats has non-zero buckets.
  await runCli(["create", "ready one", "--board", BOARD, "--initial-status", "ready"]);
  await runCli(["create", "ready two", "--board", BOARD, "--initial-status", "ready"]);
  await runCli(["create", "todo one", "--board", BOARD, "--initial-status", "todo"]);
  await runCli(["create", "done", "--board", BOARD, "--initial-status", "done"]);
  // A ready task stuck >24h → stranded_in_ready finding for the severity filter.
  const staleId = await runCli(["create", "stale ready", "--board", BOARD, "--initial-status", "ready"]);
  await backdateTask(Number(staleId), 25 * 60 * 60);

  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// /stats renders the CLI-seeded counts in the hydrated page, and the FR-20
// cross-link navigates to /diagnostics via the client router.
test("/stats renders counts and the Diagnostics cross-link navigates (FR-20)", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto(`${baseUrl}/stats?board=${BOARD}`);
  await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();
  // The page rendered the CLI-seeded data (Status counts section + a ready bucket).
  await expect(page.getByText("Status counts")).toBeVisible();
  await expect(page.locator(".status-link", { hasText: "ready" })).toBeVisible();

  // Click the in-page cross-link (not the nav link) → /diagnostics preserves board.
  await page.locator(`a[href="/diagnostics?board=${BOARD}"]`).first().click();
  // RegExp (not a /.../ literal) so BOARD interpolates; a regex literal would
  // treat ${BOARD} as literal text and never match.
  await expect(page).toHaveURL(new RegExp("/diagnostics\\?board=" + BOARD));
  await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
});

// The severity <select> drives client-side navigation: Critical+ narrows the
// warning-severity finding out (empty state), Warning+ brings it back. Proves
// the onchange→goto wiring the SSR smoke cannot reach.
test("severity filter narrows and broadens via client navigation (FR-12)", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto(`${baseUrl}/diagnostics?board=${BOARD}`);
  await expect(page.getByText("stranded_in_ready")).toBeVisible();
  // The severity <select>'s onchange handler is bound only after SvelteKit
  // hydrates; wait for hydration before driving the select (this page does not
  // poll, so networkidle fires promptly once hydration completes).
  await page.waitForLoadState("networkidle");

  // Critical+ excludes the warning finding → empty state + URL carries severity.
  await page.locator(".severity-filter select").selectOption("critical");
  await expect(page).toHaveURL(/severity=critical/);
  await expect(page.getByText("No diagnostic findings.")).toBeVisible();
  await expect(page.getByText("stranded_in_ready")).toHaveCount(0);

  // Warning+ brings the finding back.
  await page.locator(".severity-filter select").selectOption("warning");
  await expect(page).toHaveURL(/severity=warning/);
  await expect(page.getByText("stranded_in_ready")).toBeVisible();
});
