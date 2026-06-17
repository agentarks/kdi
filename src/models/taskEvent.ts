import { getDb } from "../db";

export type WatchFilters = {
  assignee?: string;
  tenant?: string;
  kinds?: string[];
};

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
  payload?: Record<string, unknown>,
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

function buildWatchClauses(filters?: WatchFilters): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters) {
    const needsJoin = !!(filters.assignee || filters.tenant);

    if (needsJoin) {
      // Use subquery to avoid polluting the SELECT columns with JOINed rows
      where.push("e.task_id IN (SELECT id FROM tasks t WHERE 1=1");
      if (filters.assignee) {
        where[where.length - 1] += " AND t.assignee = ?";
        params.push(filters.assignee);
      }
      if (filters.tenant) {
        where[where.length - 1] += " AND t.tenant = ?";
        params.push(filters.tenant);
      }
      where[where.length - 1] += ")";
    }

    if (filters.kinds && filters.kinds.length > 0) {
      const placeholders = filters.kinds.map(() => "?").join(", ");
      where.push(`e.kind IN (${placeholders})`);
      params.push(...filters.kinds);
    }
  }

  return { where, params };
}

export function getRecentEvents(limit = 50, filters?: WatchFilters): TaskEvent[] {
  const db = getDb();
  const { where, params } = buildWatchClauses(filters);

  let sql = "SELECT e.id, e.task_id, e.run_id, e.kind, e.payload, e.created_at FROM task_events e";
  if (where.length > 0) {
    sql += " WHERE " + where.join(" AND ");
  }
  sql += " ORDER BY e.id DESC LIMIT ?";
  params.push(limit);

  return db.query(sql).all(...params) as TaskEvent[];
}

export function getEventsAfter(sinceId: number, filters?: WatchFilters): TaskEvent[] {
  const db = getDb();
  const { where, params } = buildWatchClauses(filters);

  let sql = "SELECT e.id, e.task_id, e.run_id, e.kind, e.payload, e.created_at FROM task_events e WHERE e.id > ?";
  params.unshift(sinceId);
  if (where.length > 0) {
    sql += " AND " + where.join(" AND ");
  }
  sql += " ORDER BY e.id ASC";

  return db.query(sql).all(...params) as TaskEvent[];
}
