import { getDb } from "../db";
import type { Task } from "./task";

const TASK_COLUMNS =
  "id, board_id, title, body, assignee, status, priority, " +
  "workspace_kind, branch, result, summary, block_reason, " +
  "created_at, updated_at, archived_at";

export function addDependency(parentId: number, childId: number): void {
  const db = getDb();
  db.run(
    "INSERT INTO dependencies (parent_id, child_id) VALUES (?, ?)",
    [parentId, childId]
  );
}

export function isBlockedByDependencies(taskId: number): boolean {
  const db = getDb();
  const result = db.query(
    `SELECT 1
     FROM dependencies d
     JOIN tasks t ON t.id = d.parent_id
     WHERE d.child_id = ? AND t.status != 'done' AND t.archived_at IS NULL`
  ).get(taskId);

  return result !== null;
}

export function getChildTasks(parentId: number): Task[] {
  const db = getDb();
  return db.query(
    `SELECT ${TASK_COLUMNS}
     FROM tasks t
     JOIN dependencies d ON d.child_id = t.id
     WHERE d.parent_id = ? AND t.archived_at IS NULL`
  ).all(parentId) as Task[];
}
