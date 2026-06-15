import { getDb } from "../db";

export interface Comment {
  id: number;
  task_id: number;
  text: string;
  author: string | null;
  created_at: number;
}

export interface AddCommentInput {
  task_id: number;
  text: string;
  author?: string;
  max_len?: number;
}

export function addComment(input: AddCommentInput): Comment {
  const db = getDb();

  let author = input.author ?? "user";
  if (author.trim() === "") {
    throw new Error("Author cannot be empty.");
  }

  let text = input.text;
  if (input.max_len !== undefined) {
    text = text.slice(0, input.max_len);
  }

  const result = db.run(
    "INSERT INTO comments (task_id, text, author) VALUES (?, ?, ?)",
    [input.task_id, text, author]
  );

  const comment = db.query(
    "SELECT id, task_id, text, author, created_at FROM comments WHERE id = ?"
  ).get(Number(result.lastInsertRowid)) as Comment | undefined;

  if (!comment) {
    throw new Error(`Comment not found after insert`);
  }

  return comment;
}

export function getComments(taskId: number): Comment[] {
  const db = getDb();
  return db.query(
    "SELECT id, task_id, text, author, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC"
  ).all(taskId) as Comment[];
}
