import { getDb } from "../db";
import { addEvent } from "./taskEvent";
import { createRun, finishRun } from "./taskRun";

export const TASK_COLUMNS =
  "id, board_id, title, body, assignee, status, priority, " +
  "workspace_kind, branch, result, summary, block_reason, schedule_reason, review_reason, " +
  "created_by, created_at, updated_at, started_at, archived_at, current_run_id, " +
  "claim_lock, claim_expires, last_heartbeat_at, idempotency_key, scheduled_at";

export interface Task {
  id: number;
  board_id: number;
  title: string;
  body: string | null;
  assignee: string | null;
  status: "triage" | "todo" | "scheduled" | "ready" | "running" | "done" | "blocked" | "review" | "archived";
  priority: number;
  workspace_kind: "dir" | "worktree" | "scratch";
  branch: string | null;
  result: string | null;
  summary: string | null;
  block_reason: string | null;
  schedule_reason: string | null;
  review_reason: string | null;
  scheduled_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  archived_at: number | null;
  current_run_id: number | null;
  claim_lock: string | null;
  claim_expires: number | null;
  last_heartbeat_at: number | null;
  idempotency_key: string | null;
}

export type InitialTaskStatus = Exclude<Task["status"], "archived">;

export interface CreateTaskInput {
  board_id: number;
  title: string;
  body?: string;
  assignee?: string;
  priority?: number;
  workspace_kind?: "dir" | "worktree" | "scratch";
  branch?: string;
  triage?: boolean;
  initialStatus?: InitialTaskStatus;
  idempotency_key?: string;
  scheduled_at?: number;
  created_by?: string;
}

export interface CompleteTaskInput {
  result?: string;
  summary?: string;
  metadata?: string;
}

export interface ListTasksFilter {
  board_id: number;
  status?: Task["status"];
  assignee?: string;
  created_by?: string;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();

  if (input.idempotency_key) {
    const existing = db.query(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? AND idempotency_key = ? AND archived_at IS NULL`
    ).get(input.board_id, input.idempotency_key) as Task | undefined;
    if (existing) {
      return existing;
    }
  }

  let status: Task["status"];
  if (input.initialStatus) {
    status = input.initialStatus;
  } else if (input.triage) {
    status = "triage";
  } else {
    status = "todo";
  }

  if (status === "scheduled" && input.scheduled_at === undefined) {
    throw new Error("initial status 'scheduled' requires scheduled_at to be set");
  }

  const createdBy = input.created_by ?? "unknown";
  if (createdBy.trim() === "") {
    throw new Error("created_by cannot be empty.");
  }
  if (createdBy.length > 255) {
    throw new Error("created_by must be 255 characters or fewer.");
  }

  const insert = db.transaction(() => {
    const result = db.run(
      `INSERT INTO tasks (board_id, title, body, assignee, status, priority, workspace_kind, branch, idempotency_key, scheduled_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.board_id,
        input.title,
        input.body ?? null,
        input.assignee ?? null,
        status,
        input.priority ?? 0,
        input.workspace_kind ?? "worktree",
        input.branch ?? null,
        input.idempotency_key ?? null,
        input.scheduled_at ?? null,
        input.created_by ?? "unknown",
      ]
    );
    return Number(result.lastInsertRowid);
  });

  let id: number;
  try {
    id = insert();
  } catch (err: any) {
    // Race: another insert won the unique index on (board_id, idempotency_key)
    if (input.idempotency_key && /UNIQUE constraint failed/i.test(err.message)) {
      const existing = db.query(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? AND idempotency_key = ? AND archived_at IS NULL`
      ).get(input.board_id, input.idempotency_key) as Task | undefined;
      if (existing) {
        return existing;
      }
    }
    throw err;
  }

  const task = {
    id,
    board_id: input.board_id,
    title: input.title,
    body: input.body ?? null,
    assignee: input.assignee ?? null,
    status,
    priority: input.priority ?? 0,
    workspace_kind: input.workspace_kind ?? "worktree",
    branch: input.branch ?? null,
    result: null,
    summary: null,
    block_reason: null,
    schedule_reason: null,
    review_reason: null,
    scheduled_at: input.scheduled_at ?? null,
    created_by: createdBy,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
    started_at: null,
    archived_at: null,
    current_run_id: null,
    claim_lock: null,
    claim_expires: null,
    last_heartbeat_at: null,
    idempotency_key: input.idempotency_key ?? null,
  };
  addEvent(task.id, "created");
  return task;
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

  if (filter.created_by) {
    conditions.push("created_by = ?");
    params.push(filter.created_by);
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
  addEvent(task.id, "promoted");
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
  addEvent(task.id, "blocked", { reason });
  return task;
}

export function unblockTask(id: number, reason?: string): Task {
  const db = getDb();
  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found`);
  }
  if (task.status !== "blocked" && task.status !== "scheduled") {
    throw new Error(`Task ${id} is not in 'blocked' or 'scheduled' status`);
  }

  if (reason) {
    db.run(
      `INSERT INTO comments (task_id, text, created_at) VALUES (?, ?, unixepoch())`,
      [id, reason]
    );
  }

  const targetStatus = task.status === "scheduled" ? "ready" : "todo";
  const result = db.run(
    `UPDATE tasks SET status = ?, block_reason = NULL, schedule_reason = NULL, scheduled_at = NULL, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [targetStatus, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const updated = showTask(id);
  if (!updated) {
    throw new Error(`Task ${id} not found after unblocking`);
  }

  if (task.status === "scheduled") {
    addEvent(updated.id, "ready", { reason, source: "unblock" });
  } else {
    addEvent(updated.id, "unblocked", { reason });
  }
  return updated;
}

export function scheduleTask(id: number, scheduledAt: number, reason?: string): Task {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  if (scheduledAt <= now) {
    throw new Error("Scheduled time must be in the future");
  }

  const result = db.run(
    `UPDATE tasks SET status = 'scheduled', scheduled_at = ?, schedule_reason = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [scheduledAt, reason ?? null, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after scheduling`);
  }
  addEvent(task.id, "scheduled", { at: scheduledAt, reason });
  return task;
}

export function promoteScheduledTasks(now: number): number {
  const db = getDb();
  const tasks = db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE status = 'scheduled' AND scheduled_at <= ? AND archived_at IS NULL ORDER BY scheduled_at ASC`
  ).all(now) as Task[];

  for (const task of tasks) {
    db.run(
      `UPDATE tasks SET status = 'ready', scheduled_at = NULL, schedule_reason = NULL, updated_at = unixepoch() WHERE id = ?`,
      [task.id]
    );
    addEvent(task.id, "ready", { source: "scheduled", at: task.scheduled_at });
  }

  return tasks.length;
}

export function reviewTask(id: number, reason?: string): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET status = 'review', review_reason = ?, claim_lock = NULL, claim_expires = NULL, current_run_id = NULL, started_at = NULL, updated_at = unixepoch() WHERE id = ? AND status != 'review' AND status != 'archived' AND archived_at IS NULL`,
    [reason ?? null, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found, already in review, or archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after marking for review`);
  }
  addEvent(task.id, "reviewed", reason ? { reason } : {});
  return task;
}

export function completeTask(id: number, input: CompleteTaskInput = {}): Task {
  const db = getDb();
  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found or already archived`);
  }
  if (task.status === "archived") {
    throw new Error(`Task ${id} is archived and cannot be completed`);
  }

  db.run(
    `UPDATE tasks SET status = 'done', result = ?, summary = ?, block_reason = NULL, schedule_reason = NULL, scheduled_at = NULL, claim_lock = NULL, claim_expires = NULL, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [input.result ?? null, input.summary ?? null, id]
  );

  let runId: number | null = task.current_run_id;
  const now = Math.floor(Date.now() / 1000);

  if (runId !== null) {
    finishRun(runId, "completed", input.summary ?? null, input.metadata ?? null, null, now);
  } else {
    const run = createRun({
      task_id: id,
      profile: task.assignee,
      status: "running",
      started_at: now,
    });
    runId = run.id;
    finishRun(runId, "completed", input.summary ?? null, input.metadata ?? null, null, now);
  }

  const updated = showTask(id);
  if (!updated) {
    throw new Error(`Task ${id} not found after completion`);
  }
  let eventPayload: Record<string, any> | undefined;
  if (input.metadata) {
    try {
      eventPayload = { metadata: JSON.parse(input.metadata) };
    } catch {
      eventPayload = { metadata: input.metadata };
    }
  }
  addEvent(updated.id, "completed", eventPayload, runId ?? undefined);
  return updated;
}

export function specifyTask(id: number): Task {
  const db = getDb();
  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found`);
  }
  if (task.status !== "triage") {
    throw new Error(`Task ${id} is not in triage status`);
  }
  if (!task.body || task.body.trim() === "") {
    throw new Error("Triage task needs a body before promotion");
  }

  const result = db.run(
    `UPDATE tasks SET status = 'todo', updated_at = unixepoch() WHERE id = ? AND status = 'triage' AND archived_at IS NULL`,
    [id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or not in 'triage' status`);
  }

  const updated = showTask(id);
  if (!updated) {
    throw new Error(`Task ${id} not found after specification`);
  }
  addEvent(updated.id, "specified");
  return updated;
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
  addEvent(task.id, "archived");
  return task;
}
