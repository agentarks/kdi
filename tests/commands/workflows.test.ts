import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../src/db";
import { cleanupDb } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { defineWorkflowCommand, listWorkflowsCommand } from "../../src/commands/workflows";
import { setFlag, clearOverrides, FF_WORKFLOW_TEMPLATES } from "../../src/flags";

const TEST_DB = "/tmp/kdi-commands-workflows-test.db";

const COMMANDS_TO_RESET = [defineWorkflowCommand, listWorkflowsCommand];

const commandOptionDefaults = new Map<unknown, Record<string, unknown>>();
for (const cmd of COMMANDS_TO_RESET) {
  commandOptionDefaults.set(cmd, { ...(cmd as { _optionValues: Record<string, unknown> })._optionValues });
}

function resetCommandOptions(): void {
  for (const cmd of COMMANDS_TO_RESET) {
    (cmd as { _optionValues: Record<string, unknown> })._optionValues = { ...commandOptionDefaults.get(cmd) };
  }
}

describe("workflows commands", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    resetCommandOptions();
    initDb(TEST_DB);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(TEST_DB);
    delete process.env.KDI_DB;
  });

  it("define creates a template when flag enabled", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await defineWorkflowCommand.parseAsync([
        "onboarding", "--board", "wf-board", "--name", "Onboarding", "--steps", '["setup","review","deploy"]',
      ], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Defined workflow template onboarding"))).toBe(true);
  });

  it("define is gated when flag disabled", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, false);
    createBoard("wf-board", "/tmp/wf-board");

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    let exited = false;
    const originalExit = process.exit;
    process.exit = ((code?: number) => { exited = true; throw new Error(`exit:${code}`); }) as typeof process.exit;

    try {
      await defineWorkflowCommand.parseAsync([
        "onboarding", "--board", "wf-board", "--name", "Onboarding", "--steps", '["setup"]',
      ], { from: "user" });
    } catch {
      // expected
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }

    expect(errors.some((e) => e.includes("Workflow templates feature is not enabled"))).toBe(true);
  });

  it("list prints templates when flag enabled", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");

    await defineWorkflowCommand.parseAsync([
      "onboarding", "--board", "wf-board", "--name", "Onboarding", "--steps", '["setup","review"]',
    ], { from: "user" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listWorkflowsCommand.parseAsync(["--board", "wf-board"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const output = logs.join(" ");
    expect(output.includes("onboarding")).toBe(true);
    expect(output.includes("setup")).toBe(true);
    expect(output.includes("review")).toBe(true);
  });

  it("list outputs json when requested", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");

    await defineWorkflowCommand.parseAsync([
      "onboarding", "--board", "wf-board", "--name", "Onboarding", "--steps", '["setup"]',
    ], { from: "user" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listWorkflowsCommand.parseAsync(["--board", "wf-board", "--json"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(logs[0]);
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.templates[0].template_id).toBe("onboarding");
  });
});
