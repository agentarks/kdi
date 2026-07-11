// KDI-UI-008 AC-14 hydrated browser test + P1-1 client-navigation regression.
//
// Why a browser test: the activity stream fetches its events client-side after
// hydration (BRD NFR). The HTTP smoke (bridge.http.test.ts) proves SSR + the
// JSON endpoint, but cannot prove the fetched events render into the DOM. This
// drives a real headless browser against the dev server, waits for the
// hydrated event rows, and asserts the CLI-written task id + kinds render.
//
// Self-contained lifecycle (matches bridge.http.test.ts): seed via the CLI,
// spawn the dev server in its own process group, launch chromium, tear down.
// Uses node:child_process (not Bun.*) because Playwright runs tests under node.

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/web/e2e -> apps/web -> apps -> repo root (3 ups).
const REPO_ROOT = join(__dirname, "..", "..", "..");

let tmpHome: string;
let baseUrl: string;
let serverProc: ChildProcess | null = null;

function randomPort(): string {
  return String(50000 + Math.floor(Math.random() * 5000));
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [join(REPO_ROOT, "src/index.ts"), ...args], {
      cwd: REPO_ROOT,
      // Explicit, minimal env: the parent is Playwright (node), whose
      // process.env carries PW_*/NODE_OPTIONS/etc. that we don't want leaking
      // into the kdi CLI. Keep only what the CLI needs to resolve the DB.
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
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 40_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code !== 0) {
        reject(new Error(`kdi ${args.join(" ")} exited ${code}\nstderr: ${stderr.trim()}`));
      } else {
        resolve(out);
      }
    });
  });
}

async function startServer(): Promise<void> {
  const port = randomPort();
  baseUrl = `http://localhost:${port}`;
  serverProc = spawn("bun", ["run", "dev:web", "--port", port], {
    cwd: REPO_ROOT,
    // setsid(): proc.pid leads a process group so stopServer reaps the whole
    // Vite tree, not just the bun parent (the original 20-min hang cause).
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: "true",
      NODE_ENV: "development",
    },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive at ${baseUrl}`);
}

async function stopServer(): Promise<void> {
  if (serverProc && serverProc.pid) {
    try {
      process.kill(-serverProc.pid, 9);
    } catch {
      /* already gone */
    }
    await new Promise<void>((res) => {
      serverProc!.once("exit", () => res());
      // Safety: don't hang forever if the exit event already fired.
      setTimeout(res, 2000);
    });
    serverProc = null;
  }
  await new Promise((res) => setTimeout(res, 500));
}

test.beforeAll(async () => {
  tmpHome = `/tmp/kdi-ui008-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });

  // AC-14 board: a task with created + promoted events written by the CLI.
  await runCli(["boards", "create", "ac14", "--workdir", tmpHome]);
  const id = await runCli(["create", "CLI task", "--board", "ac14", "--no-dispatcher-warning"]);
  await runCli(["promote", id]);

  // P1-1 boards: boardA has an event; boardB is empty. Both in the same DB.
  await runCli(["boards", "create", "boardA", "--workdir", tmpHome]);
  await runCli(["create", "task on A", "--board", "boardA", "--no-dispatcher-warning"]);
  await runCli(["boards", "create", "boardB", "--workdir", tmpHome]);

  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

// AC-14: events written by the CLI render in the hydrated activity page. SSR
// renders the board header only; the event rows appear only after the client
// fetch, so waiting for them proves hydration.
test("AC-14: CLI-created events render after hydration", async ({ page }: { page: Page }) => {
  await page.goto(`${baseUrl}/activity?board=ac14`);

  // Board header is SSR; assert it first.
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

  // The created + promoted rows for the CLI task must render in the DOM. These
  // rows are absent from SSR (the stream fetches client-side in onMount), so
  // reaching them proves the hydrated client rendered the events.
  await expect(page.locator(".event-row .badge", { hasText: "created" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".event-row .badge", { hasText: "promoted" })).toBeVisible();
  // ac14 has exactly one CLI-created task with created + promoted events; both
  // rows must render, each showing the task id (the stream shows id, not title).
  await expect(page.locator(".event-row")).toHaveCount(2);
  await expect(page.locator(".event-row .event-task", { hasText: "#1" })).toHaveCount(2);
});

// P1-1: client-side navigation between boards must reset the stream so board A's
// events and cursor never bleed into board B. This is the stale-response race
// the boardGen guard exists for: if board A's /events response is still in
// flight when the user navigates to board B, the late response must NOT write
// A's events into B's stream. Full page.goto would remount and hide the bug, so
// we drive SvelteKit's client router with a same-origin link, and use route
// interception to hold A's response until after the navigation.
test("P1-1: a stale board-A response cannot populate board B after navigation", async ({
  page,
}: {
  page: Page;
}) => {
  // Hold boardA's /events response on a controller we release manually. The
  // handler also records when the request arrives so we can deterministically
  // confirm it is in flight before navigating (page.waitForRequest raced with
  // the client router in the full suite).
  let releaseA: () => void = () => {};
  let aRequestReceived = false;
  await page.route("**/api/boards/boardA/events**", async (route) => {
    aRequestReceived = true;
    await new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    await route.continue();
  });

  await page.goto(`${baseUrl}/activity?board=boardB`);
  // Sanity: boardB starts empty and its header is rendered.
  await expect(page.locator("code")).toContainText("boardB");
  await expect(page.locator(".event-row")).toHaveCount(0);

  // Navigate to boardA: the board-change effect fires the boardA /events fetch,
  // which we are holding. Wait until that request reaches our handler.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/activity?board=boardA";
    document.body.appendChild(a);
    a.click();
  });
  await expect(page.locator("code")).toContainText("boardA");
  await expect.poll(() => aRequestReceived, { timeout: 15000 }).toBe(true);

  // While boardA's response is STILL HELD (in flight), navigate back to
  // boardB. resetForBoardChange() bumps boardGen so the in-flight A fetch must
  // be dropped on arrival.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/activity?board=boardB";
    document.body.appendChild(a);
    a.click();
  });
  await expect(page.locator("code")).toContainText("boardB");

  // Now release boardA's held response. This is the decisive moment: without
  // the boardGen guard, the late A response resolves and writes A's 'created'
  // event into B's stream.
  releaseA();

  // Give the held response time to resolve and (if unguarded) render. boardB
  // must stay empty.
  await page.waitForTimeout(1000);
  await expect(page.locator(".event-row")).toHaveCount(0);
  await expect(page.locator(".event-row .badge", { hasText: "created" })).toHaveCount(0);
});
