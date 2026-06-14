import { getDb } from "../db";

export const TASK_RUN_COLUMNS =
  "id, task_id, profile, step_key, status, claim_lock, claim_expires, " +
  "worker_pid, max_runtime_seconds, last_heartbeat_at, started_at, spawned_at, ended_at, " +
  "outcome, summary, metadata, error";

export interface TaskRun {
  id: number;
  task_id: number;
  profile: string | null;
  step_key: string | null;
  status: "running" | "done" | "blocked" | "crashed" | "timed_out" | "failed" | "released";
  claim_lock: string | null;
  claim_expires: number | null;
  worker_pid: number | null;
  max_runtime_seconds: number | null;
  last_heartbeat_at: number | null;
  started_at: number;
  spawned_at: number | null;
  ended_at: number | null;
  outcome: "completed" | "blocked" | "crashed" | "timed_out" | "spawn_failed" | "gave_up" | "reclaimed" | null;
  summary: string | null;
  metadata: string | null;
  error: string | null;
}

export interface CreateRunInput {
  task_id: number;
  profile?: string | null;
  status: TaskRun["status"];
  started_at: number;
  step_key?: string | null;
  claim_lock?: string | null;
  claim_expires?: number | null;
  worker_pid?: number | null;
  max_runtime_seconds?: number | null;
  spawned_at?: number | null;
}

export interface UpdateRunInput {
  status?: TaskRun["status"];
  claim_lock?: string | null;
  claim_expires?: number | null;
  worker_pid?: number | null;
  max_runtime_seconds?: number | null;
  last_heartbeat_at?: number | null;
  spawned_at?: number | null;
  step_key?: string | null;
}

export function createRun(input: CreateRunInput): TaskRun {
  const db = getDb();
  const result = db.run(
    `INSERT INTO task_runs (task_id, profile, status, started_at, spawned_at, step_key, claim_lock, claim_expires, worker_pid, max_runtime_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.task_id,
      input.profile ?? null,
      input.status,
      input.started_at,
      input.spawned_at ?? null,
      input.step_key ?? null,
      input.claim_lock ?? null,
      input.claim_expires ?? null,
      input.worker_pid ?? null,
      input.max_runtime_seconds ?? null,
    ]
  );

  const runId = Number(result.lastInsertRowid);

  // Update tasks.current_run_id pointer
  db.run(
    `UPDATE tasks SET current_run_id = ? WHERE id = ?`,
    [runId, input.task_id]
  );

  return {
    id: runId,
    task_id: input.task_id,
    profile: input.profile ?? null,
    step_key: input.step_key ?? null,
    status: input.status,
    claim_lock: input.claim_lock ?? null,
    claim_expires: input.claim_expires ?? null,
    worker_pid: input.worker_pid ?? null,
    max_runtime_seconds: input.max_runtime_seconds ?? null,
    last_heartbeat_at: null,
    started_at: input.started_at,
    spawned_at: input.spawned_at ?? null,
    ended_at: null,
    outcome: null,
    summary: null,
    metadata: null,
    error: null,
  };
}

export function getRuns(taskId: number): TaskRun[] {
  const db = getDb();
  return db.query(
    `SELECT ${TASK_RUN_COLUMNS}
     FROM task_runs
     WHERE task_id = ?
     ORDER BY started_at DESC`
  ).all(taskId) as TaskRun[];
}

export function getRun(id: number): TaskRun | null {
  const db = getDb();
  const run = db.query(
    `SELECT ${TASK_RUN_COLUMNS}
     FROM task_runs
     WHERE id = ?`
  ).get(id) as TaskRun | undefined;
  return run ?? null;
}

export function updateRun(id: number, updates: UpdateRunInput): TaskRun {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.claim_lock !== undefined) {
    fields.push("claim_lock = ?");
    values.push(updates.claim_lock);
  }
  if (updates.claim_expires !== undefined) {
    fields.push("claim_expires = ?");
    values.push(updates.claim_expires);
  }
  if (updates.worker_pid !== undefined) {
    fields.push("worker_pid = ?");
    values.push(updates.worker_pid);
  }
  if (updates.max_runtime_seconds !== undefined) {
    fields.push("max_runtime_seconds = ?");
    values.push(updates.max_runtime_seconds);
  }
  if (updates.last_heartbeat_at !== undefined) {
    fields.push("last_heartbeat_at = ?");
    values.push(updates.last_heartbeat_at);
  }
  if (updates.spawned_at !== undefined) {
    fields.push("spawned_at = ?");
    values.push(updates.spawned_at);
  }
  if (updates.step_key !== undefined) {
    fields.push("step_key = ?");
    values.push(updates.step_key);
  }

  if (fields.length === 0) {
    const existing = getRun(id);
    if (!existing) throw new Error(`Run ${id} not found`);
    return existing;
  }

  values.push(id);
  db.run(
    `UPDATE task_runs SET ${fields.join(", ")} WHERE id = ?`,
    values
  );

  const updated = getRun(id);
  if (!updated) throw new Error(`Run ${id} not found after update`);
  return updated;
}

function outcomeToStatus(outcome: NonNullable<TaskRun["outcome"]>): TaskRun["status"] {
  switch (outcome) {
    case "completed":
      return "done";
    case "blocked":
      return "blocked";
    case "crashed":
      return "crashed";
    case "timed_out":
      return "timed_out";
    case "spawn_failed":
    case "gave_up":
      return "failed";
    case "reclaimed":
      return "released";
  }
}

export function finishRun(
  id: number,
  outcome: TaskRun["outcome"],
  summary?: string | null,
  metadata?: string | null,
  error?: string | null,
  endedAt?: number | null
): TaskRun {
  const db = getDb();
  const now = endedAt ?? Math.floor(Date.now() / 1000);
  const status = outcome ? outcomeToStatus(outcome) : "done";

  db.run(
    `UPDATE task_runs
     SET status = ?, outcome = ?, summary = ?, metadata = ?, error = ?, ended_at = ?
     WHERE id = ?`,
    [status, outcome, summary ?? null, metadata ?? null, error ?? null, now, id]
  );

  // Clear tasks.current_run_id if this was the active run
  const run = getRun(id);
  if (!run) throw new Error(`Run ${id} not found after finish`);

  db.run(
    `UPDATE tasks SET current_run_id = NULL WHERE id = ? AND current_run_id = ?`,
    [run.task_id, id]
  );

  return run;
}
