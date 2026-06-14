import { getDb } from "../db";
import { getBoardById } from "./board";
import { addEvent } from "./taskEvent";
import { ensureTaskAttachmentDir, getStoredAttachmentPath } from "../attachments";
import { existsSync, statSync, copyFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";

export interface TaskAttachment {
  id: number;
  task_id: number;
  filename: string;
  stored_path: string;
  content_type: string | null;
  size: number;
  uploaded_by: string | null;
  created_at: number;
}

const FILENAME_PATTERN = /^[^/\\]+$/;

function validateFilename(filename: string): void {
  if (
    filename === "" ||
    filename === "." ||
    filename === ".." ||
    filename.includes("..") ||
    !FILENAME_PATTERN.test(filename)
  ) {
    throw new Error(`Invalid attachment filename: "${filename}"`);
  }
}

export function createAttachment(
  taskId: number,
  sourcePath: string,
  uploadedBy?: string
): TaskAttachment {
  const db = getDb();

  const task = db.query("SELECT board_id FROM tasks WHERE id = ?").get(taskId) as
    | { board_id: number }
    | undefined;
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const board = getBoardById(task.board_id);
  if (!board) {
    throw new Error(`Board not found for task ${taskId}`);
  }

  if (!existsSync(sourcePath)) {
    throw new Error(`File not found: ${sourcePath}`);
  }

  const stats = statSync(sourcePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${sourcePath}`);
  }

  const filename = basename(sourcePath);
  validateFilename(filename);

  const dir = ensureTaskAttachmentDir(board.slug, taskId);
  const storedPath = getStoredAttachmentPath(board.slug, taskId, filename);
  if (existsSync(storedPath)) {
    throw new Error(`Attachment "${filename}" already exists for task ${taskId}`);
  }

  copyFileSync(sourcePath, storedPath);

  try {
    const file = Bun.file(sourcePath);
    const contentType = file.type ? file.type.split(";")[0].trim() : null;
    const size = file.size;
    const uploader =
      uploadedBy?.trim() || process.env.KDI_PROFILE || process.env.USER || "unknown";

    const insertAndEvent = db.transaction(() => {
      const result = db.run(
        `INSERT INTO task_attachments (task_id, filename, stored_path, content_type, size, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [taskId, filename, storedPath, contentType, size, uploader]
      );

      const id = Number(result.lastInsertRowid);
      const attachment = db.query(
        `SELECT id, task_id, filename, stored_path, content_type, size, uploaded_by, created_at
         FROM task_attachments WHERE id = ?`
      ).get(id) as TaskAttachment | undefined;

      if (!attachment) {
        throw new Error("Attachment not found after insert");
      }

      addEvent(taskId, "attached", { filename, size, stored_path: storedPath });
      return attachment;
    });

    return insertAndEvent();
  } catch (err) {
    try {
      unlinkSync(storedPath);
    } catch {}
    throw err;
  }
}

export function listAttachments(taskId: number): TaskAttachment[] {
  const db = getDb();
  return db.query(
    `SELECT id, task_id, filename, stored_path, content_type, size, uploaded_by, created_at
     FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`
  ).all(taskId) as TaskAttachment[];
}

export function getAttachment(id: number): TaskAttachment | null {
  const db = getDb();
  const attachment = db.query(
    `SELECT id, task_id, filename, stored_path, content_type, size, uploaded_by, created_at
     FROM task_attachments WHERE id = ?`
  ).get(id) as TaskAttachment | undefined;
  return attachment ?? null;
}
