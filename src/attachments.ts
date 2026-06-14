import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getBoardDataDir } from "./db";

export function getTaskAttachmentDir(boardSlug: string, taskId: number): string {
  return join(getBoardDataDir(boardSlug), "attachments", String(taskId));
}

export function ensureTaskAttachmentDir(boardSlug: string, taskId: number): string {
  const dir = getTaskAttachmentDir(boardSlug, taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getStoredAttachmentPath(boardSlug: string, taskId: number, filename: string): string {
  return join(getTaskAttachmentDir(boardSlug, taskId), filename);
}
