// KDI-UI-013 Slice 3 AC-09..AC-12: workflow step action UI HTTP smoke test.
//
// Spawns `bun run dev:web` against an isolated HOME + KDI_DB, seeds a board +
// workflow template + a template-bound task (via the bridge, mirror of the
// CLI), then drives advance / jump / advance-to-terminal through the
// `/api/boards/[slug]/tasks/[id]/step` route and cross-checks EACH transition
// against `kdi show` on the same DB.
//
// Pattern copied from task-lifecycle-actions.http.test.ts.
import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "~/db";
import { createBoardJson, createTaskJson } from "./bridge";
import { defineWorkflowTemplate } from "~/models/workflowTemplate";

const WORKTREE_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;
let port: string;
let baseUrl: string;

const kdiEnv = (): Record<string, string> => ({
  HOME: tmpHome,
  KDI_DB: join(tmpHome, "kdi.sqlite"),
  FF_SVELTEKIT_FRONTEND: "true",
  VITE_FF_SVELTEKIT_FRONTEND: "true",
  FF_WORKFLOW_TEMPLATES: "true",
});

async function waitAlive(timeoutMs = 60000): Promise<void> {
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
    try { process.kill(-proc.pid, 9); await proc.exited; } catch { /* already gone */ }
    proc = null;
  }
  await new Promise((res) => setTimeout(res, 500));
}

async function startServer(flags: Record<string, string> = {}): Promise<void> {
  await stopServer();
  port = String(50000 + Math.floor(Math.random() * 15000));
  baseUrl = `http://localhost:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: WORKTREE_ROOT,
    detached: true,
    env: { ...process.env, ...kdiEnv(), ...flags, NODE_ENV: "development" },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitAlive();
}

function runKdi(args: string): string {
  return execSync(`bun ${join(WORKTREE_ROOT, "src/index.ts")} ${args}`, {
    encoding: "utf-8",
    cwd: WORKTREE_ROOT,
    env: { ...process.env, ...kdiEnv() },
    timeout: 30000,
  }).trim();
}

function showField(id: number, field: "Status" | "Current step" | "Workflow template"): string | null {
  const out = runKdi(`show ${id}`);
  const match = out.match(new RegExp(`^${field}:\\s*(\\S.*)$`, "m"));
  return match ? match[1].trim() : null;
}

interface StepResponse {
  task: { id: number; status: string; currentStepKey: string | null; workflowTemplateId: string | null };
  message: string;
}

async function postStep(slug: string, id: number, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: StepResponse | { error: string; message: string } }> {
  const r = await fetch(`${baseUrl}/api/boards/${slug}/tasks/${id}/step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await r.json().catch(() => ({}))) as StepResponse | { error: string; message: string };
  return { ok: r.ok, status: r.status, data };
}

afterAll(async () => {
  await stopServer();
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-013 Slice 3 step action over HTTP, cross-checked with kdi show", () => {
  it("advance advances, jump moves with reason, advance-to-terminal completes (AC-09..AC-12)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui013-s3-http-"));
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const { board } = await createBoardJson({ slug: "wf", workdir: tmpHome });
    defineWorkflowTemplate(board.id, "release", "release flow", ["draft", "review", "ship"]);
    const { task } = await createTaskJson("wf", { title: "release task", workflowTemplateId: "release", stepKey: "draft" });
    closeDb();

    await startServer();

    // AC-09: advance draft → review
    const adv1 = await postStep("wf", task.id, { action: "advance" });
    expect(adv1.ok).toBe(true);
    expect((adv1.data as StepResponse).task.currentStepKey).toBe("review");
    expect((adv1.data as StepResponse).message).toBe(`Advanced task ${task.id} to step review.`);
    expect(showField(task.id, "Current step")).toBe("review");

    // AC-11: jump back to draft with a reason (event recorded; cross-check via kdi show step)
    const jmp = await postStep("wf", task.id, { action: "jump", targetKey: "draft", reason: "rework" });
    expect(jmp.ok).toBe(true);
    expect((jmp.data as StepResponse).task.currentStepKey).toBe("draft");
    expect((jmp.data as StepResponse).message).toBe(`Set task ${task.id} to step draft.`);
    expect(showField(task.id, "Current step")).toBe("draft");

    // Advance again → review → ship → terminal done (AC-10)
    await postStep("wf", task.id, { action: "advance" }); // draft → review
    await postStep("wf", task.id, { action: "advance" }); // review → ship
    const term = await postStep("wf", task.id, { action: "advance" }); // ship → terminal
    expect(term.ok).toBe(true);
    expect((term.data as StepResponse).task.status).toBe("done");
    expect((term.data as StepResponse).task.currentStepKey).toBeNull();
    expect((term.data as StepResponse).message).toBe(`Completed task ${task.id} at terminal workflow step.`);
    expect(showField(task.id, "Status")).toBe("done");
    expect(showField(task.id, "Current step")).toBeNull();
  });

  it("jump to an unknown step rejects with the CLI error and does not mutate (AC-12)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui013-s3-http-err-"));
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const { board } = await createBoardJson({ slug: "wf2", workdir: tmpHome });
    defineWorkflowTemplate(board.id, "flow", "flow name", ["a", "b"]);
    const { task } = await createTaskJson("wf2", { title: "t", workflowTemplateId: "flow", stepKey: "a" });
    closeDb();

    await startServer();
    const bad = await postStep("wf2", task.id, { action: "jump", targetKey: "zzz" });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
    expect((bad.data as { message: string }).message).toMatch(/Step "zzz" not found in workflow template "flow"\. Valid steps: a, b/);
    // No state change.
    expect(showField(task.id, "Current step")).toBe("a");
  });

  it("FF_WORKFLOW_TEMPLATES=false → step action rejects with the disabled message (FR-24 / AC-13)", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui013-s3-http-flag-"));
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const { board } = await createBoardJson({ slug: "wf3", workdir: tmpHome });
    defineWorkflowTemplate(board.id, "flow", "flow name", ["a", "b"]);
    const { task } = await createTaskJson("wf3", { title: "t", workflowTemplateId: "flow", stepKey: "a" });
    closeDb();

    await startServer({ FF_WORKFLOW_TEMPLATES: "false" });
    const r = await postStep("wf3", task.id, { action: "advance" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect((r.data as { message: string }).message).toMatch(/Workflow templates feature is not enabled\./);
  });
});