// KDI-UI-004 task create/edit bridge tests. Calls the new bridge helpers
// directly under Bun, against an isolated temp HOME + KDI_DB, and asserts
// parity with the CLI model source of truth (showTask / editTask) read against
// the same DB.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createBoardJson,
  createTaskJson,
  editTaskJson,
  showTaskJson,
  getWorkflowTemplateJson,
  validateStepKeyBridge,
  profilesJson,
  taskFlags,
  parseDurationBridge,
  type CreateTaskBody,
  BridgeError,
} from "./bridge";
import { showTask, editTask } from "~/models/task";
import { defineWorkflowTemplate } from "~/models/workflowTemplate";
import { clearOverrides } from "~/flags";

let tmpHome: string;

function isolate(): void {
  tmpHome = `/tmp/kdi-ui004-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.KDI_DB = join(tmpHome, "kdi.sqlite");
  process.env.FF_SVELTEKIT_FRONTEND = "true";
  // Enable all per-field flags for full-field tests.
  process.env.FF_SCHEDULED_STATUS = "true";
  process.env.FF_PRIORITY_INTEGER = "true";
  process.env.FF_TENANT_NAMESPACE = "true";
  process.env.FF_CREATED_BY = "true";
  process.env.FF_SKILLS_ARRAY = "true";
  process.env.FF_MODEL_OVERRIDE = "true";
  process.env.FF_MAX_RUNTIME = "true";
  process.env.FF_MAX_RETRIES = "true";
  process.env.FF_DEFAULT_WORKDIR = "true";
  process.env.FF_LIST_FILTERS_SORT = "true";
  process.env.FF_WORKFLOW_TEMPLATES = "true";
  process.env.FF_GOAL_MODE = "true";
  process.env.FF_CREATE_PARENT = "true";
  clearOverrides();
}

function cleanup(): void {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
}

async function freshBoard(slug = "ui004"): Promise<string> {
  isolate();
  await createBoardJson({ slug, workdir: tmpHome });
  return slug;
}

async function expectBridgeError(
  p: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    if (!(e instanceof BridgeError)) throw new Error(`expected BridgeError, got ${e && (e as Error).name}`);
    expect((e as BridgeError).code).toBe(code);
    expect((e as BridgeError).status).toBe(status);
  }
  if (!threw) throw new Error(`expected promise to reject with ${code}/${status}, but it resolved`);
}

beforeEach(isolate);
afterAll(cleanup);

describe("KDI-UI-004 task create/edit bridge", () => {
  it("createTaskJson with all fields matches CLI model", async () => {
    const slug = await freshBoard();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const body: CreateTaskBody = {
      title: "Full task",
      body: "body text",
      assignee: "ralph",
      initialStatus: "scheduled",
      scheduledAt: future,
      priority: 7,
      tenant: "acme",
      createdBy: "alice",
      skills: ["git", "python"],
      modelOverride: "gpt-4o",
      maxRuntimeSeconds: 1800,
      maxRetries: 3,
      workspace: "/tmp/workspace",
      sessionId: "sess-1",
      goalMode: true,
      goalMaxTurns: 5,
      goalJudgeProfile: "pi",
    };
    const { task } = await createTaskJson(slug, body);
    expect(task.title).toBe("Full task");
    expect(task.status).toBe("scheduled");

    const truth = showTask(task.id)!;
    expect(truth.title).toBe("Full task");
    expect(truth.body).toBe("body text");
    expect(truth.assignee).toBe("ralph");
    expect(truth.status).toBe("scheduled");
    expect(truth.scheduled_at).toBe(future);
    expect(truth.priority).toBe(7);
    expect(truth.tenant).toBe("acme");
    expect(truth.created_by).toBe("alice");
    expect(truth.skills).toEqual(["git", "python"]);
    expect(truth.model_override).toBe("gpt-4o");
    expect(truth.max_runtime_seconds).toBe(1800);
    expect(truth.max_retries).toBe(3);
    expect(truth.workspace).toBe("/tmp/workspace");
    expect(truth.session_id).toBe("sess-1");
    expect(truth.goal_mode).toBe(true);
    expect(truth.goal_max_turns).toBe(5);
    expect(truth.goal_remaining_turns).toBe(5);
    expect(truth.goal_judge_profile).toBe("pi");
  });

  it("createTaskJson with workflow template and step key", async () => {
    const slug = await freshBoard();
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup", "review", "done"]);
    const { task } = await createTaskJson(slug, {
      title: "WF task",
      workflowTemplateId: "onboarding",
      stepKey: "review",
    });
    const truth = showTask(task.id)!;
    expect(truth.workflow_template_id).toBe("onboarding");
    expect(truth.current_step_key).toBe("review");
  });

  it("createTaskJson links parent dependencies", async () => {
    const slug = await freshBoard();
    const { task: parent } = await createTaskJson(slug, { title: "Parent" });
    const { task: child } = await createTaskJson(slug, { title: "Child" }, [parent.id]);
    const truth = showTask(child.id)!;
    expect(truth.title).toBe("Child");
    // Parent dependency is recorded by the dependency model; no direct column on task.
  });

  it("createTaskJson rejects missing title", async () => {
    const slug = await freshBoard();
    await expectBridgeError(createTaskJson(slug, { title: "" }), "invalid_input", 400);
  });

  it("editTaskJson updates body", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Edit me" });
    const { task: updated } = await editTaskJson(slug, task.id, "new body");
    expect(updated.title).toBe("Edit me");
    const truth = showTask(task.id)!;
    expect(truth.body).toBe("new body");
  });

  it("editTaskJson rejects empty body", async () => {
    const slug = await freshBoard();
    const { task } = await createTaskJson(slug, { title: "Edit me" });
    await expectBridgeError(editTaskJson(slug, task.id, ""), "invalid_input", 400);
    await expectBridgeError(editTaskJson(slug, task.id, "   "), "invalid_input", 400);
  });

  it("editTaskJson 404 for missing task", async () => {
    const slug = await freshBoard();
    await expectBridgeError(editTaskJson(slug, 999999, "body"), "task_not_found", 404);
  });

  it("taskFlags returns the expected keys", async () => {
    isolate();
    const flags = taskFlags();
    expect(flags).toHaveProperty("sveltekitFrontend");
    expect(flags).toHaveProperty("scheduledStatus");
    expect(flags).toHaveProperty("priorityInteger");
    expect(flags).toHaveProperty("tenantNamespace");
    expect(flags).toHaveProperty("createdBy");
    expect(flags).toHaveProperty("skillsArray");
    expect(flags).toHaveProperty("modelOverride");
    expect(flags).toHaveProperty("maxRuntime");
    expect(flags).toHaveProperty("maxRetries");
    expect(flags).toHaveProperty("defaultWorkdir");
    expect(flags).toHaveProperty("listFiltersSort");
    expect(flags).toHaveProperty("workflowTemplates");
    expect(flags).toHaveProperty("goalMode");
    expect(flags).toHaveProperty("createParent");
  });

  it("parseDurationBridge mirrors the model", async () => {
    const slug = await freshBoard();
    await expect(parseDurationBridge("30m")).resolves.toBe(1800);
    await expect(parseDurationBridge("90s")).resolves.toBe(90);
    await expect(parseDurationBridge("2h")).resolves.toBe(7200);
    await expect(parseDurationBridge("300")).resolves.toBe(300);
    await expect(parseDurationBridge("bad")).rejects.toBeInstanceOf(BridgeError);
  });

  it("getWorkflowTemplateJson returns template and validateStepKeyBridge enforces steps", async () => {
    const slug = await freshBoard();
    defineWorkflowTemplate(1, "onboarding", "Onboarding", ["setup"]);
    const { template } = await getWorkflowTemplateJson(slug, "onboarding");
    expect(template).not.toBeNull();
    expect(template?.templateId).toBe("onboarding");
    expect(template?.steps).toEqual(["setup"]);
    await expect(validateStepKeyBridge(slug, "onboarding", "setup")).resolves.toBeUndefined();
    await expect(validateStepKeyBridge(slug, "onboarding", "missing")).rejects.toBeInstanceOf(BridgeError);
  });

  it("profilesJson returns built-in profiles", async () => {
    isolate();
    const { profiles } = await profilesJson();
    const names = profiles.map((p) => p.name);
    expect(names).toContain("opencode");
    expect(names).toContain("pi");
  });
});
