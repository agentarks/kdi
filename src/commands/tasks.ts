import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { showBoard, getBoardById } from "../models/board";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  blockTask,
  unblockTask,
  archiveTask,
  specifyTask,
  completeTask,
  reviewTask,
  scheduleTask,
  parseDuration,
} from "../models/task";
import { addComment, getComments } from "../models/comment";
import { getRuns } from "../models/taskRun";
import { getEvents, tailEvents, getRecentEvents, getEventsAfter } from "../models/taskEvent";
import { atomicClaim, reclaimTask, heartbeat } from "../models/claim";
import { getTaskLogPath } from "../observability";
import { isEnabled, FF_SCHEDULED_STATUS, FF_REVIEW_STATUS, FF_COMPLETE_METADATA, FF_PRIORITY_INTEGER, FF_SKILLS_ARRAY, FF_MAX_RUNTIME, FF_TENANT_NAMESPACE, FF_CREATED_BY } from "../flags";

const VALID_STATUSES = ["triage", "todo", "scheduled", "ready", "running", "done", "blocked", "review"] as const;
type ValidStatus = typeof VALID_STATUSES[number];

function isValidStatus(status: string): status is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(status);
}

function getBoardIdBySlug(slug: string): number {
  const board = showBoard(slug, false);
  if (!board) {
    throw new Error(`Board "${slug}" not found.`);
  }
  return board.id;
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

export const createTaskCommand = new Command("create")
  .description("Create a new task")
  .argument("<title>", "Task title")
  .requiredOption("--board <slug>", "Board slug")
  .option("--assignee <profile>", "Assignee profile")
  .option("--body <text>", "Task body")
  .option("--triage", "Park in triage status instead of todo")
  .option("--initial-status <status>", "Initial task status (default: todo)")
  .option("--at <timestamp>", "ISO 8601 or Unix timestamp for scheduled tasks (required when --initial-status=scheduled)")
  .option("--priority <n>", "Integer priority, higher is more urgent (default: 0)")
  .option("--idempotency-key <key>", "Dedup key; returns existing non-archived task id if matched")
  .option("--max-runtime <duration>", "Maximum runtime (e.g. 30m, 1h, 2d, 90s). Feature-flagged.")
  .option("--tenant <name>", "Tenant namespace for the task")
  .option("--skill <skill>", "Add a skill to the task (repeatable)", collectSkill, [])
  .option("--created-by <actor>", "Actor that created the task")
  .action((title: string, options: { board: string; assignee?: string; body?: string; triage?: boolean; initialStatus?: string; at?: string; priority?: string; idempotencyKey?: string; maxRuntime?: string; tenant?: string; skill: string[]; createdBy?: string }) => {
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

      if (options.createdBy !== undefined && !isEnabled(FF_CREATED_BY)) {
        throw new Error("Created-by tracking is not enabled.");
      }

      let createdBy: string | undefined;
      if (isEnabled(FF_CREATED_BY)) {
        createdBy = resolveCreator(options.createdBy);
      }

      const boardId = getBoardIdBySlug(options.board);
      const task = createTask({
        board_id: boardId,
        title,
        assignee: options.assignee,
        body: options.body,
        triage: options.triage,
        initialStatus,
        priority,
        idempotency_key: options.idempotencyKey,
        scheduled_at: scheduledAt,
        max_runtime_seconds: maxRuntimeSeconds,
        tenant: options.tenant,
        skills,
        created_by: createdBy,
      });
      console.log(task.id);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const listTasksCommand = new Command("list")
  .description("List tasks")
  .requiredOption("--board <slug>", "Board slug")
  .option("--status <status>", "Filter by status")
  .option("--assignee <profile>", "Filter by assignee")
  .option("--tenant <name>", "Filter by tenant namespace")
  .option("--created-by <actor>", "Filter by creator")
  .action((options: { board: string; status?: string; assignee?: string; tenant?: string; createdBy?: string }) => {
    try {
      if (options.status && !isValidStatus(options.status)) {
        throw new Error(`Invalid status "${options.status}". Valid: ${VALID_STATUSES.join(", ")}`);
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
      const boardId = getBoardIdBySlug(options.board);
      const tasks = listTasks({ board_id: boardId, status: options.status as any, assignee: options.assignee, tenant: options.tenant, created_by: options.createdBy });
      if (tasks.length === 0) {
        console.log("No tasks.");
        return;
      }
      for (const task of tasks) {
        console.log(`${task.id}: ${task.title} [${task.status}]${task.assignee ? " @" + task.assignee : ""}`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const showTaskCommand = new Command("show")
  .description("Show task details")
  .argument("<task_id>", "Task ID")
  .action((taskId: string) => {
    try {
      const id = parseTaskId(taskId);
      const task = showTask(id);
      if (!task) {
        console.error(`Task ${id} not found.`);
        process.exit(1);
      }
      console.log(`ID: ${task.id}`);
      console.log(`Title: ${task.title}`);
      console.log(`Status: ${task.status}`);
      console.log(`Priority: ${task.priority}`);
      if (task.assignee) console.log(`Assignee: ${task.assignee}`);
      if (task.body) console.log(`Body: ${task.body}`);
      if (task.result) console.log(`Result: ${task.result}`);
      if (task.summary) console.log(`Summary: ${task.summary}`);
      if (task.block_reason) console.log(`Block reason: ${task.block_reason}`);
      if (task.scheduled_at) console.log(`Scheduled at: ${new Date(task.scheduled_at * 1000).toISOString()}`);
      if (task.review_reason) console.log(`Review reason: ${task.review_reason}`);
      if (task.schedule_reason) console.log(`Schedule reason: ${task.schedule_reason}`);
      if (task.max_runtime_seconds) console.log(`Max runtime: ${task.max_runtime_seconds}s`);
      if (task.tenant) console.log(`Tenant: ${task.tenant}`);
      if (task.skills && task.skills.length > 0) console.log(`Skills: ${task.skills.join(", ")}`);
      if (isEnabled(FF_CREATED_BY)) console.log(`Created by: ${task.created_by}`);

      const comments = getComments(id);
      if (comments.length > 0) {
        console.log("Comments:");
        for (const comment of comments) {
          console.log(`  [${new Date(comment.created_at * 1000).toISOString()}] ${comment.text}`);
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
  .action((taskId: string, text: string) => {
    try {
      const id = parseTaskId(taskId);
      if (!text || text.trim() === "") {
        throw new Error("Comment text is required.");
      }
      const comment = addComment(id, text);
      console.log(`Added comment ${comment.id} to task ${id}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const promoteTaskCommand = new Command("promote")
  .description("Promote a task from todo to ready")
  .argument("<task_id>", "Task ID")
  .action((taskId: string) => {
    try {
      const id = parseTaskId(taskId);
      const task = promoteTask(id);
      console.log(`Promoted task ${task.id} to ready.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const blockTaskCommand = new Command("block")
  .description("Block a task")
  .argument("<task_id>", "Task ID")
  .requiredOption("--reason <text>", "Block reason")
  .action((taskId: string, options: { reason: string }) => {
    try {
      const id = parseTaskId(taskId);
      if (!options.reason || options.reason.trim() === "") {
        throw new Error("Block reason is required.");
      }
      const task = blockTask(id, options.reason);
      console.log(`Blocked task ${task.id}.`);
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
      for (const id of ids) {
        const task = scheduleTask(id, scheduledAt, options.reason);
        console.log(`Scheduled task ${task.id} for ${new Date(scheduledAt * 1000).toISOString()}.`);
        scheduled.push(task.id);
      }
      if (scheduled.length > 1) {
        console.log(`Scheduled ${scheduled.length} tasks.`);
      }
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

export const specifyTaskCommand = new Command("specify")
  .description("Promote a triage task to todo")
  .argument("[task_id]", "Task ID")
  .option("--all", "Promote all triage tasks for the current board")
  .requiredOption("--board <slug>", "Board slug")
  .action((taskId: string | undefined, options: { all?: boolean; board: string }) => {
    try {
      const boardId = getBoardIdBySlug(options.board);

      if (options.all) {
        const tasks = listTasks({ board_id: boardId, status: "triage" });
        if (tasks.length === 0) {
          console.log("No triage tasks to specify.");
          return;
        }
        let specified = 0;
        for (const task of tasks) {
          try {
            specifyTask(task.id);
            console.log(`Specified task ${task.id}: ${task.title}`);
            specified++;
          } catch (err: any) {
            console.error(`Skipped task ${task.id}: ${err.message}`);
          }
        }
        console.log(`Specified ${specified}/${tasks.length} tasks.`);
        return;
      }

      if (!taskId) {
        throw new Error("Task ID is required (or use --all).");
      }

      const id = parseTaskId(taskId);
      const task = specifyTask(id);
      console.log(`Specified task ${task.id}: ${task.title}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

export const archiveTaskCommand = new Command("archive")
  .description("Archive a task")
  .argument("<task_id>", "Task ID")
  .action((taskId: string) => {
    try {
      const id = parseTaskId(taskId);
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
  .action(async () => {
    try {
      const events = getRecentEvents(50);
      let maxId = 0;
      for (const event of events.slice().reverse()) {
        const ts = new Date(event.created_at * 1000).toISOString();
        console.log(`${event.task_id}\t${event.kind}\t${ts}`);
        if (event.id > maxId) maxId = event.id;
      }

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const newEvents = getEventsAfter(maxId);
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

export const heartbeatTaskCommand = new Command("heartbeat")
  .description("Emit a heartbeat for a running task")
  .argument("<task_id>", "Task ID")
  .option("--note <text>", "Optional note")
  .action((taskId: string, options: { note?: string }) => {
    try {
      const id = parseTaskId(taskId);
      const ok = heartbeat(id, options.note);
      if (!ok) {
        console.error(`Task ${id} is not running.`);
        process.exit(1);
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
      if (!existsSync(logPath)) {
        console.log("No log found for this task.");
        return;
      }
      let content = readFileSync(logPath, "utf-8");
      if (options.tail) {
        const tailBytes = parseInt(options.tail, 10);
        if (!isNaN(tailBytes) && tailBytes > 0 && content.length > tailBytes) {
          content = content.slice(-tailBytes);
        }
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
        line += ` started=${started}`;
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
