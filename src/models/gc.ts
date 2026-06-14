import { getDb, getBoardDataDir } from "../db";
import { showBoard, type Board } from "./board";
import { readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface GcOptions {
  eventRetentionDays?: number;
  logRetentionDays?: number;
}

export interface GcResult {
  board: string;
  deletedEvents: number;
  deletedLogs: number;
  cleanedWorkspaces: number;
}

function daysToCutoff(days: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds - days * 86400;
}

function deleteOldEvents(boardId: number, retentionDays: number): number {
  const db = getDb();
  const cutoff = daysToCutoff(retentionDays);
  const result = db.run(
    `DELETE FROM task_events
     WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)
       AND created_at < ?`,
    [boardId, cutoff]
  );
  return result.changes ?? 0;
}

function getLogDir(boardSlug: string): string {
  return join(process.env.HOME || tmpdir(), ".local", "share", "kdi", "logs", boardSlug);
}

function deleteOldLogs(boardSlug: string, retentionDays: number): number {
  const logDir = getLogDir(boardSlug);
  let deleted = 0;

  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return 0;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const fullPath = join(logDir, entry);
    try {
      const stats = statSync(fullPath);
      if (!stats.isFile()) continue;
      if (stats.mtimeMs < cutoffMs) {
        rmSync(fullPath);
        deleted++;
      }
    } catch {
      // Best effort: skip files we cannot stat or remove
    }
  }

  return deleted;
}

function isKdiOwnedWorkspace(board: Board, workspacePath: string): boolean {
  const resolvedWorkspace = resolve(workspacePath);
  const boardDataDir = resolve(getBoardDataDir(board.slug));
  const sysTmpdir = resolve(tmpdir());

  if (resolvedWorkspace === boardDataDir) {
    return false;
  }

  if (resolvedWorkspace.startsWith(boardDataDir + sep)) {
    return true;
  }

  if (resolvedWorkspace.startsWith(sysTmpdir + sep)) {
    const relative = resolvedWorkspace.slice(sysTmpdir.length + sep.length);
    return relative.startsWith("kdi-");
  }

  return false;
}

function cleanupArchivedTaskWorkspaces(board: Board): number {
  const db = getDb();
  const tasks = db.query(
    `SELECT id, workspace, workspace_kind FROM tasks
     WHERE board_id = ? AND status = 'archived' AND workspace IS NOT NULL`
  ).all(board.id) as { id: number; workspace: string; workspace_kind: string }[];

  let cleaned = 0;
  for (const task of tasks) {
    if (!isKdiOwnedWorkspace(board, task.workspace)) {
      continue;
    }

    try {
      const stats = statSync(task.workspace);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      // Path does not exist; clear the stale reference below
    }

    try {
      rmSync(task.workspace, { recursive: true, force: true });
      db.run("UPDATE tasks SET workspace = NULL WHERE id = ?", [task.id]);
      cleaned++;
    } catch {
      // Best effort: skip workspaces we cannot remove
    }
  }

  return cleaned;
}

export function runGarbageCollection(boardSlug: string, options: GcOptions): GcResult {
  const board = showBoard(boardSlug, false);
  if (!board) {
    throw new Error(`Board "${boardSlug}" not found or is archived.`);
  }

  let deletedEvents = 0;
  if (options.eventRetentionDays !== undefined && options.eventRetentionDays > 0) {
    deletedEvents = deleteOldEvents(board.id, options.eventRetentionDays);
  }

  let deletedLogs = 0;
  if (options.logRetentionDays !== undefined && options.logRetentionDays > 0) {
    deletedLogs = deleteOldLogs(boardSlug, options.logRetentionDays);
  }

  const cleanedWorkspaces = cleanupArchivedTaskWorkspaces(board);

  return {
    board: board.slug,
    deletedEvents,
    deletedLogs,
    cleanedWorkspaces,
  };
}
