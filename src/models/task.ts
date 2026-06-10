import { getDb } from "../db";

const TASK_COLUMNS =
  "id, board_id, title, body, assignee, status, priority, " +
  "workspace_kind, branch, result, summary, block_reason, " +
  "created_at, updated_at, archived_at";

export interface Task {
  id: number;
  board_id: number;
  title: string;
  body: string | null;
  assignee: string | null;
  status: "todo" | "ready" | "running" | "done" | "blocked" | "archived";
  priority: "low" | "medium" | "high";
  workspace_kind: "dir" | "worktree" | "scratch";
  branch: string | null;
  result: string | null;
  summary: string | null;
  block_reason: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface CreateTaskInput {
  board_id: number;
  title: string;
  body?: string;
  assignee?: string;
  priority?: "low" | "medium" | "high";
  workspace_kind?: "dir" | "worktree" | "scratch";
  branch?: string;
}

export interface ListTasksFilter {
  board_id: number;
  status?: Task["status"];
  assignee?: string;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const result = db.run(
    `INSERT INTO tasks (board_id, title, body, assignee, priority, workspace_kind, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.board_id,
      input.title,
      input.body ?? null,
      input.assignee ?? null,
      input.priority ?? "medium",
      input.workspace_kind ?? "worktree",
      input.branch ?? null,
    ]
  );

  return {
    id: Number(result.lastInsertRowid),
    board_id: input.board_id,
    title: input.title,
    body: input.body ?? null,
    assignee: input.assignee ?? null,
    status: "todo",
    priority: input.priority ?? "medium",
    workspace_kind: input.workspace_kind ?? "worktree",
    branch: input.branch ?? null,
    result: null,
    summary: null,
    block_reason: null,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
    archived_at: null,
  };
}

export function listTasks(filter: ListTasksFilter): Task[] {
  const db = getDb();
  const conditions = ["archived_at IS NULL"];
  const params: any[] = [];

  conditions.push("board_id = ?");
  params.push(filter.board_id);

  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  if (filter.assignee) {
    conditions.push("assignee = ?");
    params.push(filter.assignee);
  }

  const query = `
    SELECT ${TASK_COLUMNS}
    FROM tasks
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
  `;

  return db.query(query).all(...params) as Task[];
}

export function showTask(id: number): Task | null {
  const db = getDb();
  const task = db.query(
    `SELECT ${TASK_COLUMNS}
     FROM tasks
     WHERE id = ? AND archived_at IS NULL`
  ).get(id) as Task | undefined;

  return task ?? null;
}

export function editTask(id: number, body: string): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET body = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [body, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after update`);
  }
  return task;
}

export function promoteTask(id: number): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET status = 'ready', updated_at = unixepoch() WHERE id = ? AND status = 'todo' AND archived_at IS NULL`,
    [id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or not in 'todo' status`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after promotion`);
  }
  return task;
}

export function blockTask(id: number, reason: string): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [reason, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after blocking`);
  }
  return task;
}

export function unblockTask(id: number): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET status = 'todo', block_reason = NULL, updated_at = unixepoch() WHERE id = ? AND status = 'blocked' AND archived_at IS NULL`,
    [id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or not in 'blocked' status`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after unblocking`);
  }
  return task;
}

export function archiveTask(id: number): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET status = 'archived', updated_at = unixepoch(), archived_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = db.query(
    `SELECT ${TASK_COLUMNS}
     FROM tasks
     WHERE id = ?`
  ).get(id) as Task | undefined;

  if (!task) {
    throw new Error(`Task ${id} not found after archiving`);
  }
  return task;
}
