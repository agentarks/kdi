import { getDb } from "../db";

export interface Comment {
  id: number;
  task_id: number;
  text: string;
  created_at: number;
}

export function addComment(taskId: number, text: string): Comment {
  const db = getDb();
  const result = db.run(
    "INSERT INTO comments (task_id, text) VALUES (?, ?)",
    [taskId, text]
  );

  const comment = db.query(
    "SELECT id, task_id, text, created_at FROM comments WHERE id = ?"
  ).get(Number(result.lastInsertRowid)) as Comment | undefined;

  if (!comment) {
    throw new Error(`Comment not found after insert`);
  }

  return comment;
}

export function getComments(taskId: number): Comment[] {
  const db = getDb();
  return db.query(
    "SELECT id, task_id, text, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId) as Comment[];
}
