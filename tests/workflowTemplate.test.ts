import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import type { TaskEvent } from "../src/models/taskEvent";
import {
  WorkflowTemplate,
  defineWorkflowTemplate,
  listWorkflowTemplates,
  getWorkflowTemplate,
  validateStepKey,
  advanceTaskStep,
  setTaskStep,
} from "../src/models/workflowTemplate";

const TEST_DB = "/tmp/kdi-workflow-template-test.db";

describe("workflow template model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    cleanupDb(TEST_DB);
    delete process.env.KDI_DB;
  });

  it("defines a template and returns it", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    const template = defineWorkflowTemplate(board.id, "onboarding", "Onboarding", [
      "setup",
      "review",
      "deploy",
    ]);
    expect(template.template_id).toBe("onboarding");
    expect(template.name).toBe("Onboarding");
    expect(template.steps).toEqual(["setup", "review", "deploy"]);
  });

  it("lists templates ordered by template_id", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "beta", "Beta", ["b"]);
    defineWorkflowTemplate(board.id, "alpha", "Alpha", ["a"]);
    const list = listWorkflowTemplates(board.id);
    expect(list.map((t) => t.template_id)).toEqual(["alpha", "beta"]);
  });

  it("upserts an existing template", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "onboarding", "Old", ["a"]);
    const updated = defineWorkflowTemplate(board.id, "onboarding", "New", [
      "setup",
      "review",
    ]);
    expect(updated.name).toBe("New");
    expect(updated.steps).toEqual(["setup", "review"]);
    expect(listWorkflowTemplates(board.id)).toHaveLength(1);
  });

  it("rejects invalid template ids", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    expect(() => defineWorkflowTemplate(board.id, "bad id", "Bad", ["a"])).toThrow(
      /invalid template id/i
    );
  });

  it("rejects template names longer than 255 characters", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    const longName = "x".repeat(256);
    expect(() => defineWorkflowTemplate(board.id, "long-name", longName, ["a"])).toThrow(
      /255/i
    );
  });

  it("rejects empty step arrays", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    expect(() => defineWorkflowTemplate(board.id, "empty", "Empty", [])).toThrow(
      /at least one step/i
    );
  });

  it("rejects duplicate step keys", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    expect(() =>
      defineWorkflowTemplate(board.id, "dup", "Dup", ["a", "a"])
    ).toThrow(/duplicate/i);
  });

  it("rejects empty step keys", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    expect(() =>
      defineWorkflowTemplate(board.id, "empty-step", "Empty", ["a", ""])
    ).toThrow(/step keys cannot be empty/i);
  });

  it("enforces maximum step count", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    const steps = Array.from({ length: 101 }, (_, i) => `step-${i}`);
    expect(() =>
      defineWorkflowTemplate(board.id, "too-many", "Too Many", steps)
    ).toThrow(/100/i);
  });

  it("validates step keys against a template", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    const template = defineWorkflowTemplate(board.id, "onboarding", "Onboarding", [
      "setup",
      "review",
    ]);
    expect(() => validateStepKey(template, "setup")).not.toThrow();
    expect(() => validateStepKey(template, "missing")).toThrow(
      /step "missing" not found/i
    );
  });

  it("returns null for missing template", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    expect(getWorkflowTemplate(board.id, "missing")).toBeNull();
  });

  it("advances a task to the next step", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "onboarding", "Onboarding", [
      "setup",
      "review",
      "deploy",
    ]);
    const task = createTask({
      board_id: board.id,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "setup",
    });
    const updated = advanceTaskStep(task.id);
    expect(updated.current_step_key).toBe("review");
  });

  it("completes a task at the terminal step", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "onboarding", "Onboarding", [
      "setup",
      "review",
    ]);
    const task = createTask({
      board_id: board.id,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "review",
    });
    const updated = advanceTaskStep(task.id);
    expect(updated.status).toBe("done");
    expect(updated.current_step_key).toBeNull();
  });

  it("jumps to a specific step", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "onboarding", "Onboarding", [
      "setup",
      "review",
      "deploy",
    ]);
    const task = createTask({
      board_id: board.id,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "deploy",
    });
    const updated = setTaskStep(task.id, "setup");
    expect(updated.current_step_key).toBe("setup");
  });

  it("rejects jumping to a step not in the template", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "onboarding", "Onboarding", ["setup"]);
    const task = createTask({
      board_id: board.id,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "setup",
    });
    expect(() => setTaskStep(task.id, "missing")).toThrow(
      /step "missing" not found/i
    );
  });

  it("rejects advancing a task with no workflow template", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    const task = createTask({ board_id: board.id, title: "Plain" });
    expect(() => advanceTaskStep(task.id)).toThrow(/no workflow template/i);
  });

  it("rejects advancing when the template is missing", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    const task = createTask({
      board_id: board.id,
      title: "Onboard",
      workflow_template_id: "missing",
      current_step_key: "setup",
    });
    expect(() => advanceTaskStep(task.id)).toThrow(/template "missing" not found/i);
  });

  it("emits a stepped event on advancement", () => {
    const board = createBoard("wf-board", "/tmp/wf-board");
    defineWorkflowTemplate(board.id, "onboarding", "Onboarding", [
      "setup",
      "review",
    ]);
    const task = createTask({
      board_id: board.id,
      title: "Onboard",
      workflow_template_id: "onboarding",
      current_step_key: "setup",
    });
    advanceTaskStep(task.id, "looks good");
    const { getEvents } = require("../src/models/taskEvent");
    const events = getEvents(task.id);
    const stepped = events.find((e: TaskEvent) => e.kind === "stepped");
    expect(stepped).toBeDefined();
  });
});
