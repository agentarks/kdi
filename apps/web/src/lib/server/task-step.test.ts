// KDI-UI-013 Slice 3: workflow step action bridge (advance / jump).
// Exercises success transitions, terminal-step completion, jump with reason,
// and every CLI-mirrored error path (FR-18..FR-25, AC-09..AC-12) against an
// isolated HOME/KDI_DB. Cross-checks task state against `kdi step` semantics by
// re-reading through the bridge.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  advanceTaskStepJson,
  setTaskStepJson,
  createBoardJson,
  createTaskJson,
  taskDetailJson,
  BridgeError,
} from "./bridge";
import { defineWorkflowTemplate } from "~/models/workflowTemplate";
import { showTask, archiveTask } from "~/models/task";
import { getEvents } from "~/models/taskEvent";
import { closeDb } from "~/db";
import { clearOverrides } from "~/flags";

const FF_KEYS = ["FF_SVELTEKIT_FRONTEND", "FF_WORKFLOW_TEMPLATES"];

let tmpHome: string;
const tmpDirs: string[] = [];
const envSnapshot: Record<string, string | undefined> = {};

function isolate(): void {
  tmpHome = `/tmp/kdi-ui013-s3-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  tmpDirs.push(tmpHome);
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  process.env.FF_WORKFLOW_TEMPLATES = "true";
}

function cleanup(): void {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
}

beforeEach(() => {
  for (const key of FF_KEYS) envSnapshot[key] = process.env[key];
  isolate();
  clearOverrides();
});

afterEach(() => {
  for (const key of FF_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearOverrides();
  closeDb();
  cleanup();
});

afterAll(() => cleanup());

async function freshBoard(slug = "step-smoke"): Promise<{ slug: string; boardId: number }> {
  const { board } = await createBoardJson({ slug, workdir: tmpHome });
  return { slug, boardId: board.id };
}

async function defineTemplate(boardId: number, templateId: string, steps: string[]): Promise<void> {
  defineWorkflowTemplate(boardId, templateId, `${templateId} name`, steps);
}

async function makeTemplateTask(slug: string, templateId: string, stepKey?: string): Promise<number> {
  const { task } = await createTaskJson(slug, { title: `task for ${templateId}`, workflowTemplateId: templateId, stepKey });
  return task.id;
}

async function expectBridgeError(p: Promise<unknown>, code: string, status: number, messageMatch?: RegExp): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(BridgeError);
    const be = err as BridgeError;
    expect(be.code).toBe(code);
    expect(be.status).toBe(status);
    if (messageMatch) expect(be.message).toMatch(messageMatch);
  }
  expect(threw).toBe(true);
}

function flagOff(name: string): void {
  process.env[name] = "false";
}

describe("KDI-UI-013 Slice 3 advance/jump success", () => {
  it("advance moves to next step and mirrors CLI message (AC-09)", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b", "c"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    expect(showTask(id)?.current_step_key).toBe("a");

    const r = await advanceTaskStepJson(slug, id);
    expect(r.task.currentStepKey).toBe("b");
    expect(r.task.status).toBe("todo");
    expect(r.message).toBe(`Advanced task ${id} to step b.`);
  });

  it("advance at terminal step → done, clears step, completes event (AC-10)", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    await advanceTaskStepJson(slug, id); // a → b
    const r = await advanceTaskStepJson(slug, id); // b → terminal
    expect(r.task.status).toBe("done");
    expect(r.task.currentStepKey).toBeNull();
    expect(r.message).toBe(`Completed task ${id} at terminal workflow step.`);
  });

  it("jump to a step with a reason records the reason on the stepped event (AC-11)", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b", "c"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    const r = await setTaskStepJson(slug, id, "c", "rework needed");
    expect(r.task.currentStepKey).toBe("c");
    expect(r.message).toBe(`Set task ${id} to step c.`);

    // The reason is recorded on the most recent `stepped` event payload.
    const { events } = await taskDetailJson(slug, id);
    const stepped = events.find((e) => e.kind === "stepped");
    expect(stepped).toBeTruthy();
    const payload = stepped!.payload ? JSON.parse(stepped!.payload) : {};
    expect(payload.reason).toBe("rework needed");
    expect(payload.to).toBe("c");
    expect(payload.from).toBe("a");
  });
});

describe("KDI-UI-013 Slice 3 step validation / errors (AC-12)", () => {
  it("jump to an unknown step rejects with the CLI error", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    await expectBridgeError(
      setTaskStepJson(slug, id, "zzz"),
      "invalid_input",
      400,
      /Step "zzz" not found in workflow template "flow"\. Valid steps: a, b/,
    );
    // No state change.
    expect(showTask(id)?.current_step_key).toBe("a");
  });

  it("advance from a null current step (created without step_key) lands on the first step", async () => {
    // createTask does not default current_step_key (Slice 2 caller job);
    // advance treats null as "before the first step" and moves to steps[0].
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow");
    expect(showTask(id)?.current_step_key).toBeNull();
    const r = await advanceTaskStepJson(slug, id);
    expect(r.task.currentStepKey).toBe("a");
  });

  it("advance a task with no workflow template rejects with the CLI error", async () => {
    const { slug } = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "no template" });
    await expectBridgeError(
      advanceTaskStepJson(slug, task.id),
      "invalid_input",
      400,
      new RegExp(`Task ${task.id} has no workflow template\\.`),
    );
  });

  it("advance a task whose template was deleted rejects with the missing-template CLI error", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    // Redefine is upsert; to simulate a deleted template we point the task at a
    // template_id that no longer exists by re-defining a *different* id and
    // binding the task to it via createTask, then drop the binding lookup. The
    // model's requireTemplate does the getWorkflowTemplate(board_id, id) lookup,
    // so point the task at an id with no template row.
    const { task: t2 } = await createTaskJson(slug, { title: "orphan", workflowTemplateId: "ghost" });
    await expectBridgeError(
      advanceTaskStepJson(slug, t2.id),
      "invalid_input",
      400,
      new RegExp(`Workflow template "ghost" not found for task ${t2.id}\\. Define it with 'kdi workflows define'\\.`),
    );
    void id; void boardId;
  });

  it("advance a task whose current step no longer exists in the template rejects (FR-21)", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b", "c"]);
    const id = await makeTemplateTask(slug, "flow", "b");
    // Redefine the template removing step "b", leaving the task stranded.
    defineWorkflowTemplate(boardId, "flow", "flow name", ["a", "c"]);
    await expectBridgeError(
      advanceTaskStepJson(slug, id),
      "invalid_input",
      400,
      new RegExp(`Task ${id} is on step "b" which no longer exists in template "flow"\\.`),
    );
  });

  it("jump with an empty target key rejects with the CLI error", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow");
    await expectBridgeError(
      setTaskStepJson(slug, id, "   "),
      "invalid_input",
      400,
      /Step key cannot be empty\./,
    );
    void boardId;
  });
});

describe("KDI-UI-013 Slice 3 flag gating (FR-24 / AC-13)", () => {
  it("FF_WORKFLOW_TEMPLATES=false → both actions reject with the disabled message", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow");
    flagOff("FF_WORKFLOW_TEMPLATES");
    await expectBridgeError(
      advanceTaskStepJson(slug, id),
      "feature_disabled",
      400,
      /Workflow templates feature is not enabled\./,
    );
    await expectBridgeError(
      setTaskStepJson(slug, id, "b"),
      "feature_disabled",
      400,
      /Workflow templates feature is not enabled\./,
    );
  });
});

describe("KDI-UI-013 Slice 3 task-detail payload carries template steps", () => {
  it("taskDetailJson hydrates workflowTemplateSteps for a workflow-bound task", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b", "c"]);
    const id = await makeTemplateTask(slug, "flow", "b");
    const detail = await taskDetailJson(slug, id);
    expect(detail.workflowTemplateSteps).toEqual(["a", "b", "c"]);
    expect(detail.task.currentStepKey).toBe("b");
  });

  it("taskDetailJson returns null workflowTemplateSteps when the task has no template", async () => {
    const { slug } = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "plain" });
    const detail = await taskDetailJson(slug, task.id);
    expect(detail.workflowTemplateSteps).toBeNull();
  });

  it("taskDetailJson returns null workflowTemplateSteps when the template was deleted", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    // ponytail: there is no delete API (non-goal), so simulate an orphan by
    // pointing a new task at a missing template id and checking the lookup.
    const { task: orphan } = await createTaskJson(slug, { title: "orphan", workflowTemplateId: "ghost" });
    const detail = await taskDetailJson(slug, orphan.id);
    expect(detail.workflowTemplateSteps).toBeNull();
    void id; void boardId;
  });
});

describe("KDI-UI-013 Slice 3 terminal-task guard (FR-25 server-side mirror)", () => {
  it("advance on an archived task is rejected upstream (assertTaskOnBoard 404) and records no stepped event", async () => {
    // Archived tasks are filtered out by showTask, so assertTaskOnBoard 404s
    // before any model call — no phantom stepped event can fire. This documents
    // the contract the L1 review finding worried about.
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    const steppedBefore = getEvents(id).filter((e) => e.kind === "stepped").length;

    archiveTask(id);
    await expectBridgeError(
      advanceTaskStepJson(slug, id),
      "task_not_found",
      404,
    );
    // No phantom stepped event; archiving itself records an `archived` event, so
    // only the stepped count is asserted.
    expect(getEvents(id).filter((e) => e.kind === "stepped").length).toBe(steppedBefore);
  });

  it("jump on a done task rejects and never sets a step on a done task", async () => {
    const { slug, boardId } = await freshBoard();
    await defineTemplate(boardId, "flow", ["a", "b"]);
    const id = await makeTemplateTask(slug, "flow", "a");
    // Move to terminal so the task is done with a null step.
    await advanceTaskStepJson(slug, id); // a → b
    await advanceTaskStepJson(slug, id); // b → done
    expect(showTask(id)?.status).toBe("done");

    await expectBridgeError(
      setTaskStepJson(slug, id, "a", "restart"),
      "invalid_input",
      400,
      new RegExp(`Task ${id} is already done; step actions are not available\.`),
    );
    // No reanimated step on a done task.
    const t = showTask(id)!;
    expect(t.status).toBe("done");
    expect(t.current_step_key).toBeNull();
  });
});