import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { closeDb } from "~/db";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", ".."); // repo root

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;
let port: string;
let baseUrl: string;

function randomPort(): string {
  return String(50000 + Math.floor(Math.random() * 15000));
}

async function waitAlive(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on :${port} within ${timeoutMs}ms`);
}

async function stopServer(): Promise<void> {
  if (proc) {
    try {
      // Kill the entire process group (setsid created a new session)
      process.kill(-proc.pid, 9);
      await proc.exited;
    } catch {
      /* already gone */
    }
    proc = null;
  }
  await new Promise((res) => setTimeout(res, 500));
}

async function startServer(): Promise<void> {
  await stopServer();
  if (!tmpHome) {
    tmpHome = `/tmp/kdi-ui005-http-${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(tmpHome, { recursive: true });
  }
  port = randomPort();
  baseUrl = `http://localhost:${port}`;
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  // Use sh -c with exec in a subshell to create a new process group
  proc = Bun.spawn({
    cmd: ["sh", "-c", `exec bun run dev:web --port ${port}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: "true",
      NODE_ENV: "development",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitAlive();
}

async function runCli(args: string[]): Promise<string> {
  const p = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "src/index.ts"), ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      KDI_DB: join(tmpHome, "kdi.sqlite"),
      FF_SVELTEKIT_FRONTEND: "true",
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const exitCode = await p.exited;
  const output = await Bun.readableStreamToText(p.stdout);
  if (exitCode !== 0) {
    throw new Error(`CLI command failed: kdi ${args.join(" ")}`);
  }
  return output.trim();
}

afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-005 HTTP smoke (dev server, isolated HOME/KDI_DB)", () => {
  it("creates a task via CLI and renders the detail panel", async () => {
    closeDb();
    await startServer();

    await runCli(["boards", "create", "smoke-detail", "--workdir", tmpHome]);
    const taskIdOutput = await runCli([
      "create",
      "Detail smoke task",
      "--board",
      "smoke-detail",
      "--body",
      "Smoke body text",
    ]);
    const taskId = Number(taskIdOutput);
    expect(Number.isInteger(taskId)).toBe(true);
    expect(taskId).toBeGreaterThan(0);

    // Aggregate endpoint returns full snapshot.
    const detailRes = await fetch(`${baseUrl}/api/boards/smoke-detail/tasks/${taskId}/detail`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      task: { title: string; body: string | null; status: string };
    };
    expect(detail.task.title).toBe("Detail smoke task");
    expect(detail.task.body).toBe("Smoke body text");
    expect(detail.task.status).toBe("todo");

    // Detail page renders the title, status, and body in HTML.
    const pageRes = await fetch(`${baseUrl}/tasks/${taskId}?board=smoke-detail`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toInclude("Detail smoke task");
    expect(html).toInclude("Smoke body text");
    expect(html).toInclude("todo");

    await stopServer();
  }, 60000);

  it("shows blocked-by-dependency visual indication when a blocked task has non-done parents", async () => {
    closeDb();
    await startServer();

    await runCli(["boards", "create", "smoke-blocked", "--workdir", tmpHome]);
    const parentIdOutput = await runCli(["create", "Parent task", "--board", "smoke-blocked"]);
    const parentId = Number(parentIdOutput);
    expect(Number.isInteger(parentId)).toBe(true);
    expect(parentId).toBeGreaterThan(0);

    const childIdOutput = await runCli([
      "create",
      "Blocked child task",
      "--board",
      "smoke-blocked",
      "--parent",
      String(parentId),
    ]);
    const childId = Number(childIdOutput);
    expect(Number.isInteger(childId)).toBe(true);
    expect(childId).toBeGreaterThan(0);

    await runCli(["block", String(childId), "--reason", "waiting on parent"]);

    const pageRes = await fetch(`${baseUrl}/tasks/${childId}?board=smoke-blocked`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toInclude("Blocked by dependencies");
    expect(html).toInclude("blocking");
    expect(html).toInclude("Parent task");

    await stopServer();
  }, 60000);
});
