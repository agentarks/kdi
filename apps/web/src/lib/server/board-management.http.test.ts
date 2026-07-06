// KDI-UI-002 AC-21: board-management UI smoke test.
//
// Runs the full board-management lifecycle through the SvelteKit routes and
// form actions, then cross-checks the results against the CLI on the same
// isolated HOME + KDI_DB. This proves the UI and CLI read and write the same
// SQLite database with identical behavior and flag gating.
//
// SvelteKit enhanced forms return a 200 JSON response describing the action
// result when JavaScript is enabled; a plain form submission would return a 303
// redirect. The helper below accepts either shape as success.
//
// ponytail: one HTTP smoke test per acceptance criterion (AC-21); reuse the
// dev-server spawn pattern from bridge.http.test.ts and CLI helpers from e2e.

import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initDb } from "~/db";
import { createBoardJson } from "./bridge";

const REPO_ROOT = process.cwd(); // tests run from repo root

let proc: ReturnType<typeof Bun.spawn> | null = null;
let tmpHome: string;

const kdiEnv = (): Record<string, string> => ({
  HOME: tmpHome,
  KDI_DB: join(tmpHome, "kdi.sqlite"),
  FF_SVELTEKIT_FRONTEND: "true",
  VITE_FF_SVELTEKIT_FRONTEND: "true",
  FF_BOARD_METADATA: "true",
  FF_BOARD_CREATE_SWITCH: "true",
  FF_BOARD_SWITCH: "true",
  FF_BOARD_RENAME_HERMES: "true",
  FF_BOARD_RENAME: "true",
  FF_DEFAULT_WORKDIR: "true",
  FF_BOARD_RM_DELETE: "true",
});

async function waitAlive(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.ok || r.status === 307 || r.status === 303 || r.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`dev server did not come alive on ${baseUrl} within ${timeoutMs}ms`);
}

async function startServer(): Promise<string> {
  if (proc) {
    try {
      proc.kill(9);
      await proc.exited;
    } catch {
      /* already gone */
    }
    proc = null;
  }
  if (!tmpHome) {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui002-http-"));
  }
  const port = String(50000 + Math.floor(Math.random() * 15000));
  const baseUrl = `http://localhost:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", "run", "dev:web", "--port", port],
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv(), NODE_ENV: "development" },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitAlive(baseUrl);
  return baseUrl;
}

function runKdi(args: string): string {
  const output = execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv() },
  });
  return output.trim();
}

async function postForm(baseUrl: string, path: string, body: Record<string, string>): Promise<Response> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    params.set(key, value);
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: baseUrl,
      referer: `${baseUrl}${path}`,
    },
    body: params.toString(),
    redirect: "manual",
  });
}

interface FormResult {
  status: number;
  location?: string;
  error?: string;
  body: string;
}

async function submitForm(baseUrl: string, path: string, body: Record<string, string>): Promise<FormResult> {
  const res = await postForm(baseUrl, path, body);
  const text = await res.text();
  if (res.status === 303) return { status: 303, body: text };
  if (res.status === 200) {
    try {
      const json = JSON.parse(text);
      if (json.type === "redirect" && json.status === 303) {
        return { status: 303, location: json.location, body: text };
      }
      if (json.type === "failure" && typeof json.status === "number") {
        return { status: json.status, error: json.error?.message ?? json.error, body: text };
      }
    } catch {
      // not JSON
    }
  }
  return { status: res.status, body: text };
}

async function getPage(baseUrl: string, path: string): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`);
  return res.text();
}

function currentBoardFromShow(): string | null {
  const output = runKdi("boards show");
  const match = output.match(/^Board:\s*(\S+)/m);
  return match ? match[1] : null;
}

function extractCount(output: string, status: string): number | null {
  const match = output.match(new RegExp(`\\s${status}:\\s*([0-9]+)`, "m"));
  return match ? Number(match[1]) : null;
}

afterAll(() => {
  if (proc) {
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
    proc = null;
  }
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("KDI-UI-002 board management UI smoke (AC-21)", () => {
  it("init → create → show → switch → edit → rename → archive → hard-delete lifecycle", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "kdi-ui002-http-"));

    // 1. init via DB + create default board (mirrors `kdi init` but keeps the DB open
    // in the test process so the dev server can share the same SQLite connection).
    process.env.HOME = tmpHome;
    process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
    initDb();
    const defaultWorkdir = join(dirname(process.env.KDI_DB), "boards", "default");
    mkdirSync(defaultWorkdir, { recursive: true });
    await createBoardJson({ slug: "default", workdir: defaultWorkdir });

    // 2. create a board through the UI form (with metadata + base ref + switch)
    const baseUrl = await startServer();
    const create = await submitForm(baseUrl, "/boards/new", {
      slug: "ui-smoke",
      workdir: tmpHome,
      baseRef: "origin/main",
      name: "UI Smoke Board",
      description: "Created via UI form",
      switch: "on",
    });
    expect(create.status).toBe(303);

    // 3. verify via kdi boards show that current switched to ui-smoke
    expect(currentBoardFromShow()).toBe("ui-smoke");

    // 4. show detail and verify counts match kdi boards show
    const detailHtml = await getPage(baseUrl, "/boards/ui-smoke");
    expect(detailHtml).toContain("UI Smoke Board");
    expect(detailHtml).toContain("Created via UI form");
    const showOutput = runKdi("boards show ui-smoke");
    for (const status of ["triage", "todo", "ready", "running", "done", "blocked", "review", "scheduled", "archived"]) {
      const count = extractCount(showOutput, status);
      expect(detailHtml).toContain(`${status}: ${count}`);
    }

    // 5. create another board via CLI and switch to it via UI
    runKdi('boards create other-board --workdir "' + tmpHome + '"');
    const switch1 = await submitForm(baseUrl, "/boards/other-board?/switch", {});
    expect(switch1.status).toBe(303);
    expect(currentBoardFromShow()).toBe("other-board");

    // 6. switch back to ui-smoke so it is the current board for the rename-slug test
    const switch2 = await submitForm(baseUrl, "/boards/ui-smoke?/switch", {});
    expect(switch2.status).toBe(303);
    expect(currentBoardFromShow()).toBe("ui-smoke");

    // 7. edit name + description
    const edit = await submitForm(baseUrl, "/boards/ui-smoke/edit?/metadata", {
      name: "Renamed UI Smoke",
      description: "Updated description",
      icon: "",
      color: "",
    });
    expect(edit.status).toBe(303);
    const updatedShow = runKdi("boards show ui-smoke");
    expect(updatedShow).toContain("Renamed UI Smoke");
    expect(updatedShow).toContain("Updated description");

    // 8. set then clear default workdir
    const setWorkdir = await submitForm(baseUrl, "/boards/ui-smoke/edit?/defaultWorkdir", { workdir: join(tmpHome, "default") });
    expect(setWorkdir.status).toBe(303);
    const withWorkdir = runKdi("boards show ui-smoke");
    expect(withWorkdir).toContain(join(tmpHome, "default"));

    const clearWorkdir = await submitForm(baseUrl, "/boards/ui-smoke/edit?/defaultWorkdir", { workdir: "" });
    expect(clearWorkdir.status).toBe(303);
    const clearedWorkdir = runKdi("boards show ui-smoke");
    expect(clearedWorkdir).not.toContain("Default workdir");

    // 9. rename display name
    const rename = await submitForm(baseUrl, "/boards/ui-smoke?/rename", { name: "Display Name Rename" });
    expect(rename.status).toBe(303);
    const renamed = runKdi("boards show ui-smoke");
    expect(renamed).toContain("Display Name Rename");

    // 10. rename slug of the current board and verify current moved
    const renameSlug = await submitForm(baseUrl, "/boards/ui-smoke?/renameSlug", { newSlug: "new-slug" });
    expect(renameSlug.status).toBe(303);
    expect(renameSlug.location).toContain("/boards/new-slug");
    expect(currentBoardFromShow()).toBe("new-slug");
    expect(runKdi("boards show new-slug")).toContain("Display Name Rename");

    // 11. archive a board
    const archive = await submitForm(baseUrl, "/boards/other-board?/archive", { confirm: "true" });
    expect(archive.status).toBe(303);
    const listAll = runKdi("boards list --all");
    expect(listAll).toContain("other-board");
    expect(listAll).toContain("archived");
    const listDefault = runKdi("boards list");
    expect(listDefault).not.toContain("other-board");

    // 12. hard-delete another board with a wrong-then-right typed slug
    runKdi('boards create delete-me --workdir "' + tmpHome + '"');
    const wrongDelete = await submitForm(baseUrl, "/boards/delete-me?/delete", { confirmedSlug: "wrong-slug" });
    expect(wrongDelete.status).toBe(400);
    expect(runKdi("boards list --all")).toContain("delete-me");

    const rightDelete = await submitForm(baseUrl, "/boards/delete-me?/delete", { confirmedSlug: "delete-me" });
    expect(rightDelete.status).toBe(303);
    const finalList = runKdi("boards list --all");
    expect(finalList).not.toContain("delete-me");

    // 13. board detail page for deleted board renders not-found UI
    const deletedHtml = await getPage(baseUrl, "/boards/delete-me");
    expect(deletedHtml).toContain("Board not found");
  }, 120000);
});
