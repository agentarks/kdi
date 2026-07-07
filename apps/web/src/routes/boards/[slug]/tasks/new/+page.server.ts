import { error, fail, redirect } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import {
  showBoardJson,
  workflowsJson,
  profilesJson,
  taskFlags,
  isSvelteKitEnabled,
  createTaskJson,
  getWorkflowTemplateJson,
  validateStepKeyBridge,
  parseDurationBridge,
  showTaskJson,
  BridgeError,
  type CreateTaskBody,
} from "$lib/server/bridge";

const VALID_STATUSES = ["triage", "todo", "scheduled", "ready", "running", "done", "blocked", "review"] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(status: string): status is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(status);
}

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function getString(data: FormData, name: string): string | undefined {
  const value = data.get(name);
  if (value === null) return undefined;
  return value.toString().trim();
}

function getCheckbox(data: FormData, name: string): boolean {
  return data.get(name) === "on";
}

function parseTimestamp(raw: string): number {
  if (/^\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }
  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    throw new BridgeError("invalid_input", 400, `Invalid timestamp: ${raw}`);
  }
  return Math.floor(date.getTime() / 1000);
}

function validateSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new BridgeError(
      "invalid_input",
      400,
      `Invalid skill name "${name}". Skill names may only contain letters, numbers, underscores, and hyphens.`,
    );
  }
}

function resolveCreator(optionsCreatedBy?: string): string {
  const candidates = [optionsCreatedBy, process.env.KDI_CREATED_BY, process.env.USER];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return "unknown";
}

export const load: PageServerLoad = async ({ params }) => {
  if (!isSvelteKitEnabled()) {
    throw error(404, "UI disabled");
  }
  const { board } = await showBoardJson(params.slug);
  const { templates } = await workflowsJson(params.slug);
  const { profiles } = await profilesJson();
  return { board, templates, profiles, flags: taskFlags() };
};

export const actions: Actions = {
  default: async ({ request, params }) => {
    if (!isSvelteKitEnabled()) {
      throw error(404, "UI disabled");
    }

    const data = await request.formData();
    const flags = taskFlags();

    const title = getString(data, "title");
    const body = getString(data, "body");
    const assignee = getString(data, "assignee");
    const statusRaw = getString(data, "status") ?? "todo";
    const scheduledAtRaw = getString(data, "scheduled_at");
    const priorityRaw = getString(data, "priority");
    const tenantRaw = getString(data, "tenant");
    const createdByRaw = getString(data, "created_by");
    const skillsRaw = getString(data, "skills");
    const modelOverrideRaw = getString(data, "model_override");
    const maxRuntimeRaw = getString(data, "max_runtime");
    const maxRetriesRaw = getString(data, "max_retries");
    const workspaceRaw = getString(data, "workspace");
    const sessionIdRaw = getString(data, "session_id");
    const workflowTemplateIdRaw = getString(data, "workflow_template_id");
    const stepKeyRaw = getString(data, "step_key");
    const goalMode = getCheckbox(data, "goal_mode");
    const goalMaxTurnsRaw = getString(data, "goal_max_turns");
    const goalJudgeProfileRaw = getString(data, "goal_judge_profile");
    const parentIdsRaw = getString(data, "parent_ids");

    const values = Object.fromEntries(
      [
        "title",
        "body",
        "assignee",
        "scheduled_at",
        "priority",
        "tenant",
        "created_by",
        "skills",
        "model_override",
        "max_runtime",
        "max_retries",
        "workspace",
        "session_id",
        "workflow_template_id",
        "step_key",
        "goal_max_turns",
        "goal_judge_profile",
        "parent_ids",
      ].map((name) => [name, getString(data, name) ?? ""]),
    ) as Record<string, string>;

    values.status = statusRaw;
    values.goal_mode = goalMode ? "on" : "";

    try {
      if (!title) {
        throw new BridgeError("invalid_input", 400, "Title is required.");
      }

      if (!isValidStatus(statusRaw)) {
        throw new BridgeError(
          "invalid_input",
          400,
          `Invalid status "${statusRaw}". Valid: ${VALID_STATUSES.join(", ")}`,
        );
      }

      let initialStatus: ValidStatus | undefined = statusRaw;
      let triage: boolean | undefined;
      if (statusRaw === "triage") {
        triage = true;
        initialStatus = undefined;
      }

      let scheduledAt: number | undefined;
      if (scheduledAtRaw) {
        if (!flags.scheduledStatus) {
          throw new BridgeError("invalid_input", 400, "Scheduled status feature is not enabled.");
        }
        scheduledAt = parseTimestamp(scheduledAtRaw);
        const now = Math.floor(Date.now() / 1000);
        if (scheduledAt <= now) {
          throw new BridgeError("invalid_input", 400, "Scheduled time must be in the future");
        }
      }
      if (statusRaw === "scheduled" && scheduledAt === undefined) {
        throw new BridgeError("invalid_input", 400, "initial status 'scheduled' requires scheduled_at to be set");
      }

      let priority: number | undefined;
      if (priorityRaw) {
        if (!flags.priorityInteger) {
          throw new BridgeError("invalid_input", 400, "Priority integer feature is not enabled.");
        }
        const parsed = Number(priorityRaw);
        if (!Number.isInteger(parsed)) {
          throw new BridgeError("invalid_input", 400, `Priority must be an integer, got "${priorityRaw}"`);
        }
        priority = parsed;
      }

      let tenant: string | undefined;
      if (tenantRaw !== undefined) {
        if (!flags.tenantNamespace) {
          throw new BridgeError("invalid_input", 400, "Tenant namespace feature is not enabled.");
        }
        if (tenantRaw === "") {
          throw new BridgeError("invalid_input", 400, "Tenant cannot be empty.");
        }
        tenant = tenantRaw;
      }

      let createdBy: string | undefined;
      if (flags.createdBy) {
        if (createdByRaw === undefined) {
          createdBy = resolveCreator();
        } else if (createdByRaw === "") {
          throw new BridgeError("invalid_input", 400, "Created-by cannot be empty.");
        } else {
          createdBy = createdByRaw;
        }
      } else {
        if (createdByRaw !== undefined && createdByRaw !== "") {
          throw new BridgeError("invalid_input", 400, "Created-by tracking is not enabled.");
        }
        createdBy = resolveCreator();
      }

      let skills: string[] | undefined;
      if (skillsRaw) {
        if (!flags.skillsArray) {
          throw new BridgeError("invalid_input", 400, "Skills array feature is not enabled.");
        }
        skills = skillsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        for (const skill of skills) {
          validateSkillName(skill);
        }
      }

      let modelOverride: string | undefined;
      if (modelOverrideRaw !== undefined) {
        if (!flags.modelOverride) {
          throw new BridgeError("invalid_input", 400, "Model override feature is not enabled.");
        }
        if (modelOverrideRaw === "") {
          throw new BridgeError("invalid_input", 400, "Model cannot be empty.");
        }
        modelOverride = modelOverrideRaw;
      }

      let maxRuntimeSeconds: number | undefined;
      if (maxRuntimeRaw) {
        if (!flags.maxRuntime) {
          throw new BridgeError("invalid_input", 400, "Max runtime feature is not enabled.");
        }
        maxRuntimeSeconds = await parseDurationBridge(maxRuntimeRaw);
      }

      let maxRetries: number | undefined;
      if (maxRetriesRaw) {
        if (!flags.maxRetries) {
          throw new BridgeError("invalid_input", 400, "Max retries feature is not enabled.");
        }
        const parsed = Number(maxRetriesRaw);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
          throw new BridgeError(
            "invalid_input",
            400,
            `Max retries must be a non-negative integer, got "${maxRetriesRaw}"`,
          );
        }
        maxRetries = parsed;
      }

      let workspace: string | undefined;
      if (workspaceRaw !== undefined) {
        if (!flags.defaultWorkdir) {
          throw new BridgeError("invalid_input", 400, "Default workdir feature is not enabled.");
        }
        if (workspaceRaw === "") {
          throw new BridgeError("invalid_input", 400, "Workspace cannot be empty.");
        }
        workspace = workspaceRaw;
      }

      let sessionId: string | undefined;
      if (sessionIdRaw !== undefined) {
        if (!flags.listFiltersSort) {
          throw new BridgeError("invalid_input", 400, "List filters and sort feature is not enabled.");
        }
        if (sessionIdRaw === "") {
          throw new BridgeError("invalid_input", 400, "Session ID cannot be empty.");
        }
        sessionId = sessionIdRaw;
      }

      let workflowTemplateId: string | undefined;
      let currentStepKey: string | undefined;
      if (workflowTemplateIdRaw) {
        if (!flags.workflowTemplates) {
          throw new BridgeError("invalid_input", 400, "Workflow templates feature is not enabled.");
        }
        workflowTemplateId = workflowTemplateIdRaw;
        const { template } = await getWorkflowTemplateJson(params.slug, workflowTemplateId);
        if (!template) {
          throw new BridgeError(
            "invalid_input",
            400,
            `Workflow template "${workflowTemplateId}" not found for board "${params.slug}".`,
          );
        }
        if (stepKeyRaw) {
          if (stepKeyRaw === "") {
            throw new BridgeError("invalid_input", 400, "Step key cannot be empty.");
          }
          await validateStepKeyBridge(params.slug, workflowTemplateId, stepKeyRaw);
          currentStepKey = stepKeyRaw;
        } else {
          currentStepKey = template.steps[0] ?? undefined;
        }
      } else if (stepKeyRaw) {
        throw new BridgeError("invalid_input", 400, "--step-key requires --workflow-template-id.");
      }

      let goalModeValue: boolean | undefined;
      let goalMaxTurns: number | undefined;
      let goalJudgeProfile: string | undefined;
      const goalOptionsUsed = goalMode || goalMaxTurnsRaw || goalJudgeProfileRaw;
      if (goalOptionsUsed) {
        if (!flags.goalMode) {
          throw new BridgeError("invalid_input", 400, "Goal mode feature is not enabled.");
        }
      }
      if (goalMaxTurnsRaw && !goalMode) {
        throw new BridgeError("invalid_input", 400, "--goal-max-turns requires --goal.");
      }
      if (goalMode) {
        if (!goalMaxTurnsRaw) {
          throw new BridgeError("invalid_input", 400, "--goal requires --goal-max-turns <n>.");
        }
        const parsedTurns = Number(goalMaxTurnsRaw);
        if (!Number.isInteger(parsedTurns) || parsedTurns <= 0) {
          throw new BridgeError(
            "invalid_input",
            400,
            `--goal-max-turns must be a positive integer, got "${goalMaxTurnsRaw}"`,
          );
        }
        goalMaxTurns = parsedTurns;

        const judge = goalJudgeProfileRaw?.trim() || process.env.KDI_GOAL_JUDGE_PROFILE?.trim() || "";
        if (judge === "") {
          throw new BridgeError(
            "invalid_input",
            400,
            "--goal requires a judge profile via --goal-judge or KDI_GOAL_JUDGE_PROFILE.",
          );
        }
        const { profiles } = await profilesJson();
        const known = profiles.find((p) => p.name === judge);
        if (!known) {
          throw new BridgeError("invalid_input", 400, `Unknown judge profile "${judge}".`);
        }
        goalJudgeProfile = judge;
        goalModeValue = true;
      }

      const parentIds: number[] = [];
      if (parentIdsRaw) {
        if (!flags.createParent) {
          throw new BridgeError("invalid_input", 400, "Create-parent feature is not enabled.");
        }
        const rawIds = parentIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        for (const raw of rawIds) {
          const id = parseInt(raw, 10);
          if (isNaN(id) || id <= 0 || !Number.isInteger(id)) {
            throw new BridgeError("invalid_input", 400, `Invalid parent task ID: ${raw}`);
          }
          parentIds.push(id);
        }
        for (const parentId of parentIds) {
          try {
            await showTaskJson(params.slug, parentId);
          } catch {
            throw new BridgeError("invalid_input", 400, `Parent task ${parentId} not found.`);
          }
        }
      }

      const { board } = await showBoardJson(params.slug);
      if (workspace === undefined && flags.defaultWorkdir && board.defaultWorkdir) {
        workspace = board.defaultWorkdir;
      }

      const input: CreateTaskBody = {
        title,
        body,
        assignee,
        triage,
        initialStatus,
        priority,
        tenant,
        createdBy,
        skills,
        modelOverride,
        maxRuntimeSeconds,
        maxRetries,
        workspace,
        sessionId,
        workflowTemplateId,
        stepKey: currentStepKey,
        goalMode: goalModeValue,
        goalMaxTurns,
        goalJudgeProfile,
        scheduledAt,
      };

      const { task } = await createTaskJson(params.slug, input, parentIds);
      throw redirect(303, `/boards/${params.slug}?created=${task.id}`);
    } catch (err) {
      if (err instanceof BridgeError) {
        return fail(400, { error: err.message, values });
      }
      throw err;
    }
  },
};
