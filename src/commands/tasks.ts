import { Command } from "commander";
import { showBoard } from "../models/board";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  blockTask,
  unblockTask,
  archiveTask,
} from "../models/task";
import { addComment, getComments } from "../models/comment";

const VALID_STATUSES = ["todo", "ready", "running", "done", "blocked"];

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
  .action((title: string, options: { board: string; assignee?: string; body?: string }) => {
    try {
      if (!title || title.trim() === "") {
        throw new Error("Title is required.");
      }
      const boardId = getBoardIdBySlug(options.board);
      const task = createTask({
        board_id: boardId,
        title,
        assignee: options.assignee,
        body: options.body,
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
      if (options.status && !VALID_STATUSES.includes(options.status)) {
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
