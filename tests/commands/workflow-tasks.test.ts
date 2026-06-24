import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../src/db";
import { cleanupDb, restoreEnv } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { defineWorkflowTemplate } from "../../src/models/workflowTemplate";
import { createTaskCommand, showTaskCommand, stepTaskCommand, listTasksCommand } from "../../src/commands/tasks";
import { workflowsCommand } from "../../src/commands/workflows";
import { setFlag, clearOverrides, FF_WORKFLOW_TEMPLATES } from "../../src/flags";

const TEST_DB = "/tmp/kdi-commands-workflow-tasks-test.db";
const ORIGINAL_KDI_DB = process.env.KDI_DB;

const COMMANDS_TO_RESET = [createTaskCommand, showTaskCommand, stepTaskCommand, listTasksCommand, workflowsCommand];

function resetCommandOptions(cmd: unknown): void {
  const defaults: Record<string, unknown> = {};
  for (const option of (cmd as any).options ?? []) {
    if (option.defaultValue !== undefined) {
      defaults[option.attributeName()] = option.defaultValue;
    }
  }
  (cmd as any)._optionValues = defaults;
  for (const sub of (cmd as any).commands ?? []) {
    resetCommandOptions(sub);
  }
}

function resetAllCommandOptions(): void {
  for (const cmd of COMMANDS_TO_RESET) {
    resetCommandOptions(cmd);
  }
}

describe("KDI-039 workflow task commands", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    resetAllCommandOptions();
    initDb(TEST_DB);
  });

  afterEach(() => {
    clearOverrides();
    closeDb();
    cleanupDb(TEST_DB);
    restoreEnv("KDI_DB", ORIGINAL_KDI_DB);
  });

  it("create --workflow-template-id starts at first step when flag enabled", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review", "deploy"]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync([
        "Onboard user", "--board", "wf-board", "--workflow-template-id", "onboarding",
      ], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const taskId = Number(logs[0]);
    expect(taskId).toBeGreaterThan(0);

    const { showTask } = await import("../../src/models/task");
    const task = showTask(taskId);
    expect(task!.workflow_template_id).toBe("onboarding");
    expect(task!.current_step_key).toBe("setup");
  });

  it("create --workflow-template-id --step-key starts at explicit step", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review", "deploy"]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await createTaskCommand.parseAsync([
        "Onboard user", "--board", "wf-board", "--workflow-template-id", "onboarding", "--step-key", "review",
      ], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const taskId = Number(logs[0]);
    const { showTask } = await import("../../src/models/task");
    const task = showTask(taskId);
    expect(task!.current_step_key).toBe("review");
  });

  it("create --workflow-template-id rejects missing step key", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup"]);

    const originalExitCallback = (createTaskCommand as any)._exitCallback;
    createTaskCommand.exitOverride();

    let message: string | undefined;
    try {
      await createTaskCommand.parseAsync([
        "Onboard user", "--board", "wf-board", "--workflow-template-id", "onboarding", "--step-key", "missing",
      ], { from: "user" });
    } catch (err: any) {
      message = err.message;
    } finally {
      (createTaskCommand as any)._exitCallback = originalExitCallback;
    }

    expect(message).toContain('Step "missing" not found');
  });

  it("create --workflow-template-id is gated when flag disabled", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, false);
    createBoard("wf-board", "/tmp/wf-board");

    const originalExitCallback = (createTaskCommand as any)._exitCallback;
    createTaskCommand.exitOverride();

    let message: string | undefined;
    try {
      await createTaskCommand.parseAsync([
        "Onboard user", "--board", "wf-board", "--workflow-template-id", "onboarding",
      ], { from: "user" });
    } catch (err: any) {
      message = err.message;
    } finally {
      (createTaskCommand as any)._exitCallback = originalExitCallback;
    }

    expect(message).toContain("Workflow templates feature is not enabled");
  });

  it("step advances to next step", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review"]);

    const { createTask } = await import("../../src/models/task");
    const task = createTask({
      board_id: 1,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "setup",
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await stepTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Advanced task") && l.includes("review"))).toBe(true);
  });

  it("step completes task at terminal step", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review"]);

    const { createTask } = await import("../../src/models/task");
    const task = createTask({
      board_id: 1,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "review",
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await stepTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Completed task"))).toBe(true);
  });

  it("step --to jumps to a specific step", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review", "deploy"]);

    const { createTask } = await import("../../src/models/task");
    const task = createTask({
      board_id: 1,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "deploy",
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await stepTaskCommand.parseAsync([String(task.id), "--to", "setup"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Set task") && l.includes("setup"))).toBe(true);
  });

  it("show displays workflow fields when flag enabled", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    createBoard("wf-board", "/tmp/wf-board");

    const { createTask } = await import("../../src/models/task");
    const task = createTask({
      board_id: 1,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "setup",
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await showTaskCommand.parseAsync([String(task.id)], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const output = logs.join(" ");
    expect(output.includes("Workflow template: onboarding")).toBe(true);
    expect(output.includes("Current step: setup")).toBe(true);
  });

  it("create populates columns surfaced by kdi list filters", async () => {
    setFlag(FF_WORKFLOW_TEMPLATES, true);
    setFlag("FF_LIST_FILTERS_SORT", true);
    createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review"]);

    await createTaskCommand.parseAsync([
      "Onboard user", "--board", "wf-board", "--workflow-template-id", "onboarding",
    ], { from: "user" });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
      await listTasksCommand.parseAsync([
        "--board", "wf-board", "--workflow-template-id", "onboarding", "--step-key", "setup",
      ], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("Onboard user"))).toBe(true);
  });
});
