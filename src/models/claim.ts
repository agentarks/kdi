import { getDb } from "../db";
import { addEvent } from "./taskEvent";
import { createRun, finishRun } from "./taskRun";

const DEFAULT_CLAIM_TTL_SECONDS = 900; // 15 minutes

function getDefaultTTL(): number {
  const env = process.env.KDI_CLAIM_TTL_SECONDS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CLAIM_TTL_SECONDS;
}

export function atomicClaim(
  taskId: number,
  profile: string,
  ttlSeconds?: number
): { success: boolean; expiresAt?: number; runId?: number } {
  const db = getDb();
  const ttl = ttlSeconds ?? getDefaultTTL();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttl;

  // Read task-level max runtime before claiming so we can copy it to the run
  const taskRow = db.query(
    `SELECT max_runtime_seconds FROM tasks WHERE id = ? AND status = 'ready' AND archived_at IS NULL
     AND (claim_lock IS NULL OR claim_expires < unixepoch())
     AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())`
  ).get(taskId) as { max_runtime_seconds: number | null } | undefined;

  if (!taskRow) {
    return { success: false };
  }

  const result = db.run(
    `UPDATE tasks SET claim_lock = ?, claim_expires = ?, status = 'running', started_at = unixepoch(), updated_at = unixepoch(), rate_limited_until = NULL
     WHERE id = ? AND status = 'ready' AND archived_at IS NULL
     AND (claim_lock IS NULL OR claim_expires < unixepoch())
     AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())`,
    [profile, expiresAt, taskId]
  );

  if (result.changes === 0) {
    return { success: false };
  }

  const run = createRun({
    task_id: taskId,
    profile,
    status: "running",
    started_at: now,
    claim_lock: profile,
    claim_expires: expiresAt,
    max_runtime_seconds: taskRow.max_runtime_seconds,
  });

  addEvent(taskId, "claimed", { assignee: profile }, run.id);

  return { success: true, expiresAt, runId: run.id };
}

export function reclaimTask(taskId: number, reason?: string): boolean {
  const db = getDb();

  // Look up current_run_id before clearing the claim
  const task = db.query(
    `SELECT current_run_id FROM tasks WHERE id = ? AND status = 'running' AND claim_lock IS NOT NULL`
  ).get(taskId) as { current_run_id: number | null } | undefined;

  if (!task) {
    return false;
  }

  const runId = task.current_run_id;

  const result = db.run(
    `UPDATE tasks SET claim_lock = NULL, claim_expires = NULL, status = 'ready', started_at = NULL, updated_at = unixepoch(), rate_limited_until = NULL
     WHERE id = ? AND status = 'running' AND claim_lock IS NOT NULL`,
    [taskId]
  );

  if (result.changes === 0) {
    return false;
  }

  if (runId !== null) {
    finishRun(runId, "reclaimed", null, null, reason ?? "Reclaimed manually");
  }

  addEvent(taskId, "reclaimed", reason ? { reason } : {}, runId ?? undefined);

  return true;
}

export function isClaimExpired(taskId: number): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT claim_expires FROM tasks WHERE id = ?`
  ).get(taskId) as { claim_expires: number | null } | undefined;

  if (!row || row.claim_expires === null) {
    return true;
  }

  const now = Math.floor(Date.now() / 1000);
  return row.claim_expires < now;
}

const MAX_HEARTBEAT_NOTE_BYTES = 4096;

export function heartbeat(taskId: number, note?: string): boolean {
  const db = getDb();
  const result = db.run(
    `UPDATE tasks SET last_heartbeat_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [taskId]
  );

  if (result.changes === 0) {
    return false;
  }

  // Also update active task_run
  const task = db.query(
    `SELECT current_run_id FROM tasks WHERE id = ?`
  ).get(taskId) as { current_run_id: number | null } | undefined;

  if (task?.current_run_id) {
    db.run(
      `UPDATE task_runs SET last_heartbeat_at = unixepoch() WHERE id = ?`,
      [task.current_run_id]
    );
  }

  if (note !== undefined) {
    // Cap note payload at 4 KiB to avoid runaway storage
    const trimmedNote = note.length > MAX_HEARTBEAT_NOTE_BYTES
      ? note.slice(0, MAX_HEARTBEAT_NOTE_BYTES)
      : note;
    addEvent(taskId, "heartbeat", { note: trimmedNote });
  }

  return true;
}
