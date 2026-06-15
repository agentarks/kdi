import { getDb } from "../db";
import { addEvent } from "./taskEvent";
import { createRun, finishRun } from "./taskRun";
import { reclaimTask } from "./claim";

export const TASK_COLUMNS =
  "id, board_id, title, body, assignee, status, priority, tenant, " +
  "workspace_kind, workspace, branch, result, summary, block_reason, schedule_reason, review_reason, " +
  "created_by, created_at, updated_at, started_at, archived_at, current_run_id, " +
  "claim_lock, claim_expires, last_heartbeat_at, max_runtime_seconds, max_retries, consecutive_failures, idempotency_key, model_override, rate_limited_until, scheduled_at, skills, " +
  "session_id, workflow_template_id, current_step_key";

export interface Task {
  id: number;
  board_id: number;
  title: string;
  body: string | null;
  assignee: string | null;
  status: "triage" | "todo" | "scheduled" | "ready" | "running" | "done" | "blocked" | "review" | "archived";
  priority: number;
  tenant: string | null;
  workspace_kind: "dir" | "worktree" | "scratch";
  workspace: string | null;
  branch: string | null;
  result: string | null;
  summary: string | null;
  block_reason: string | null;
  schedule_reason: string | null;
  review_reason: string | null;
  scheduled_at: number | null;
  created_by: string;
  skills: string[];
  created_at: number;
  updated_at: number;
  started_at: number | null;
  archived_at: number | null;
  current_run_id: number | null;
  claim_lock: string | null;
  claim_expires: number | null;
  last_heartbeat_at: number | null;
  max_runtime_seconds: number | null;
  max_retries: number | null;
  consecutive_failures: number;
  idempotency_key: string | null;
  model_override: string | null;
  rate_limited_until: number | null;
  session_id: string | null;
  workflow_template_id: string | null;
  current_step_key: string | null;
}

export type InitialTaskStatus = Exclude<Task["status"], "archived">;

export interface CreateTaskInput {
  board_id: number;
  title: string;
  body?: string;
  assignee?: string;
  priority?: number;
  workspace_kind?: "dir" | "worktree" | "scratch";
  workspace?: string;
  branch?: string;
  tenant?: string;
  triage?: boolean;
  initialStatus?: InitialTaskStatus;
  idempotency_key?: string;
  scheduled_at?: number;
  max_runtime_seconds?: number;
  max_retries?: number;
  skills?: string[];
  created_by?: string;
  model_override?: string;
  session_id?: string;
  workflow_template_id?: string;
  current_step_key?: string;
}

export interface CompleteTaskInput {
  result?: string;
  summary?: string;
  metadata?: string;
}

export interface ReassignOptions {
  reclaim?: boolean;
  reason?: string;
}

export const VALID_SORT_KEYS = ["assignee", "created", "created-desc", "priority", "priority-desc", "status", "title", "updated"] as const;
export type SortKey = typeof VALID_SORT_KEYS[number];

export interface ListTasksFilter {
  board_id: number;
  status?: Task["status"];
  assignee?: string;
  tenant?: string;
  created_by?: string;
  includeArchived?: boolean;
  session_id?: string;
  workflow_template_id?: string;
  current_step_key?: string;
}

export function parseDuration(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("Duration cannot be empty");
  }

  const numeric = Number(trimmed);
  if (!isNaN(numeric) && trimmed === String(numeric)) {
    if (!Number.isInteger(numeric) || numeric <= 0) {
      throw new Error(`Duration must be a positive integer seconds value, got "${value}"`);
    }
    return numeric;
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use seconds (e.g. 300) or a suffix like 30m, 1h, 2d.`);
  }

  const amount = parseFloat(match[1]);
  if (amount <= 0 || !Number.isFinite(amount)) {
    throw new Error(`Duration must be positive, got "${value}"`);
  }

  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "s" ? 1 :
    unit === "m" ? 60 :
    unit === "h" ? 3600 :
    /* d */ 86400;

  const seconds = amount * multiplier;
  if (!Number.isInteger(seconds)) {
    throw new Error(`Duration "${value}" must resolve to a whole number of seconds`);
  }
  return seconds;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();

  if (input.idempotency_key) {
    const existing = db.query(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? AND idempotency_key = ? AND archived_at IS NULL`
    ).get(input.board_id, input.idempotency_key) as Task | undefined;
    if (existing) {
      return hydrateTask(existing);
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

  const workspace = input.workspace?.trim();
  if (workspace !== undefined && workspace === "") {
    throw new Error("workspace cannot be empty.");
  }

  const skillsJson = input.skills && input.skills.length > 0 ? JSON.stringify(input.skills) : null;

  const insert = db.transaction(() => {
    const result = db.run(
      `INSERT INTO tasks (board_id, title, body, assignee, status, priority, tenant, workspace_kind, workspace, branch, idempotency_key, scheduled_at, created_by, max_runtime_seconds, max_retries, skills, model_override, session_id, workflow_template_id, current_step_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.board_id,
        input.title,
        input.body ?? null,
        input.assignee ?? null,
        status,
        input.priority ?? 0,
        input.tenant ?? null,
        input.workspace_kind ?? "worktree",
        workspace ?? null,
        input.branch ?? null,
        input.idempotency_key ?? null,
        input.scheduled_at ?? null,
        createdBy,
        input.max_runtime_seconds ?? null,
        input.max_retries ?? null,
        skillsJson,
        input.model_override ?? null,
        input.session_id ?? null,
        input.workflow_template_id ?? null,
        input.current_step_key ?? null,
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
        return hydrateTask(existing);
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
    tenant: input.tenant ?? null,
    workspace_kind: input.workspace_kind ?? "worktree",
    workspace: workspace ?? null,
    branch: input.branch ?? null,
    result: null,
    summary: null,
    block_reason: null,
    schedule_reason: null,
    review_reason: null,
    scheduled_at: input.scheduled_at ?? null,
    created_by: createdBy,
    skills: input.skills ?? [],
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
    started_at: null,
    archived_at: null,
    current_run_id: null,
    claim_lock: null,
    claim_expires: null,
    last_heartbeat_at: null,
    max_runtime_seconds: input.max_runtime_seconds ?? null,
    max_retries: input.max_retries ?? null,
    consecutive_failures: 0,
    idempotency_key: input.idempotency_key ?? null,
    model_override: input.model_override ?? null,
    rate_limited_until: null,
    session_id: input.session_id ?? null,
    workflow_template_id: input.workflow_template_id ?? null,
    current_step_key: input.current_step_key ?? null,
  };
  addEvent(task.id, "created");
  return task;
}

export function listTasks(filter: ListTasksFilter, sort?: string): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  conditions.push("board_id = ?");
  params.push(filter.board_id);

  if (!filter.includeArchived) {
    conditions.push("archived_at IS NULL");
  }

  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  if (filter.assignee) {
    conditions.push("assignee = ?");
    params.push(filter.assignee);
  }

  if (filter.tenant) {
    conditions.push("tenant = ?");
    params.push(filter.tenant);
  }

  if (filter.created_by) {
    conditions.push("created_by = ?");
    params.push(filter.created_by);
  }

  if (filter.session_id) {
    conditions.push("session_id = ?");
    params.push(filter.session_id);
  }

  if (filter.workflow_template_id) {
    conditions.push("workflow_template_id = ?");
    params.push(filter.workflow_template_id);
  }

  if (filter.current_step_key) {
    conditions.push("current_step_key = ?");
    params.push(filter.current_step_key);
  }

  const orderBy = sort ? resolveSortOrder(sort) : "ORDER BY created_at DESC, id DESC";

  const query = `
    SELECT ${TASK_COLUMNS}
    FROM tasks
    WHERE ${conditions.join(" AND ")}
    ${orderBy}
  `;

  const tasks = db.query(query).all(...params) as Task[];
  return tasks.map(hydrateTask);
}

function resolveSortOrder(sort: string): string {
  switch (sort) {
    case "assignee":
      return "ORDER BY assignee ASC NULLS LAST, id ASC";
    case "created":
      return "ORDER BY created_at ASC, id ASC";
    case "created-desc":
      return "ORDER BY created_at DESC, id DESC";
    case "priority":
    case "priority-desc":
      return "ORDER BY priority DESC, created_at ASC";
    case "status":
      return "ORDER BY status ASC, id ASC";
    case "title":
      return "ORDER BY title COLLATE NOCASE ASC, id ASC";
    case "updated":
      return "ORDER BY updated_at DESC, id DESC";
    default:
      throw new Error(`Invalid sort key "${sort}". Valid: ${VALID_SORT_KEYS.join(", ")}`);
  }
}

export function getAssigneeCounts(boardId: number): Record<string, number> {
  const db = getDb();
  const rows = db.query(
    `SELECT assignee, COUNT(*) as count
     FROM tasks
     WHERE board_id = ? AND assignee IS NOT NULL AND archived_at IS NULL
     GROUP BY assignee`
  ).all(boardId) as { assignee: string; count: number }[];

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.assignee] = row.count;
  }
  return counts;
}

export function showTask(id: number): Task | null {
  const db = getDb();
  const task = db.query(
    `SELECT ${TASK_COLUMNS}
     FROM tasks
     WHERE id = ? AND archived_at IS NULL`
  ).get(id) as Task | undefined;

  return task ? hydrateTask(task) : null;
}

function parseSkills(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as string[];
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // fall through
  }
  return [];
}

export function hydrateTask(raw: unknown): Task {
  const task = raw as Task;
  task.skills = parseSkills(task.skills);
  task.consecutive_failures = Number(task.consecutive_failures ?? 0);
  task.max_retries = task.max_retries === null || task.max_retries === undefined ? null : Number(task.max_retries);
  task.rate_limited_until = task.rate_limited_until === null || task.rate_limited_until === undefined ? null : Number(task.rate_limited_until);
  return task;
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
    `UPDATE tasks SET status = ?, block_reason = NULL, schedule_reason = NULL, scheduled_at = NULL, rate_limited_until = NULL, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
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

  for (const raw of tasks) {
    const task = hydrateTask(raw);
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

export function assignTask(id: number, profile: string): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET assignee = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [profile, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after assignment`);
  }
  addEvent(task.id, "assigned", { assignee: profile });
  return task;
}

export function unassignTask(id: number): Task {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET assignee = NULL, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after unassignment`);
  }
  addEvent(task.id, "unassigned");
  return task;
}

export function reassignTask(id: number, profile: string | null, options: ReassignOptions = {}): Task {
  const db = getDb();

  const reassign = db.transaction(() => {
    const task = showTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found or already archived`);
    }

    if (task.status === "running" && options.reclaim) {
      reclaimTask(id, options.reason);
    }

    if (profile === null) {
      return unassignTask(id);
    }
    return assignTask(id, profile);
  });

  return reassign();
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
  const hydrated = hydrateTask(task);
  addEvent(hydrated.id, "archived");
  return hydrated;
}
