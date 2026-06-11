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
} from "../models/task";
import { addComment, getComments } from "../models/comment";
import { getRuns } from "../models/taskRun";
import { getEvents, tailEvents, getRecentEvents, getEventsAfter } from "../models/taskEvent";
import { atomicClaim, reclaimTask, heartbeat } from "../models/claim";
import { getTaskLogPath } from "../observability";

const VALID_STATUSES = ["triage", "todo", "ready", "running", "done", "blocked"] as const;
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

export const createTaskCommand = new Command("create")
  .description("Create a new task")
  .argument("<title>", "Task title")
  .requiredOption("--board <slug>", "Board slug")
  .option("--assignee <profile>", "Assignee profile")
  .option("--body <text>", "Task body")
  .option("--triage", "Park in triage status instead of todo")
  .option("--initial-status <status>", "Initial task status (default: todo)")
  .option("--idempotency-key <key>", "Dedup key; returns existing non-archived task id if matched")
  .action((title: string, options: { board: string; assignee?: string; body?: string; triage?: boolean; initialStatus?: string; idempotencyKey?: string }) => {
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

      let initialStatus: ValidStatus | undefined;
      if (options.initialStatus) {
        if (!isValidStatus(options.initialStatus)) {
          throw new Error(`Invalid status "${options.initialStatus}". Valid: ${VALID_STATUSES.join(", ")}`);
        }
        initialStatus = options.initialStatus;
      }

      const boardId = getBoardIdBySlug(options.board);
      const task = createTask({
        board_id: boardId,
        title,
        assignee: options.assignee,
        body: options.body,
        triage: options.triage,
        initialStatus,
        idempotency_key: options.idempotencyKey,
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
  .action((options: { board: string; status?: string }) => {
    try {
      if (options.status && !isValidStatus(options.status)) {
        throw new Error(`Invalid status "${options.status}". Valid: ${VALID_STATUSES.join(", ")}`);
      }
      const boardId = getBoardIdBySlug(options.board);
      const tasks = listTasks({ board_id: boardId, status: options.status as any });
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
  .description("Unblock a task")
  .argument("<task_id>", "Task ID")
  .action((taskId: string) => {
    try {
      const id = parseTaskId(taskId);
      const task = unblockTask(id);
      console.log(`Unblocked task ${task.id}.`);
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
        if (run.error) line += ` error="${run.error}"`;
        console.log(line);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
