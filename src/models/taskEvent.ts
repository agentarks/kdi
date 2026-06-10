import { getDb } from "../db";

export interface TaskEvent {
  id: number;
  task_id: number;
  run_id: number | null;
  kind: string;
  payload: string | null;
  created_at: number;
}

export function addEvent(
  taskId: number,
  kind: string,
  payload?: Record<string, any>,
  runId?: number
): TaskEvent {
  const db = getDb();
  const payloadJson = payload ? JSON.stringify(payload) : null;
  const result = db.run(
    `INSERT INTO task_events (task_id, run_id, kind, payload) VALUES (?, ?, ?, ?)`,
    [taskId, runId ?? null, kind, payloadJson]
  );

  const event = db
    .query(
      `SELECT id, task_id, run_id, kind, payload, created_at FROM task_events WHERE id = ?`
    )
    .get(Number(result.lastInsertRowid)) as TaskEvent | undefined;

  if (!event) {
    throw new Error(`Event not found after insert`);
  }
  return event;
}

export function getEvents(taskId: number): TaskEvent[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, task_id, run_id, kind, payload, created_at FROM task_events WHERE task_id = ? ORDER BY created_at DESC`
    )
    .all(taskId) as TaskEvent[];
}

export function tailEvents(taskId: number, sinceId?: number): TaskEvent[] {
  const db = getDb();
  if (sinceId !== undefined) {
    return db
      .query(
        `SELECT id, task_id, run_id, kind, payload, created_at FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC`
      )
      .all(taskId, sinceId) as TaskEvent[];
  }
  return db
    .query(
      `SELECT id, task_id, run_id, kind, payload, created_at FROM task_events WHERE task_id = ? ORDER BY created_at DESC`
    )
    .all(taskId) as TaskEvent[];
}

export function getRecentEvents(limit = 50): TaskEvent[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, task_id, run_id, kind, payload, created_at FROM task_events ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as TaskEvent[];
}

export function getEventsAfter(sinceId: number): TaskEvent[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, task_id, run_id, kind, payload, created_at FROM task_events WHERE id > ? ORDER BY id ASC`
    )
    .all(sinceId) as TaskEvent[];
}
