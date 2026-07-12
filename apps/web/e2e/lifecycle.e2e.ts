// KDI-UI-006 lifecycle hydrated browser test.
//
// Proves the bulk toolbar, task selection, and per-task result rows render in
// a real browser after hydration. The HTTP smoke proves the API contract; this
// proves the interactive UI: checkbox selection → toolbar appears → bulk action
// submitted → result panel renders with summary + per-task rows.
//
// Self-contained lifecycle (matches activity.e2e.ts): seed via the CLI, spawn
// the dev server in its own process group, launch chromium, tear down.

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

let tmpHome: string;
let baseUrl: string;
let serverProc: ChildProcess | null = null;

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [join(REPO_ROOT, "src/index.ts"), ...args], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: tmpHome,
        KDI_DB: join(tmpHome, "kdi.sqlite"),
        FF_SVELTEKIT_FRONTEND: "true",
      },
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

async function startServer(): Promise<void> {
  const port = String(50000 + Math.floor(Math.random() * 5000));
  baseUrl = `http://localhost:${port}`;
  serverProc = spawn("bun", ["run", "dev:web", "--port", port], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: "true",
      FF_BULK_OPERATIONS: "true",
      FF_SCHEDULED_STATUS: "true",
      FF_REVIEW_STATUS: "true",
      FF_COMPLETE_METADATA: "true",
      FF_ASSIGN_REASSIGN: "true",
      FF_HEARTBEAT: "true",
      NODE_ENV: "development",
    },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`, { redirect: "manual" });
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
  tmpHome = `/tmp/kdi-ui006-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  await runCli(["boards", "create", "lc", "--workdir", tmpHome]);
  await runCli(["create", "Task one", "--board", "lc", "--no-dispatcher-warning"]);
  await runCli(["create", "Task two", "--board", "lc", "--no-dispatcher-warning"]);
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

test("row selection → bulk toolbar appears → bulk promote shows per-task results", async ({
  page,
}: {
  page: Page;
}) => {
  await page.goto(`${baseUrl}/boards/lc`);

  // Task cards render in the todo column.
  await expect(page.locator(".task-card", { hasText: "Task one" })).toBeVisible();
  await expect(page.locator(".task-card", { hasText: "Task two" })).toBeVisible();

  // Bulk toolbar is NOT visible before selection.
  await expect(page.locator(".bulk-toolbar")).toHaveCount(0);

  // The selection controls require hydrated event handlers. Wait for the
  // board's explicit interactive-ready state before clicking SSR markup.
  await expect(page.locator('.board-view[data-hydrated="true"]')).toBeVisible();

  // Select both tasks.
  const card1 = page.locator(".task-card", { hasText: "Task one" });
  const card2 = page.locator(".task-card", { hasText: "Task two" });
  await card1.locator(".card-check").check();
  await expect(page.locator(".bulk-toolbar .bulk-count")).toContainText("1 selected");
  await card2.locator(".card-check").check();

  // Bulk toolbar now appears with count.
  await expect(page.locator(".bulk-toolbar")).toBeVisible();
  await expect(page.locator(".bulk-toolbar .bulk-count")).toContainText("2 selected");

  // Click Promote in the toolbar.
  await page.locator(".bulk-toolbar").getByRole("button", { name: "Promote" }).click();

  // Confirm in the dialog.
  await expect(page.locator(".dialog h3", { hasText: "Bulk promote" })).toBeVisible();
  await page.locator(".dialog").getByRole("button", { name: /Promote 2/ }).click();

  // Result panel renders with summary and per-task rows.
  await expect(page.locator(".bulk-result")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".summary")).toContainText("succeeded 2");
  await expect(page.locator(".result-list .result-row")).toHaveCount(2);
  await expect(page.locator(".result-list .result-row.success")).toHaveCount(2);
  await expect(page.locator('[data-status="ready"] .task-card', { hasText: "Task one" })).toBeVisible();
  await expect(page.locator('[data-status="ready"] .task-card', { hasText: "Task two" })).toBeVisible();
});

test("row action menu links to detail panel with action pre-selected", async ({
  page,
}: {
  page: Page;
}) => {
  // Create a todo task via the CLI.
  const id = await runCli(["create", "Menu task", "--board", "lc", "--no-dispatcher-warning"]);
  await page.goto(`${baseUrl}/boards/lc`);

  const card = page.locator(".task-card", { hasText: "Menu task" });

  // Open the row menu.
  await card.locator(".row-menu summary").click();

  // The Promote link should be enabled (todo status).
  const promoteLink = card.locator(".row-menu-dropdown").getByText("Promote");
  await expect(promoteLink).not.toHaveClass(/disabled/);

  // Click it — navigates to detail with ?action=promote.
  await promoteLink.click();
  await expect(page).toHaveURL(/\/tasks\/\d+\?board=lc&action=promote/);

  // The promote dialog auto-opens.
  await expect(page.locator(".dialog h3", { hasText: "Promote" })).toBeVisible();
});
