// KDI-UI-013 Slice 1: workflow templates bridge unit tests.
// Calls defineWorkflowTemplateJson / workflowsJson directly under Bun against an
// isolated temp HOME + KDI_DB, and cross-checks every step against the CLI
// (`kdi workflows define/list --board <slug>`) on the same DB. Proves the UI
// bridge and CLI read and write the same SQLite database with identical
// validation (FR-1..FR-13, AC-01..AC-06, AC-13).

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  createBoardJson,
  workflowsJson,
  defineWorkflowTemplateJson,
  BridgeError,
} from "./bridge";
import { clearOverrides } from "~/flags";

const REPO_ROOT = process.cwd();

let tmpHome: string;

function isolate(): void {
  tmpHome = `/tmp/kdi-ui013-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  process.env.FF_WORKFLOW_TEMPLATES = "true";
  clearOverrides();
}

function cleanup(): void {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
}

function kdiEnv(): Record<string, string> {
  return {
    HOME: tmpHome,
    KDI_DB: join(tmpHome, "kdi.sqlite"),
    FF_WORKFLOW_TEMPLATES: "true",
  };
}

function runKdi(args: string): string {
  return execSync(`bun run src/index.ts ${args}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...kdiEnv() },
  }).trim();
}

// CLI wraps model errors as `Error: <message>` on stderr and exits 1.
function runKdiFail(args: string): string {
  try {
    execSync(`bun run src/index.ts ${args}`, {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: { ...process.env, ...kdiEnv() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error(`expected CLI to fail: ${args}`);
  } catch (e: any) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    return stderr.replace(/^Error:\s*/, "");
  }
}

beforeEach(isolate);
afterAll(cleanup);

describe("KDI-UI-013 Slice 1: workflows bridge parity with CLI", () => {
  it("AC-01/AC-02: workflowsJson lists templates and matches `kdi workflows list --json`", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    await defineWorkflowTemplateJson("demo", {
      templateId: "code-review",
      name: "Code review",
      steps: ["review", "fix", "merge"],
    });

    const { templates } = await workflowsJson("demo");
    expect(templates).toHaveLength(1);
    expect(templates[0].templateId).toBe("code-review");
    expect(templates[0].name).toBe("Code review");
    expect(templates[0].steps).toEqual(["review", "fix", "merge"]);

    // CLI parity on the same DB.
    const cli = JSON.parse(runKdi("workflows list --board demo --json"));
    expect(cli.board).toBe("demo");
    expect(cli.templates).toHaveLength(1);
    expect(cli.templates[0].template_id).toBe("code-review");
    expect(cli.templates[0].name).toBe("Code review");
    expect(cli.templates[0].steps).toEqual(["review", "fix", "merge"]);
  });

  it("AC-03: empty state — no templates returns an empty list", async () => {
    await createBoardJson({ slug: "empty", workdir: tmpHome });
    const { templates } = await workflowsJson("empty");
    expect(templates).toEqual([]);
  });

  it("AC-04/AC-05: define new then upsert updates name/steps; CLI list reflects it", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    const { template } = await defineWorkflowTemplateJson("demo", {
      templateId: "ship",
      name: "Ship it",
      steps: ["build"],
    });
    expect(template.templateId).toBe("ship");
    expect(template.steps).toEqual(["build"]);

    // Upsert (FR-8): same id, new name + steps.
    const { template: updated } = await defineWorkflowTemplateJson("demo", {
      templateId: "ship",
      name: "Ship it v2",
      steps: ["build", "test", "release"],
    });
    expect(updated.name).toBe("Ship it v2");
    expect(updated.steps).toEqual(["build", "test", "release"]);

    // Only one template, with the updated values.
    const { templates } = await workflowsJson("demo");
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Ship it v2");

    const cli = JSON.parse(runKdi("workflows list --board demo --json"));
    expect(cli.templates).toHaveLength(1);
    expect(cli.templates[0].name).toBe("Ship it v2");
    expect(cli.templates[0].steps).toEqual(["build", "test", "release"]);
  });

  it("AC-06: each define validation error throws BridgeError with the exact CLI message", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });

    const cases: Array<{ label: string; input: { templateId: string; name: string; steps: string[] }; cliArgs: string }> = [
      { label: "bad template id", input: { templateId: "bad id!", name: "N", steps: ["a"] }, cliArgs: "workflows define 'bad id!' --name N --steps '[\"a\"]' --board demo" },
      { label: "empty name", input: { templateId: "t1", name: "   ", steps: ["a"] }, cliArgs: "workflows define t1 --name '   ' --steps '[\"a\"]' --board demo" },
      { label: "empty steps", input: { templateId: "t2", name: "N", steps: [] }, cliArgs: "workflows define t2 --name N --steps '[]' --board demo" },
      { label: "duplicate step keys", input: { templateId: "t3", name: "N", steps: ["a", "a"] }, cliArgs: "workflows define t3 --name N --steps '[\"a\",\"a\"]' --board demo" },
      { label: "step key >255", input: { templateId: "t4", name: "N", steps: ["x".repeat(256)] }, cliArgs: `workflows define t4 --name N --steps '["${"x".repeat(256)}"]' --board demo` },
    ];

    for (const c of cases) {
      const cliMsg = runKdiFail(c.cliArgs);
      let bridgeMsg = "";
      try {
        await defineWorkflowTemplateJson("demo", c.input);
        throw new Error(`expected bridge to reject: ${c.label}`);
      } catch (err) {
        if (!(err instanceof BridgeError)) throw err;
        expect(err.code).toBe("invalid_input");
        expect(err.status).toBe(400);
        bridgeMsg = err.message;
      }
      // Exact parity with the CLI error string (FR-10..FR-12).
      expect(bridgeMsg).toBe(cliMsg);
    }
  });

  it("AC-13: FF_WORKFLOW_TEMPLATES=false rejects define with the disabled message", async () => {
    await createBoardJson({ slug: "demo", workdir: tmpHome });
    process.env.FF_WORKFLOW_TEMPLATES = "false";
    clearOverrides();
    let code = "";
    let status = 0;
    let msg = "";
    try {
      await defineWorkflowTemplateJson("demo", { templateId: "x", name: "X", steps: ["a"] });
      throw new Error("expected bridge to reject when flag off");
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
      code = err.code;
      status = err.status;
      msg = err.message;
    }
    expect(code).toBe("feature_disabled");
    expect(status).toBe(400);
    expect(msg).toBe("Workflow templates feature is not enabled.");
    process.env.FF_WORKFLOW_TEMPLATES = "true";
    clearOverrides();
  });
});