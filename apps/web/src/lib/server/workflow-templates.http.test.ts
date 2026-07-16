// KDI-UI-013 Slice 1 HTTP smoke (AC-01..AC-06, AC-13, AC-14, AC-15).
//
// Spawns `bun run dev:web` against an isolated temp HOME + KDI_DB with
// FF_WORKFLOW_TEMPLATES=true, creates a board via the CLI, exercises the
// SvelteKit define form action the way a browser does, and cross-checks every
// step against `kdi workflows list` on the same DB. Proves the UI and CLI read
// and write the same SQLite database with identical behavior.
//
// Process lifecycle: one shared server for the flags-on suite; each flag-off
// config gets its own single-test describe with its own server. Matches the
// notify-subs.http.test.ts killTree template so no Vite grandchild is orphaned.

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "~/db";
import { createBoardJson } from "./bridge";

const REPO_ROOT = process.cwd();

function makeTmpHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `kdi-ui013-${label}-`));
  process.env.HOME = home;
  process.env.KDI_DB = join(home, "kdi.sqlite");
  return home;
}

function kdiEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    KDI_DB: join(home, "kdi.sqlite"),
    FF_SVELTEKIT_FRONTEND: "true",
    VITE_FF_SVELTEKIT_FRONTEND: "true",
    FF_WORKFLOW_TEMPLATES: "true",
  };
}

function runKdi(home: string, args: string): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(home) },
  }).trim();
}

function workflowsListJson(home: string, slug: string): Array<{ template_id: string; name: string; steps: string[] }> {
  return JSON.parse(runKdi(home, `workflows list --board ${slug} --json`)).templates;
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
    let survivors: string[] = [];
    try {
      survivors = execSync(`pgrep -f "vite dev --port ${port}" 2>/dev/null || true`, { encoding: "utf8" })
        .split("\n").map((s) => s.trim()).filter((s) => s !== "");
    } catch { /* none */ }
    if (survivors.length > 0) {
      try { execSync(`pkill -9 -f "vite dev --port ${port}" >/dev/null 2>&1 || true`); } catch { /* none */ }
      console.warn(`[workflow-templates.http.test] killed ${survivors.length} lingering vite process(es) on port ${port}`);
    }
  };
  return { baseUrl, cleanup };
}

async function submitForm(baseUrl: string, path: string, body: Record<string, string>): Promise<{ status: number; ok: boolean; error?: string }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, v);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: baseUrl, referer: `${baseUrl}${path}` },
    body: params.toString(),
    redirect: "manual",
  });
  const text = await res.text();
  if (res.status === 303) return { status: 303, ok: true };
  if (res.status === 200) {
    try {
      const json = JSON.parse(text);
      if (json.type === "redirect" || json.type === "success") return { status: 303, ok: true };
      if (json.type === "failure") {
        const data = typeof json.data === "string" ? JSON.parse(json.data) : json.data;
        const msg = Array.isArray(data) ? data[1] : data?.error?.message ?? data?.error;
        return { status: json.status, ok: false, error: msg };
      }
    } catch { /* not JSON */ }
  }
  return { status: res.status, ok: false, error: text.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Shared flags-on suite.
// ---------------------------------------------------------------------------

describe("KDI-UI-013 Slice 1 workflows UI smoke (AC-01..AC-06)", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("http");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    await createBoardJson({ slug: "emptyboard", workdir: home });
    // Seed a template via the CLI so the GET list has something to render.
    runKdi(home, 'workflows define code-review --name "Code review" --steps \'["review","fix","merge"]\' --board demo');
    ({ baseUrl, cleanup } = await spawnServer(home));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("AC-02: GET /boards/[slug]/workflows renders template id/name/steps; matches kdi list", async () => {
    const html = await (await fetch(`${baseUrl}/boards/demo/workflows`)).text();
    expect(html).toContain("code-review");
    expect(html).toContain("Code review");
    expect(html).toContain("review → fix → merge");
    // CLI parity on the same DB.
    const cli = workflowsListJson(home, "demo");
    expect(cli).toHaveLength(1);
    expect(cli[0].template_id).toBe("code-review");
    expect(cli[0].steps).toEqual(["review", "fix", "merge"]);
  }, 120000);

  it("Gap 3: board view links to /boards/[slug]/workflows", async () => {
    const html = await (await fetch(`${baseUrl}/boards/demo`)).text();
    expect(html).toContain('href="/boards/demo/workflows"');
  }, 120000);

  it("AC-03: empty state — a board with no templates shows the empty message", async () => {
    const html = await (await fetch(`${baseUrl}/boards/emptyboard/workflows`)).text();
    expect(html).toContain("No workflow templates");
  }, 120000);

  it("AC-04/AC-05: define new then upsert via the form; kdi list reflects both", async () => {
    const created = await submitForm(baseUrl, `/boards/demo/workflows?/define`, {
      template_id: "ship",
      name: "Ship it",
      steps: "build\ntest\nrelease",
    });
    expect(created.ok).toBe(true);
    let cli = workflowsListJson(home, "demo");
    expect(cli.find((t) => t.template_id === "ship")).toMatchObject({
      template_id: "ship", name: "Ship it", steps: ["build", "test", "release"],
    });
    let html = await (await fetch(`${baseUrl}/boards/demo/workflows`)).text();
    expect(html).toContain("Ship it");
    // FR-13: success toast renders after the redirect (regression guard for the
    // ?success= query-param path that the gpt-5.6-sol frontend review caught).
    html = await (await fetch(`${baseUrl}/boards/demo/workflows?success=${encodeURIComponent("Template saved")}`)).text();
    expect(html).toContain("Template saved");
    expect(html).toMatch(/role="status"/);

    // Upsert (FR-8): same id, new name + steps.
    const upserted = await submitForm(baseUrl, `/boards/demo/workflows?/define`, {
      template_id: "ship",
      name: "Ship it v2",
      steps: "build",
    });
    expect(upserted.ok).toBe(true);
    cli = workflowsListJson(home, "demo");
    expect(cli.filter((t) => t.template_id === "ship")).toHaveLength(1);
    expect(cli.find((t) => t.template_id === "ship")?.name).toBe("Ship it v2");
    html = await (await fetch(`${baseUrl}/boards/demo/workflows`)).text();
    expect(html).toContain("Ship it v2");
  }, 120000);

  it("AC-06: invalid template id shows inline role=alert error and creates nothing", async () => {
    const before = workflowsListJson(home, "demo").length;
    const res = await submitForm(baseUrl, `/boards/demo/workflows?/define`, {
      template_id: "bad id!",
      name: "N",
      steps: "a",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid template id");

    // The action also re-renders the page with an inline role=alert error when
    // a browser submits the form (Accept: text/html), preserving values.
    const htmlRes = await fetch(`${baseUrl}/boards/demo/workflows?/define`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        origin: baseUrl,
        referer: `${baseUrl}/boards/demo/workflows`,
      },
      body: new URLSearchParams({ template_id: "bad id!", name: "N", steps: "a" }).toString(),
      redirect: "manual",
    });
    const html = await htmlRes.text();
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain("Invalid template id");
    // Preserved value (FR-13): the typed template_id is echoed back, not blank.
    expect(html).toContain('value="bad id!"');
    expect(html).toContain('name="template_id"');
    expect(workflowsListJson(home, "demo").length).toBe(before);
  }, 120000);
});

// ---------------------------------------------------------------------------
// Flag-off suites: each owns one server start/stop with the alternate flag env.
// ---------------------------------------------------------------------------

describe("KDI-UI-013 flag gate (AC-13): FF_WORKFLOW_TEMPLATES=false", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("wtoff");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    runKdi(home, 'workflows define t --name T --steps \'["a"]\' --board demo');
    ({ baseUrl, cleanup } = await spawnServer(home, { FF_WORKFLOW_TEMPLATES: "false" }));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("page shows the disabled message and define POST is rejected (403), no template written", async () => {
    const html = await (await fetch(`${baseUrl}/boards/demo/workflows`)).text();
    expect(html).toContain("Workflow templates feature is not enabled");
    const before = workflowsListJson(home, "demo").length;
    const res = await submitForm(baseUrl, `/boards/demo/workflows?/define`, {
      template_id: "blocked",
      name: "Blocked",
      steps: "a",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toBe("Workflow templates feature is not enabled.");
    expect(workflowsListJson(home, "demo").length).toBe(before);
  }, 120000);
});

describe("KDI-UI-013 flag gate (AC-13): FF_SVELTEKIT_FRONTEND=false", () => {
  let home: string;
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    home = makeTmpHome("masteroff");
    initDb();
    await createBoardJson({ slug: "demo", workdir: home });
    ({ baseUrl, cleanup } = await spawnServer(home, {
      FF_SVELTEKIT_FRONTEND: "false",
      VITE_FF_SVELTEKIT_FRONTEND: "false",
    }));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("redirects /boards/[slug]/workflows to /disabled and blocks the define action", async () => {
    const g = await fetch(`${baseUrl}/boards/demo/workflows`, { redirect: "manual" });
    expect(g.status).toBe(307);
    expect(g.headers.get("location")).toBe("/disabled");

    const p = await fetch(`${baseUrl}/boards/demo/workflows?/define`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: baseUrl, referer: `${baseUrl}/boards/demo/workflows` },
      body: new URLSearchParams({ template_id: "x", name: "X", steps: "a" }).toString(),
      redirect: "manual",
    });
    const pBody = (await p.json()) as { type: string; status: number; location: string };
    expect(pBody.type).toBe("redirect");
    expect(pBody.status).toBe(307);
    expect(pBody.location).toBe("/disabled");
    expect(workflowsListJson(home, "demo")).toHaveLength(0);
  }, 120000);
});