import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { showBoard, getBoardById } from "../models/board";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  promoteTaskAdvanced,
  PromoteTaskResult,
  blockTask,
  unblockTask,
  archiveTask,
  archiveTaskHard,
  specifyTask,
  specifyTaskWithLlm,
  decomposeTask,
  completeTask,
  reviewTask,
  scheduleTask,
  parseDuration,
  assignTask,
  unassignTask,
  reassignTask,
  VALID_SORT_KEYS,
} from "../models/task";
import { addComment, getComments } from "../models/comment";
import { createAttachment, listAttachments } from "../models/taskAttachment";
import { getRuns, getRunsFiltered } from "../models/taskRun";
import { getEvents, tailEvents, getRecentEvents, getEventsAfter, type WatchFilters } from "../models/taskEvent";
import { atomicClaim, reclaimTask, heartbeat } from "../models/claim";
import { getTaskLogPath } from "../observability";
import { isEnabled, FF_SCHEDULED_STATUS, FF_REVIEW_STATUS, FF_COMPLETE_METADATA, FF_PRIORITY_INTEGER, FF_SKILLS_ARRAY, FF_MAX_RUNTIME, FF_MAX_RETRIES, FF_TENANT_NAMESPACE, FF_CREATED_BY, FF_MODEL_OVERRIDE, FF_DEFAULT_WORKDIR, FF_WORKER_LOG_CAPTURE, FF_ASSIGN_REASSIGN, FF_CRASH_GRACE_PERIOD, FF_HEARTBEAT, FF_RATE_LIMIT_EXIT_CODE, FF_TASK_ATTACHMENTS, FF_LIST_FILTERS_SORT, FF_SHOW_RUN_FILTERING, FF_BULK_OPERATIONS, FF_COMMENT_ENHANCEMENTS, FF_WATCH_FILTERS, FF_WORKFLOW_TEMPLATES, FF_TRIAGE_AUTOMATION, FF_GOAL_MODE } from "../flags";
import { getWorkflowTemplate, validateStepKey, advanceTaskStep, setTaskStep } from "../models/workflowTemplate";
import { resolveBoard } from "../resolveBoard";
import { buildSpecifyPrompt, buildDecomposePrompt, callTriageLlm } from "../llm";
import { getProfile } from "../profiles";

const VALID_STATUSES = ["triage", "todo", "scheduled", "ready", "running", "done", "blocked", "review"] as const;
type ValidStatus = typeof VALID_STATUSES[number];

function isValidStatus(status: string): status is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(status);
}

function getBoardBySlug(slug: string): NonNullable<ReturnType<typeof showBoard>> {
  const board = showBoard(slug, false);
  if (!board) {
    throw new Error(`Board "${slug}" not found.`);
  }
  return board;
}

function getBoardIdBySlug(slug: string): number {
  return getBoardBySlug(slug).id;
}

function parseTaskId(raw: string): number {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0 || !Number.isInteger(id)) {
    throw new Error(`Invalid task ID: ${raw}`);
  }
  return id;
}

const MAX_CREATED_BY_LENGTH = 255;

function resolveCreator(optionsCreatedBy?: string): string {
  const candidates = [optionsCreatedBy, process.env.KDI_CREATED_BY, process.env.USER];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") {
      const value = candidate.trim();
      if (value.length > MAX_CREATED_BY_LENGTH) {
        throw new Error(`Created-by identifier must be ${MAX_CREATED_BY_LENGTH} characters or fewer.`);
      }
      return value;
    }
  }
  return "unknown";
}

function resolveCurrentProfile(): string {
  return process.env.KDI_PROFILE || process.env.HERMES_PROFILE || "user";
}

function parseTimestamp(raw: string): number {
  if (/^\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }
  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }
  return Math.floor(date.getTime() / 1000);
}

function collectSkill(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Skill names may only contain letters, numbers, underscores, and hyphens.`
    );
  }
}

function printVerdict(id: number, verdict: PromoteTaskResult): void {
  switch (verdict.status) {
    case "would_promote":
      console.log(`${id}: would_promote`);
      break;
    case "not_found":
      console.error(`${id}: skipped: not_found`);
      break;
    case "archived":
      console.error(`${id}: skipped: archived`);
      break;
    case "wrong_status":
      console.error(`${id}: skipped: wrong_status (current: ${verdict.current})`);
      break;
    case "blocked_by_dependencies":
      console.error(`${id}: skipped: blocked_by_dependencies`);
      break;
    case "promoted":
      // handled by the caller with the full success message
      console.log(`${id}: promoted`);
      break;
  }
}

export const createTaskCommand = new Command("create")
  .description("Create a new task")
  .argument("<title>", "Task title")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--assignee <profile>", "Assignee profile")
  .option("--body <text>", "Task body")
  .option("--triage", "Park in triage status instead of todo")
  .option("--initial-status <status>", "Initial task status (default: todo)")
  .option("--at <timestamp>", "ISO 8601 or Unix timestamp for scheduled tasks (required when --initial-status=scheduled)")
  .option("--priority <n>", "Integer priority, higher is more urgent (default: 0)")
  .option("--idempotency-key <key>", "Dedup key; returns existing non-archived task id if matched")
  .option("--max-runtime <duration>", "Maximum runtime (e.g. 30m, 1h, 2d, 90s). Feature-flagged.")
  .option("--max-retries <n>", "Maximum consecutive failures before blocking (non-negative integer). Feature-flagged.")
  .option("--tenant <name>", "Tenant namespace for the task")
  .option("--skill <skill>", "Add a skill to the task (repeatable)", collectSkill, [])
  .option("--model <model>", "Model override for the harness")
  .option("--created-by <actor>", "Actor that created the task")
  .option("--workspace <path>", "Workspace path for this task. Feature-flagged.")
  .option("--session <session_id>", "Originating session ID. Feature-flagged.")
  .option("--workflow-template-id <id>", "Workflow template ID. Feature-flagged.")
  .option("--step-key <key>", "Initial workflow step key (requires --workflow-template-id). Feature-flagged.")
  .option("--goal", "Create as a goal-mode task (Ralph-style multi-turn loop). Requires --goal-max-turns and a judge profile. Feature-flagged.")
  .option("--goal-max-turns <n>", "Maximum number of turns for a goal-mode task (positive integer). Requires --goal. Feature-flagged.")
  .option("--goal-judge <profile>", "Judge profile name for a goal-mode task. Falls back to KDI_GOAL_JUDGE_PROFILE env. Requires --goal. Feature-flagged.")
  .action(function (this: Command, title: string, options: { board?: string; assignee?: string; body?: string; triage?: boolean; initialStatus?: string; at?: string; priority?: string; idempotencyKey?: string; maxRuntime?: string; maxRetries?: string; tenant?: string; skill: string[]; createdBy?: string; model?: string; workspace?: string; session?: string; workflowTemplateId?: string; stepKey?: string; goal?: boolean; goalMaxTurns?: string; goalJudge?: string }) {
    try {
      if (!title || title.trim() === "") {
        throw new Error("Title is required.");
      }

      if (options.triage && options.initialStatus) {
        throw new Error("Cannot use both --triage and --initial-status.");
      }

      if (options.idempotencyKey !== undefined && options.idempotencyKey.trim() === "") {
        throw new Error("Idempotency key cannot be empty.");
      }

      let priority: number | undefined;
      if (options.priority !== undefined) {
        if (isEnabled(FF_PRIORITY_INTEGER)) {
          const parsed = Number(options.priority);
          if (!Number.isInteger(parsed)) {
            throw new Error(`Priority must be an integer, got "${options.priority}"`);
          }
          priority = parsed;
        } else {
          priority = Number(options.priority);
          if (isNaN(priority)) {
            throw new Error(`Priority must be a number, got "${options.priority}"`);
          }
        }
      }

      let initialStatus: ValidStatus | undefined;
      if (options.initialStatus) {
        if (!isValidStatus(options.initialStatus)) {
          throw new Error(`Invalid status "${options.initialStatus}". Valid: ${VALID_STATUSES.join(", ")}`);
        }
        initialStatus = options.initialStatus;
      }

      let scheduledAt: number | undefined;
      if (options.at) {
        scheduledAt = parseTimestamp(options.at);
      }
      if (initialStatus === "scheduled" && scheduledAt === undefined) {
        throw new Error("--initial-status scheduled requires --at");
      }

      let maxRuntimeSeconds: number | undefined;
      if (options.maxRuntime !== undefined) {
        if (!isEnabled(FF_MAX_RUNTIME)) {
          throw new Error("Max runtime feature is not enabled.");
        }
        maxRuntimeSeconds = parseDuration(options.maxRuntime);
      }

      let maxRetries: number | undefined;
      if (options.maxRetries !== undefined) {
        if (!isEnabled(FF_MAX_RETRIES)) {
          throw new Error("Max retries feature is not enabled.");
        }
        if (options.maxRetries.trim() === "") {
          throw new Error("Max retries cannot be empty.");
        }
        const parsed = Number(options.maxRetries);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`Max retries must be a non-negative integer, got "${options.maxRetries}"`);
        }
        maxRetries = parsed;
      }

      if (options.tenant !== undefined) {
        if (!isEnabled(FF_TENANT_NAMESPACE)) {
          throw new Error("Tenant namespace feature is not enabled.");
        }
        if (options.tenant.trim() === "") {
          throw new Error("Tenant cannot be empty.");
        }
      }

      let skills: string[] | undefined;
      if (options.skill.length > 0) {
        if (!isEnabled(FF_SKILLS_ARRAY)) {
          throw new Error("Skills array feature is not enabled.");
        }
        skills = options.skill.filter((s) => s.trim() !== "");
        for (const skill of skills) {
          validateSkillName(skill);
        }
      }

      if (options.model !== undefined) {
        if (!isEnabled(FF_MODEL_OVERRIDE)) {
          throw new Error("Model override feature is not enabled.");
        }
        if (options.model.trim() === "") {
          throw new Error("Model cannot be empty.");
        }
      }

      if (options.createdBy !== undefined && !isEnabled(FF_CREATED_BY)) {
        throw new Error("Created-by tracking is not enabled.");
      }

      let createdBy: string | undefined;
      if (isEnabled(FF_CREATED_BY)) {
        createdBy = resolveCreator(options.createdBy);
      }

      const boardSlug = resolveBoard(options.board);
      const board = getBoardBySlug(boardSlug);

      let workspace: string | undefined;
      if (options.workspace !== undefined) {
        if (!isEnabled(FF_DEFAULT_WORKDIR)) {
          throw new Error("Default workdir feature is not enabled.");
        }
        workspace = options.workspace.trim();
        if (workspace === "") {
          throw new Error("Workspace cannot be empty.");
        }
      }

      if (workspace === undefined && isEnabled(FF_DEFAULT_WORKDIR) && board.default_workdir) {
        workspace = board.default_workdir;
      }

      if (options.session !== undefined) {
        if (!isEnabled(FF_LIST_FILTERS_SORT)) {
          throw new Error("List filters and sort feature is not enabled.");
        }
        if (options.session.trim() === "") {
          throw new Error("Session ID cannot be empty.");
        }
      }

      if (options.workflowTemplateId !== undefined || options.stepKey !== undefined) {
        if (!isEnabled(FF_WORKFLOW_TEMPLATES)) {
          throw new Error("Workflow templates feature is not enabled.");
        }
      }

      let workflowTemplateId: string | undefined;
      let currentStepKey: string | undefined;

      if (isEnabled(FF_WORKFLOW_TEMPLATES) && options.workflowTemplateId !== undefined) {
        workflowTemplateId = options.workflowTemplateId.trim();
        if (workflowTemplateId === "") {
          throw new Error("Workflow template ID cannot be empty.");
        }

        const template = getWorkflowTemplate(board.id, workflowTemplateId);
        if (!template) {
          throw new Error(
            `Workflow template "${workflowTemplateId}" not found for board "${boardSlug}".`
          );
        }

        if (options.stepKey !== undefined) {
          currentStepKey = options.stepKey.trim();
          if (currentStepKey === "") {
            throw new Error("Step key cannot be empty.");
          }
          validateStepKey(template, currentStepKey);
        } else {
          currentStepKey = template.steps[0];
        }
      } else if (options.stepKey !== undefined) {
        throw new Error("--step-key requires --workflow-template-id.");
      }

      // KDI-038: goal-mode validation.
      const goalOptionsUsed = options.goal || options.goalMaxTurns !== undefined || options.goalJudge !== undefined;
      if (goalOptionsUsed && !isEnabled(FF_GOAL_MODE)) {
        throw new Error("Goal mode feature is not enabled.");
      }
      if (options.goalMaxTurns !== undefined && !options.goal) {
        throw new Error("--goal-max-turns requires --goal.");
      }

      let goalMode: boolean | undefined;
      let goalMaxTurns: number | undefined;
      let goalJudgeProfile: string | undefined;

      if (options.goal) {
        if (options.goalMaxTurns === undefined) {
          throw new Error("--goal requires --goal-max-turns <n>.");
        }
        if (options.goalMaxTurns.trim() === "") {
          throw new Error("Goal max turns cannot be empty.");
        }
        const parsedTurns = Number(options.goalMaxTurns);
        if (!Number.isInteger(parsedTurns) || parsedTurns <= 0) {
          throw new Error(`--goal-max-turns must be a positive integer, got "${options.goalMaxTurns}"`);
        }
        goalMaxTurns = parsedTurns;

        const judge = options.goalJudge?.trim() || Bun.env.KDI_GOAL_JUDGE_PROFILE?.trim() || "";
        if (judge === "") {
          throw new Error("--goal requires a judge profile via --goal-judge or KDI_GOAL_JUDGE_PROFILE.");
        }
        // Validate the profile is known at create time so we fail fast on typos.
        try {
          getProfile(judge);
        } catch {
          throw new Error(`Unknown judge profile "${judge}".`);
        }
        goalJudgeProfile = judge;
        goalMode = true;
      }

      const task = createTask({
        board_id: board.id,
        title,
        assignee: options.assignee,
        body: options.body,
        triage: options.triage,
        initialStatus,
        priority,
        idempotency_key: options.idempotencyKey,
        scheduled_at: scheduledAt,
        max_runtime_seconds: maxRuntimeSeconds,
        max_retries: maxRetries,
        tenant: options.tenant,
        skills,
        created_by: createdBy,
        model_override: options.model,
        workspace,
        session_id: options.session,
        workflow_template_id: workflowTemplateId,
        current_step_key: currentStepKey,
        goal_mode: goalMode,
        goal_max_turns: goalMaxTurns,
        goal_judge_profile: goalJudgeProfile,
      });
      console.log(task.id);
    } catch (err: any) {
      this.error(err.message);
    }
  });

export const listTasksCommand = new Command("list")
  .description("List tasks")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--status <status>", "Filter by status")
  .option("--assignee <profile>", "Filter by assignee")
  .option("--tenant <name>", "Filter by tenant namespace")
  .option("--created-by <actor>", "Filter by creator")
  .option("--mine", "Show only tasks assigned to your current profile")
  .option("--session <session_id>", "Filter by originating session ID")
  .option("--archived", "Include archived tasks")
  .option("--sort <key>", "Sort order (assignee, created, created-desc, priority, priority-desc, status, title, updated)")
  .option("--workflow-template-id <id>", "Filter by workflow template ID")
  .option("--step-key <key>", "Filter by current step key")
  .action(function (this: Command, options: { board?: string; status?: string; assignee?: string; tenant?: string; createdBy?: string; mine?: boolean; session?: string; archived?: boolean; sort?: string; workflowTemplateId?: string; stepKey?: string }) {
    try {
      // Gate new options behind FF_LIST_FILTERS_SORT
      const hasNewOption = options.mine || options.session !== undefined || options.archived || options.sort !== undefined || options.workflowTemplateId !== undefined || options.stepKey !== undefined;
      if (hasNewOption && !isEnabled(FF_LIST_FILTERS_SORT)) {
        throw new Error("List filters and sort feature is not enabled.");
      }

      if (options.status && !isValidStatus(options.status)) {
        // Allow --status archived when --archived is also passed with FF_LIST_FILTERS_SORT
        if (!(options.status === "archived" && isEnabled(FF_LIST_FILTERS_SORT) && options.archived)) {
          throw new Error(`Invalid status "${options.status}". Valid: ${VALID_STATUSES.join(", ")}`);
        }
      }
      if (options.tenant !== undefined) {
        if (!isEnabled(FF_TENANT_NAMESPACE)) {
          throw new Error("Tenant namespace feature is not enabled.");
        }
        if (options.tenant.trim() === "") {
          throw new Error("Tenant cannot be empty.");
        }
      }
      if (options.createdBy !== undefined && !isEnabled(FF_CREATED_BY)) {
        throw new Error("Created-by tracking is not enabled.");
      }

      // --mine and --assignee are mutually exclusive
      if (options.mine && options.assignee) {
        throw new Error("--mine and --assignee cannot be used together.");
      }

      // Resolve assignee from --mine or --assignee
      let assignee = options.assignee;
      if (options.mine) {
        assignee = resolveCurrentProfile();
      }

      // Validate sort key
      if (options.sort !== undefined) {
        const validKeys: readonly string[] = VALID_SORT_KEYS;
        if (!validKeys.includes(options.sort)) {
          throw new Error(`Invalid sort key "${options.sort}". Valid: ${validKeys.join(", ")}`);
        }
      }

      const boardSlug = resolveBoard(options.board);
      const boardId = getBoardIdBySlug(boardSlug);
      const tasks = listTasks({
        board_id: boardId,
        status: options.status as any,
        assignee,
        tenant: options.tenant,
        created_by: options.createdBy,
        includeArchived: options.archived,
        session_id: options.session,
        workflow_template_id: options.workflowTemplateId,
        current_step_key: options.stepKey,
      }, options.sort);
      if (tasks.length === 0) {
        console.log("No tasks.");
        return;
      }
      for (const task of tasks) {
        console.log(`${task.id}: ${task.title} [${task.status}]${task.assignee ? " @" + task.assignee : ""}`);
      }
    } catch (err: any) {
      this.error(err.message);
    }
  });

export const showTaskCommand = new Command("show")
  .description("Show task details")
  .argument("<task_id>", "Task ID")
  .option("--state-type <type>", "Run state type to filter by (status|outcome)")
  .option("--state-name <value>", "Run state name to filter by")
  .action((taskId: string, options: { stateType?: string; stateName?: string }) => {
    try {
      const id = parseTaskId(taskId);
      const task = showTask(id);
      if (!task) {
        console.error(`Task ${id} not found.`);
        process.exit(1);
      }

      const hasStateType = options.stateType !== undefined;
      const hasStateName = options.stateName !== undefined;

      if (!isEnabled(FF_SHOW_RUN_FILTERING)) {
        if (hasStateType || hasStateName) {
          throw new Error("Run filtering feature is not enabled.");
        }
      } else {
        if (hasStateType !== hasStateName) {
          throw new Error("--state-type and --state-name must both be provided or both omitted.");
        }
        if (hasStateType) {
          const validTypes = ["status", "outcome"];
          if (!validTypes.includes(options.stateType!)) {
            throw new Error(`Invalid state type "${options.stateType}". Valid: ${validTypes.join(", ")}.`);
          }
        }
      }

      console.log(`ID: ${task.id}`);
      console.log(`Title: ${task.title}`);
      console.log(`Status: ${task.status}`);
      console.log(`Priority: ${task.priority}`);
      if (task.assignee) console.log(`Assignee: ${task.assignee}`);
      if (isEnabled(FF_DEFAULT_WORKDIR) && task.workspace) console.log(`Workspace: ${task.workspace}`);
      if (task.body) console.log(`Body: ${task.body}`);
      if (task.result) console.log(`Result: ${task.result}`);
      if (task.summary) console.log(`Summary: ${task.summary}`);
      if (task.block_reason) console.log(`Block reason: ${task.block_reason}`);
      if (task.scheduled_at) console.log(`Scheduled at: ${new Date(task.scheduled_at * 1000).toISOString()}`);
      if (task.review_reason) console.log(`Review reason: ${task.review_reason}`);
      if (task.schedule_reason) console.log(`Schedule reason: ${task.schedule_reason}`);
      if (task.max_runtime_seconds) console.log(`Max runtime: ${task.max_runtime_seconds}s`);
      if (isEnabled(FF_MAX_RETRIES) && task.max_retries !== null && task.max_retries !== undefined) console.log(`Max retries: ${task.max_retries}`);
      if (isEnabled(FF_MAX_RETRIES) && task.consecutive_failures > 0) console.log(`Consecutive failures: ${task.consecutive_failures}`);
      if (isEnabled(FF_RATE_LIMIT_EXIT_CODE) && task.rate_limited_until) console.log(`Rate limited until: ${new Date(task.rate_limited_until * 1000).toISOString()}`);
      if (task.tenant) console.log(`Tenant: ${task.tenant}`);
      if (task.skills && task.skills.length > 0) console.log(`Skills: ${task.skills.join(", ")}`);
      if (isEnabled(FF_MODEL_OVERRIDE) && task.model_override) console.log(`Model override: ${task.model_override}`);
      if (isEnabled(FF_CREATED_BY)) console.log(`Created by: ${task.created_by}`);
      if (isEnabled(FF_WORKER_LOG_CAPTURE)) {
        const board = getBoardById(task.board_id);
        if (board) {
          console.log(`Log: ${getTaskLogPath(board.slug, task.id)}`);
        }
      }
      if (isEnabled(FF_HEARTBEAT) && task.status === "running" && task.last_heartbeat_at) {
        console.log(`Last heartbeat: ${new Date(task.last_heartbeat_at * 1000).toISOString()}`);
      }
      if (isEnabled(FF_WORKFLOW_TEMPLATES) && task.workflow_template_id) {
        console.log(`Workflow template: ${task.workflow_template_id}`);
        if (task.current_step_key) {
          console.log(`Current step: ${task.current_step_key}`);
        }
      }
      if (isEnabled(FF_GOAL_MODE) && task.goal_mode) {
        const max = task.goal_max_turns ?? 0;
        const remaining = task.goal_remaining_turns ?? 0;
        console.log(`Goal: ${remaining}/${max} turns, judge=${task.goal_judge_profile ?? ""}`);
      }

      const comments = getComments(id);
      if (comments.length > 0) {
        const showAuthor = isEnabled(FF_COMMENT_ENHANCEMENTS);
        console.log("Comments:");
        for (const comment of comments) {
          if (showAuthor) {
            const displayAuthor = comment.author ?? "user";
            console.log(`  [${new Date(comment.created_at * 1000).toISOString()}]  ${displayAuthor}:`);
            console.log(`  ${comment.text}`);
          } else {
            console.log(`  [${new Date(comment.created_at * 1000).toISOString()}] ${comment.text}`);
          }
        }
      }

      if (isEnabled(FF_TASK_ATTACHMENTS)) {
        const attachments = listAttachments(id);
        if (attachments.length > 0) {
          console.log("Attachments:");
          for (const attachment of attachments) {
            console.log(`  - ${attachment.filename} (${attachment.size} bytes) ${attachment.stored_path}`);
          }
        }
      }

      if (isEnabled(FF_SHOW_RUN_FILTERING)) {
        const runs = hasStateType
          ? getRunsFiltered(id, { stateType: options.stateType!, stateName: options.stateName! })
          : getRuns(id);
        if (runs.length === 0) {
          console.log(hasStateType ? "No runs match the filter." : "No runs found for this task.");
        } else {
          console.log("Runs:");
          for (const run of runs) {
            const started = new Date(run.started_at * 1000).toISOString();
            const ended = run.ended_at ? new Date(run.ended_at * 1000).toISOString() : null;
            let line = `  #${run.id}: status=${run.status}`;
            if (run.outcome) line += ` outcome=${run.outcome}`;
            if (run.profile) line += ` profile=${run.profile}`;
            line += ` started=${started}`;
            if (isEnabled(FF_CRASH_GRACE_PERIOD) && run.spawned_at) {
              line += ` spawned=${new Date(run.spawned_at * 1000).toISOString()}`;
            }
            if (ended) line += ` ended=${ended}`;
            if (run.summary) line += ` summary="${run.summary}"`;
            if (run.error) line += ` error="${run.error}"`;
            console.log(line);
          }
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const editTaskCommand = new Command("edit")
  .description("Edit task body")
  .argument("<task_id>", "Task ID")
  .requiredOption("--body <text>", "New body text")
  .action((taskId: string, options: { body: string }) => {
    try {
      const id = parseTaskId(taskId);
      if (!options.body || options.body.trim() === "") {
        throw new Error("Body is required.");
      }
      const task = editTask(id, options.body);
      console.log(`Updated task ${task.id}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const commentTaskCommand = new Command("comment")
  .description("Add a comment to a task")
  .argument("<task_id>", "Task ID")
  .argument("<text>", "Comment text")
  .option("--author <name>", "Comment author")
  .option("--max-len <n>", "Maximum comment length")
  .action((taskId: string, text: string, options: { author?: string; maxLen?: string }) => {
    try {
      if (options.author !== undefined && !isEnabled(FF_COMMENT_ENHANCEMENTS)) {
        throw new Error("Comment enhancements feature is not enabled.");
      }
      if (options.maxLen !== undefined && !isEnabled(FF_COMMENT_ENHANCEMENTS)) {
        throw new Error("Comment enhancements feature is not enabled.");
      }

      const id = parseTaskId(taskId);
      if (!text || text.trim() === "") {
        throw new Error("Comment text is required.");
      }

      let author: string | undefined;
      if (isEnabled(FF_COMMENT_ENHANCEMENTS)) {
        if (options.author !== undefined) {
          if (options.author.trim() === "") {
            throw new Error("Author cannot be empty.");
          }
          author = options.author.trim();
        } else {
          author = Bun.env.KDI_PROFILE ?? Bun.env.HERMES_PROFILE ?? "user";
        }
      }

      let maxLen: number | undefined;
      if (options.maxLen !== undefined) {
        const parsed = Number(options.maxLen);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`Max length must be a positive integer, got "${options.maxLen}"`);
        }
        maxLen = parsed;
      }

      const comment = addComment({ task_id: id, text, author, max_len: maxLen });
      console.log(`Added comment ${comment.id} to task ${id}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const attachTaskCommand = new Command("attach")
  .description("Attach a file to a task")
  .argument("<task_id>", "Task ID")
  .argument("<file>", "Path to the file to attach")
  .action((taskId: string, file: string) => {
    try {
      if (!isEnabled(FF_TASK_ATTACHMENTS)) {
        throw new Error("Task attachments feature is not enabled.");
      }
      const id = parseTaskId(taskId);
      const attachment = createAttachment(id, file);
      console.log(`Attached ${attachment.filename} to task ${id} (${attachment.size} bytes).`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const promoteTaskCommand = new Command("promote")
  .description("Promote task(s) from todo to ready")
  .argument("[task_ids...]", "One or more task IDs")
  .option("--force", "Promote even if parent dependencies are not done")
  .option("--dry-run", "Validate promotion without mutating state")
  .action((taskIds: string[], options: { force?: boolean; dryRun?: boolean }) => {
    try {
      if (taskIds.length === 0) {
        throw new Error("At least one task ID is required.");
      }

      const isBulk = taskIds.length > 1 || options.force || options.dryRun;
      if (isBulk && !isEnabled(FF_BULK_OPERATIONS)) {
        throw new Error("Bulk operations feature is not enabled.");
      }

      const ids = taskIds.map(parseTaskId);

      if (options.dryRun) {
        let allOk = true;
        for (const id of ids) {
          const verdict = promoteTaskAdvanced(id, { force: options.force, dryRun: true });
          printVerdict(id, verdict);
          if (verdict.status !== "would_promote") {
            allOk = false;
          }
        }
        if (!allOk) process.exit(1);
        return;
      }

      // Single-task promote without force/dry-run when flag is disabled
      // uses the existing simple promote (backward compat). When the flag
      // is enabled, always use promoteTaskAdvanced for dependency checks.
      if (!isBulk) {
        const id = ids[0];
        if (!isEnabled(FF_BULK_OPERATIONS)) {
          const task = promoteTask(id);
          console.log(`Promoted task ${task.id} to ready.`);
          return;
        }
        // Flag enabled: use advanced promote for dependency checks
        const result = promoteTaskAdvanced(id);
        if (result.status === "promoted") {
          console.log(`Promoted task ${result.task.id} to ready.`);
        } else {
          printVerdict(id, result);
          process.exit(1);
        }
        return;
      }

      let skipped = 0;
      for (const id of ids) {
        const result = promoteTaskAdvanced(id, { force: options.force });
        if (result.status === "promoted") {
          console.log(`Promoted task ${result.task.id} to ready.`);
        } else {
          printVerdict(id, result);
          skipped++;
        }
      }

      const promoted = ids.length - skipped;
      if (ids.length > 1) {
        console.log(`Promoted ${promoted}/${ids.length} tasks.`);
      }
      if (skipped > 0) process.exit(1);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const assignTaskCommand = new Command("assign")
  .description("Assign a task to a profile, or 'none' to unassign")
  .argument("<task_id>", "Task ID")
  .argument("<profile>", "Profile name or 'none'")
  .action((taskId: string, profile: string) => {
    try {
      if (!isEnabled(FF_ASSIGN_REASSIGN)) {
        throw new Error("Assign/reassign feature is not enabled.");
      }
      const id = parseTaskId(taskId);
      const trimmed = profile.trim();
      if (trimmed === "") {
        throw new Error("Profile cannot be empty.");
      }
      if (trimmed.toLowerCase() === "none") {
        const task = unassignTask(id);
        console.log(`Unassigned task ${task.id}.`);
      } else {
        const task = assignTask(id, trimmed);
        console.log(`Assigned task ${task.id} to ${trimmed}.`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const reassignTaskCommand = new Command("reassign")
  .description("Reassign a task to another profile")
  .argument("<task_id>", "Task ID")
  .argument("<profile>", "Profile name or 'none'")
  .option("--reclaim", "Reclaim active claim on a running task before reassigning")
  .option("--reason <text>", "Reason for reclaim")
  .action((taskId: string, profile: string, options: { reclaim?: boolean; reason?: string }) => {
    try {
      if (!isEnabled(FF_ASSIGN_REASSIGN)) {
        throw new Error("Assign/reassign feature is not enabled.");
      }
      const id = parseTaskId(taskId);
      const trimmed = profile.trim();
      if (trimmed === "") {
        throw new Error("Profile cannot be empty.");
      }
      const targetProfile = trimmed.toLowerCase() === "none" ? null : trimmed;
      const task = reassignTask(id, targetProfile, { reclaim: options.reclaim, reason: options.reason });
      if (targetProfile === null) {
        console.log(`Unassigned task ${task.id}.`);
      } else {
        console.log(`Reassigned task ${task.id} to ${targetProfile}.`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const blockTaskCommand = new Command("block")
  .description("Block one or more tasks")
  .argument("[task_ids...]", "One or more task IDs")
  .requiredOption("--reason <text>", "Block reason")
  .action((taskIds: string[], options: { reason: string }) => {
    try {
      if (taskIds.length === 0) {
        throw new Error("At least one task ID is required.");
      }

      if (taskIds.length > 1 && !isEnabled(FF_BULK_OPERATIONS)) {
        throw new Error("Bulk operations feature is not enabled.");
      }

      if (!options.reason || options.reason.trim() === "") {
        throw new Error("Block reason is required.");
      }

      const ids = taskIds.map(parseTaskId);
      let skipped = 0;
      for (const id of ids) {
        try {
          const task = showTask(id);
          if (!task) {
            console.error(`Skipped task ${id}: not found`);
            skipped++;
            continue;
          }
          if (task.status === "blocked") {
            console.error(`Skipped task ${id}: already blocked`);
            skipped++;
            continue;
          }
          if (task.archived_at !== null) {
            console.error(`Skipped task ${id}: already archived`);
            skipped++;
            continue;
          }
          const blocked = blockTask(id, options.reason);
          console.log(`Blocked task ${blocked.id}.`);
        } catch (err: any) {
          console.error(`Skipped task ${id}: ${err.message}`);
          skipped++;
        }
      }

      if (ids.length > 1) {
        const blocked = ids.length - skipped;
        console.log(`Blocked ${blocked}/${ids.length} tasks.`);
      }
      if (skipped > 0) process.exit(1);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const unblockTaskCommand = new Command("unblock")
  .description("Unblock a task (or immediately ready a scheduled task)")
  .argument("<task_id>", "Task ID")
  .option("--reason <text>", "Optional reason recorded as comment")
  .action((taskId: string, options: { reason?: string }) => {
    try {
      const id = parseTaskId(taskId);
      const current = showTask(id);
      if (current && current.status === "scheduled" && !isEnabled(FF_SCHEDULED_STATUS)) {
        throw new Error("Scheduled status feature is not enabled.");
      }
      const task = unblockTask(id, options.reason);
      if (task.status === "ready") {
        console.log(`Task ${task.id} is now ready.`);
      } else {
        console.log(`Unblocked task ${task.id}.`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const scheduleTaskCommand = new Command("schedule")
  .description("Schedule one or more tasks to become ready at a future time")
  .argument("<task_ids...>", "One or more task IDs")
  .requiredOption("--at <timestamp>", "ISO 8601 or Unix timestamp (seconds)")
  .option("--reason <text>", "Reason for scheduling")
  .action((taskIds: string[], options: { at: string; reason?: string }) => {
    try {
      if (!isEnabled(FF_SCHEDULED_STATUS)) {
        throw new Error("Scheduled status feature is not enabled.");
      }
      if (taskIds.length === 0) {
        throw new Error("At least one task ID is required.");
      }
      const scheduledAt = parseTimestamp(options.at);
      const now = Math.floor(Date.now() / 1000);
      if (scheduledAt <= now) {
        throw new Error("Scheduled time must be in the future");
      }
      const ids = taskIds.map(parseTaskId);
      const scheduled: number[] = [];
      let skipped = 0;
      for (const id of ids) {
        try {
          const task = scheduleTask(id, scheduledAt, options.reason);
          console.log(`Scheduled task ${task.id} for ${new Date(scheduledAt * 1000).toISOString()}.`);
          scheduled.push(task.id);
        } catch (err: any) {
          console.error(`Skipped task ${id}: ${err.message}`);
          skipped++;
        }
      }
      if (scheduled.length > 1) {
        console.log(`Scheduled ${scheduled.length} tasks.`);
      }
      if (skipped > 0) process.exit(1);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const reviewTaskCommand = new Command("review")
  .description("Mark a task as under review")
  .argument("<task_id>", "Task ID")
  .option("--reason <text>", "Reason or note for review")
  .action((taskId: string, options: { reason?: string }) => {
    try {
      if (!isEnabled(FF_REVIEW_STATUS)) {
        throw new Error("Review status feature is not enabled.");
      }
      const id = parseTaskId(taskId);
      const task = reviewTask(id, options.reason);
      console.log(`Marked task ${task.id} as under review.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const stepTaskCommand = new Command("step")
  .description("Advance or jump a workflow-template task to a step")
  .argument("<task_id>", "Task ID")
  .option("--to <key>", "Jump to a specific step key")
  .option("--reason <text>", "Reason for the step change")
  .action((taskId: string, options: { to?: string; reason?: string }) => {
    try {
      if (!isEnabled(FF_WORKFLOW_TEMPLATES)) {
        throw new Error("Workflow templates feature is not enabled.");
      }
      const id = parseTaskId(taskId);

      let task: import("../models/task").Task;
      if (options.to !== undefined) {
        task = setTaskStep(id, options.to.trim(), options.reason);
        console.log(`Set task ${task.id} to step ${task.current_step_key}.`);
      } else {
        task = advanceTaskStep(id, options.reason);
        if (task.status === "done") {
          console.log(`Completed task ${task.id} at terminal workflow step.`);
        } else {
          console.log(`Advanced task ${task.id} to step ${task.current_step_key}.`);
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const specifyTaskCommand = new Command("specify")
  .description("Promote a triage task to todo")
  .argument("[task_id]", "Task ID")
  .option("--all", "Promote all triage tasks for the current board")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--tenant <name>", "Tenant namespace filter (requires FF_TRIAGE_AUTOMATION)")
  .option("--skip-llm", "Use manual promotion path")
  .action(async (taskId: string | undefined, options: { all?: boolean; board?: string; tenant?: string; skipLlm?: boolean }) => {
    try {
      const boardSlug = resolveBoard(options.board);
      const boardId = getBoardIdBySlug(boardSlug);
      const useLlm = isEnabled(FF_TRIAGE_AUTOMATION) && !options.skipLlm;

      if (options.tenant !== undefined && !isEnabled(FF_TRIAGE_AUTOMATION)) {
        throw new Error("Triage automation feature is not enabled.");
      }
      if (options.tenant !== undefined && options.tenant.trim() === "") {
        throw new Error("Tenant cannot be empty.");
      }

      if (options.all) {
        const tasks = listTasks({ board_id: boardId, status: "triage", tenant: options.tenant });
        if (tasks.length === 0) {
          console.log("No triage tasks to specify.");
          return;
        }
        let specified = 0;
        let skipped = 0;
        for (const task of tasks) {
          try {
            if (useLlm) {
              const updated = await specifyTaskWithLlm(task.id);
              console.log(`Specified task ${updated.id}: ${updated.title}`);
            } else {
              const updated = specifyTask(task.id);
              console.log(`Specified task ${updated.id}: ${updated.title}`);
            }
            specified++;
          } catch (err: any) {
            console.error(`Skipped task ${task.id}: ${err.message}`);
            skipped++;
          }
        }
        console.log(`Specified ${specified}/${tasks.length} tasks.`);
        if (skipped > 0) process.exit(1);
        return;
      }

      if (!taskId) {
        throw new Error("Task ID is required (or use --all).");
      }

      const id = parseTaskId(taskId);
      if (useLlm) {
        const task = await specifyTaskWithLlm(id);
        console.log(`Specified task ${task.id}: ${task.title}`);
      } else {
        const task = specifyTask(id);
        console.log(`Specified task ${task.id}: ${task.title}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const decomposeTaskCommand = new Command("decompose")
  .description("Decompose a triage task into child tasks via LLM")
  .argument("[task_id]", "Task ID")
  .option("--all", "Decompose all triage tasks for the current board")
  .option("--board <slug>", "Board slug (resolved via chain: --board, KDI_BOARD, current, default)")
  .option("--tenant <name>", "Tenant namespace filter")
  .action(async (taskId: string | undefined, options: { all?: boolean; board?: string; tenant?: string }) => {
    try {
      if (!isEnabled(FF_TRIAGE_AUTOMATION)) {
        throw new Error("Triage automation feature is not enabled.");
      }
      if (options.tenant !== undefined && options.tenant.trim() === "") {
        throw new Error("Tenant cannot be empty.");
      }

      const boardSlug = resolveBoard(options.board);
      const boardId = getBoardIdBySlug(boardSlug);

      if (options.all) {
        const tasks = listTasks({ board_id: boardId, status: "triage", tenant: options.tenant });
        if (tasks.length === 0) {
          console.log("No triage tasks to decompose.");
          return;
        }
        let decomposed = 0;
        let skipped = 0;
        for (const task of tasks) {
          try {
            const data = await callTriageLlm(buildDecomposePrompt(task));
            const children = decomposeTask(task.id, data);
            console.log(`Decomposed task ${task.id}: created ${children.length} children`);
            decomposed++;
          } catch (err: any) {
            console.error(`Skipped task ${task.id}: ${err.message}`);
            skipped++;
          }
        }
        console.log(`Decomposed ${decomposed}/${tasks.length} tasks.`);
        if (skipped > 0) process.exit(1);
        return;
      }

      if (!taskId) {
        throw new Error("Task ID is required (or use --all).");
      }

      const id = parseTaskId(taskId);
      const task = showTask(id);
      if (!task) {
        throw new Error(`Task ${id} not found.`);
      }
      if (task.status !== "triage") {
        throw new Error(`Task ${id} is not in triage status.`);
      }

      const data = await callTriageLlm(buildDecomposePrompt(task));
      const children = decomposeTask(id, data);
      console.log(`Decomposed task ${id}: created ${children.length} children`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const archiveTaskCommand = new Command("archive")
  .description("Archive a task, or permanently delete archived task(s) with --rm")
  .argument("[task_ids...]", "Task ID(s)")
  .option("--rm", "Permanently delete already-archived task(s)")
  .action((taskIds: string[], options: { rm?: boolean }) => {
    try {
      if (options.rm) {
        if (!isEnabled(FF_BULK_OPERATIONS)) {
          throw new Error("Bulk operations feature is not enabled.");
        }
        if (taskIds.length === 0) {
          throw new Error("At least one task ID is required.");
        }
        const ids = taskIds.map(parseTaskId);
        let skipped = 0;
        for (const id of ids) {
          try {
            archiveTaskHard(id);
            console.log(`Permanently deleted task ${id}.`);
          } catch (err: any) {
            console.error(`Skipped task ${id}: ${err.message}`);
            skipped++;
          }
        }
        if (ids.length > 1) {
          const deleted = ids.length - skipped;
          console.log(`Deleted ${deleted}/${ids.length} tasks.`);
        }
        if (skipped > 0) process.exit(1);
        return;
      }

      if (taskIds.length === 0) {
        throw new Error("At least one task ID is required.");
      }
      if (taskIds.length > 1) {
        throw new Error("Archive only supports a single task ID (use --rm for bulk deletion of archived tasks).");
      }

      const id = parseTaskId(taskIds[0]);
      const task = archiveTask(id);
      console.log(`Archived task ${task.id}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const completeTaskCommand = new Command("complete")
  .description("Complete task(s) with optional metadata")
  .argument("<task_ids...>", "One or more task IDs")
  .option("--result <text>", "Result payload (applies to all tasks in bulk)")
  .option("--summary <text>", "Short summary")
  .option("--metadata <json>", "JSON metadata payload")
  .action((taskIds: string[], options: { result?: string; summary?: string; metadata?: string }) => {
    try {
      if (taskIds.length === 0) {
        throw new Error("At least one task ID is required.");
      }

      if (options.metadata !== undefined) {
        if (!isEnabled(FF_COMPLETE_METADATA)) {
          throw new Error("Complete --metadata is not enabled.");
        }
        try {
          JSON.parse(options.metadata);
        } catch {
          throw new Error("Metadata must be valid JSON.");
        }
      }

      if (taskIds.length > 1 && (options.summary !== undefined || options.metadata !== undefined)) {
        throw new Error("Bulk complete only supports --result.");
      }

      const ids = taskIds.map(parseTaskId);
      const completed: number[] = [];
      for (const id of ids) {
        const task = completeTask(id, {
          result: options.result,
          summary: options.summary,
          metadata: options.metadata,
        });
        console.log(`Completed task ${task.id}.`);
        completed.push(task.id);
      }

      if (completed.length > 1) {
        console.log(`Completed ${completed.length} tasks.`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const tailTaskCommand = new Command("tail")
  .description("Tail events for a task")
  .argument("<task_id>", "Task ID")
  .action(async (taskId: string) => {
    try {
      const id = parseTaskId(taskId);
      const task = showTask(id);
      if (!task) {
        console.error(`Task ${id} not found.`);
        process.exit(1);
      }

      const events = getEvents(id);
      let maxId = 0;
      for (const event of events.slice().reverse()) {
        const ts = new Date(event.created_at * 1000).toISOString();
        const payload = event.payload ? ` ${event.payload}` : "";
        console.log(`[${ts}] ${event.kind}${payload}`);
        if (event.id > maxId) maxId = event.id;
      }

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const newEvents = tailEvents(id, maxId);
        for (const event of newEvents) {
          const ts = new Date(event.created_at * 1000).toISOString();
          const payload = event.payload ? ` ${event.payload}` : "";
          console.log(`[${ts}] ${event.kind}${payload}`);
          if (event.id > maxId) maxId = event.id;
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const watchCommand = new Command("watch")
  .description("Watch board-wide events")
  .option("--assignee <profile>", "Filter events by task assignee")
  .option("--tenant <name>", "Filter events by task tenant")
  .option("--kinds <list>", "Comma-separated event kinds to watch")
  .option("--interval <seconds>", "Poll interval in seconds (default 0.5)", "0.5")
  .action(async (options: { assignee?: string; tenant?: string; kinds?: string; interval?: string }) => {
    try {
      const hasFilters = !!(options.assignee || options.tenant || options.kinds || options.interval !== "0.5");

      if (hasFilters && !isEnabled(FF_WATCH_FILTERS)) {
        throw new Error("Watch filters feature is not enabled.");
      }

      if (options.tenant && !isEnabled(FF_TENANT_NAMESPACE)) {
        throw new Error("Tenant namespace feature is not enabled.");
      }

      // Validate assignee
      if (options.assignee !== undefined && options.assignee.trim() === "") {
        throw new Error("Assignee cannot be empty.");
      }

      // Validate tenant
      if (options.tenant !== undefined && options.tenant.trim() === "") {
        throw new Error("Tenant cannot be empty.");
      }

      // Validate kinds
      const kindsList = options.kinds !== undefined
        ? options.kinds.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
        : undefined;
      if (options.kinds !== undefined && (!kindsList || kindsList.length === 0)) {
        throw new Error("Kinds cannot be empty.");
      }

      // Validate interval
      let intervalMs = 500;
      if (options.interval !== undefined) {
        const parsed = parseFloat(options.interval);
        if (isNaN(parsed)) {
          throw new Error("Interval must be a positive number.");
        }
        if (parsed < 0.1) {
          throw new Error("Interval must be at least 0.1 seconds.");
        }
        intervalMs = parsed * 1000;
      }

      const filters: WatchFilters = {};
      if (options.assignee) filters.assignee = options.assignee.trim();
      if (options.tenant) filters.tenant = options.tenant.trim();
      if (kindsList) filters.kinds = kindsList;

      const events = getRecentEvents(50, filters);
      let maxId = 0;
      for (const event of events.slice().reverse()) {
        const ts = new Date(event.created_at * 1000).toISOString();
        console.log(`${event.task_id}\t${event.kind}\t${ts}`);
        if (event.id > maxId) maxId = event.id;
      }

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const newEvents = getEventsAfter(maxId, filters);
        for (const event of newEvents) {
          const ts = new Date(event.created_at * 1000).toISOString();
          console.log(`${event.task_id}\t${event.kind}\t${ts}`);
          if (event.id > maxId) maxId = event.id;
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const claimTaskCommand = new Command("claim")
  .description("Atomically claim a ready task")
  .argument("<task_id>", "Task ID")
  .option("--ttl <seconds>", "Claim TTL in seconds")
  .action((taskId: string, options: { ttl?: string }) => {
    try {
      const id = parseTaskId(taskId);
      const ttl = options.ttl ? parseInt(options.ttl, 10) : undefined;
      if (options.ttl && (isNaN(ttl!) || ttl! <= 0)) {
        throw new Error("TTL must be a positive integer");
      }

      const profile = process.env.KDI_PROFILE || "user";
      const result = atomicClaim(id, profile, ttl);
      if (!result.success) {
        console.error(`Task ${id} is not available for claim (not ready or already claimed).`);
        process.exit(1);
      }
      console.log(`Claimed task ${id}`);
      console.log(`claim_lock: ${profile}`);
      console.log(`expires_at: ${result.expiresAt}`);
      if (result.runId) {
        console.log(`run_id: ${result.runId}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const reclaimTaskCommand = new Command("reclaim")
  .description("Release an active claim on a running task")
  .argument("<task_id>", "Task ID")
  .option("--reason <text>", "Reason for reclaim")
  .action((taskId: string, options: { reason?: string }) => {
    try {
      if (options.reason !== undefined && !isEnabled(FF_ASSIGN_REASSIGN)) {
        throw new Error("The --reason option requires the assign/reassign feature.");
      }
      const id = parseTaskId(taskId);
      const ok = reclaimTask(id, options.reason);
      if (!ok) {
        console.error(`Task ${id} is not running or has no active claim.`);
        process.exit(1);
      }
      console.log(`Reclaimed task ${id}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

const MAX_HEARTBEAT_NOTE_BYTES = 4096;

export const heartbeatTaskCommand = new Command("heartbeat")
  .description("Emit a heartbeat for a running task")
  .argument("<task_id>", "Task ID")
  .option("--note <text>", "Optional note")
  .action((taskId: string, options: { note?: string }) => {
    try {
      if (!isEnabled(FF_HEARTBEAT)) {
        throw new Error("Heartbeat feature is not enabled.");
      }

      const id = parseTaskId(taskId);
      const task = showTask(id);
      if (!task) {
        throw new Error(`Task ${id} not found.`);
      }
      if (task.status === "archived") {
        throw new Error(`Task ${id} is archived.`);
      }
      if (task.status !== "running") {
        throw new Error(`Task ${id} is not running.`);
      }

      let note = options.note;
      if (note !== undefined && note.length > MAX_HEARTBEAT_NOTE_BYTES) {
        note = note.slice(0, MAX_HEARTBEAT_NOTE_BYTES);
      }

      const ok = heartbeat(id, note);
      if (!ok) {
        throw new Error(`Task ${id} is not running.`);
      }
      console.log(`Heartbeat recorded for task ${id}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const logTaskCommand = new Command("log")
  .description("Show worker log for a task")
  .argument("<task_id>", "Task ID")
  .option("--tail <bytes>", "Only show last N bytes")
  .action((taskId: string, options: { tail?: string }) => {
    try {
      if (!isEnabled(FF_WORKER_LOG_CAPTURE)) {
        throw new Error("Worker log capture is not enabled.");
      }

      const id = parseTaskId(taskId);
      const task = showTask(id);
      if (!task) {
        console.error(`Task ${id} not found.`);
        process.exit(1);
      }
      const board = getBoardById(task.board_id);
      if (!board) {
        console.error(`Board not found for task ${id}.`);
        process.exit(1);
      }
      const logPath = getTaskLogPath(board.slug, id);

      let tailBytes: number | undefined;
      if (options.tail !== undefined) {
        tailBytes = parseInt(options.tail, 10);
        if (isNaN(tailBytes) || tailBytes <= 0) {
          throw new Error("--tail must be a positive integer.");
        }
      }

      if (!existsSync(logPath)) {
        console.log("No log found for this task.");
        return;
      }

      let content = readFileSync(logPath, "utf-8");
      if (tailBytes !== undefined && content.length > tailBytes) {
        content = content.slice(-tailBytes);
      }
      process.stdout.write(content);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const listRunsCommand = new Command("runs")
  .description("Show task run history")
  .argument("<task_id>", "Task ID")
  .action((taskId: string) => {
    try {
      const id = parseTaskId(taskId);
      const runs = getRuns(id);
      if (runs.length === 0) {
        console.log("No runs found for this task.");
        return;
      }
      for (const run of runs) {
        const started = new Date(run.started_at * 1000).toISOString();
        const ended = run.ended_at ? new Date(run.ended_at * 1000).toISOString() : null;
        let line = `Run #${run.id}: status=${run.status}`;
        if (run.outcome) line += ` outcome=${run.outcome}`;
        if (run.profile) line += ` profile=${run.profile}`;
        if (run.step_key) line += ` step=${run.step_key}`;
        line += ` started=${started}`;
        if (isEnabled(FF_CRASH_GRACE_PERIOD) && run.spawned_at) {
          line += ` spawned=${new Date(run.spawned_at * 1000).toISOString()}`;
        }
        if (ended) line += ` ended=${ended}`;
        if (run.summary) line += ` summary="${run.summary}"`;
        if (run.metadata) line += ` metadata="${run.metadata}"`;
        if (run.error) line += ` error="${run.error}"`;
        console.log(line);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
