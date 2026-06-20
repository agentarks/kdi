import { getDb } from "../db";
import type { Task } from "./task";
import { TASK_COLUMNS } from "./task";

function hasDependencyPath(fromId: number, toId: number): boolean {
  const db = getDb();
  const visited = new Set<number>();
  const queue = [fromId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const rows = db.query(
      "SELECT child_id FROM dependencies WHERE parent_id = ?"
    ).all(current) as { child_id: number }[];

    for (const row of rows) {
      queue.push(row.child_id);
    }
  }

  return false;
}

export function addDependency(parentId: number, childId: number): void {
  if (parentId === childId) {
    throw new Error("Self-dependency is not allowed");
  }

  if (hasDependencyPath(childId, parentId)) {
    throw new Error("Circular dependency is not allowed");
  }

  const db = getDb();
  db.run(
    "INSERT INTO dependencies (parent_id, child_id) VALUES (?, ?)",
    [parentId, childId]
  );
}

export function removeDependency(parentId: number, childId: number): boolean {
  const db = getDb();
  const result = db.run(
    "DELETE FROM dependencies WHERE parent_id = ? AND child_id = ?",
    [parentId, childId]
  );
  return result.changes > 0;
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
