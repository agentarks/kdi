import { getDb, getBoardDataDir } from "../db";
import { existsSync, renameSync, rmSync } from "node:fs";
import { assertValidBoardSlug } from "../slugs";

export interface Board {
  id: number;
  slug: string;
  workdir: string;
  default_workdir: string | null;
  base_ref: string;
  name: string;
  icon: string | null;
  color: string | null;
  description: string | null;
  created_at: number;
  archived_at: number | null;
}

export interface BoardMetadata {
  name?: string;
  icon?: string;
  color?: string;
  description?: string;
}

export interface BoardWithTaskCounts extends Board {
  taskCounts: {
    triage: number;
    todo: number;
    ready: number;
    running: number;
    done: number;
    blocked: number;
    review: number;
    scheduled: number;
    archived: number;
  };
}

const BOARD_COLUMNS = "id, slug, workdir, default_workdir, base_ref, name, icon, color, description, created_at, archived_at";

function validateMetadataField(value: string | undefined, field: string): void {
  if (value !== undefined && value.trim() === "") {
    throw new Error(`${field} cannot be empty.`);
  }
}

export function createBoard(
  slug: string,
  workdir: string,
  baseRef: string = "origin/main",
  metadata: BoardMetadata = {}
): Board {
  assertValidBoardSlug(slug);
  validateMetadataField(metadata.name, "Name");
  validateMetadataField(metadata.icon, "Icon");
  validateMetadataField(metadata.color, "Color");
  validateMetadataField(metadata.description, "Description");

  const name = metadata.name?.trim() ?? slug;
  const icon = metadata.icon?.trim() ?? null;
  const color = metadata.color?.trim() ?? null;
  const description = metadata.description?.trim() ?? null;

  const db = getDb();
  try {
    const result = db.run(
      "INSERT INTO boards (slug, workdir, base_ref, name, icon, color, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [slug, workdir, baseRef, name, icon, color, description]
    );
    return {
      id: Number(result.lastInsertRowid),
      slug,
      workdir,
      default_workdir: null,
      base_ref: baseRef,
      name,
      icon,
      color,
      description,
      created_at: Math.floor(Date.now() / 1000),
      archived_at: null,
    };
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      throw new Error(`Board with slug "${slug}" already exists`);
    }
    throw err;
  }
}

export function listBoards(includeArchived: boolean = false): Board[] {
  const db = getDb();
  const whereClause = includeArchived ? "" : "WHERE archived_at IS NULL";
  return db.query(
    `SELECT ${BOARD_COLUMNS} FROM boards ${whereClause} ORDER BY created_at DESC`
  ).all() as Board[];
}

export function showBoard(slug: string, includeArchived: boolean = false): BoardWithTaskCounts | null {
  const db = getDb();
  const archivedClause = includeArchived ? "" : "AND archived_at IS NULL";
  const board = db.query(
    `SELECT ${BOARD_COLUMNS} FROM boards WHERE slug = ? ${archivedClause}`
  ).get(slug) as Board | undefined;

  if (!board) return null;

  const counts = db.query(
    `SELECT 
      SUM(CASE WHEN status = 'triage' AND archived_at IS NULL THEN 1 ELSE 0 END) as triage,
      SUM(CASE WHEN status = 'todo' AND archived_at IS NULL THEN 1 ELSE 0 END) as todo,
      SUM(CASE WHEN status = 'ready' AND archived_at IS NULL THEN 1 ELSE 0 END) as ready,
      SUM(CASE WHEN status = 'running' AND archived_at IS NULL THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status = 'done' AND archived_at IS NULL THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'blocked' AND archived_at IS NULL THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN status = 'review' AND archived_at IS NULL THEN 1 ELSE 0 END) as review,
      SUM(CASE WHEN status = 'scheduled' AND archived_at IS NULL THEN 1 ELSE 0 END) as scheduled,
      SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) as archived
    FROM tasks 
    WHERE board_id = ?`
  ).get(board.id) as {
    triage: number | null;
    todo: number | null;
    ready: number | null;
    running: number | null;
    done: number | null;
    blocked: number | null;
    review: number | null;
    scheduled: number | null;
    archived: number | null;
  };

  return {
    ...board,
    taskCounts: {
      triage: counts.triage ?? 0,
      todo: counts.todo ?? 0,
      ready: counts.ready ?? 0,
      running: counts.running ?? 0,
      done: counts.done ?? 0,
      blocked: counts.blocked ?? 0,
      review: counts.review ?? 0,
      scheduled: counts.scheduled ?? 0,
      archived: counts.archived ?? 0,
    },
  };
}

export function getBoardById(id: number): Board | null {
  const db = getDb();
  const board = db.query(
    `SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ?`
  ).get(id) as Board | undefined;
  return board ?? null;
}

export function setDefaultWorkdir(slug: string, workdir: string | null): Board {
  assertValidBoardSlug(slug);

  const normalizedWorkdir = workdir === null ? null : workdir.trim();
  if (normalizedWorkdir !== null && normalizedWorkdir === "") {
    throw new Error("Default workdir cannot be empty. Omit the path to clear it.");
  }

  const db = getDb();
  const result = db.run(
    "UPDATE boards SET default_workdir = ? WHERE slug = ? AND archived_at IS NULL",
    [normalizedWorkdir, slug]
  );
  if (result.changes === 0) {
    throw new Error(`Board "${slug}" not found or is archived.`);
  }

  const updated = showBoard(slug, false);
  if (!updated) {
    throw new Error(`Board "${slug}" not found.`);
  }
  return updated;
}

export function updateBoardMetadata(slug: string, metadata: BoardMetadata): Board {
  validateMetadataField(metadata.name, "Name");
  validateMetadataField(metadata.icon, "Icon");
  validateMetadataField(metadata.color, "Color");
  validateMetadataField(metadata.description, "Description");

  const db = getDb();
  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (metadata.name !== undefined) {
    sets.push("name = ?");
    values.push(metadata.name.trim());
  }
  if (metadata.icon !== undefined) {
    sets.push("icon = ?");
    values.push(metadata.icon.trim() || null);
  }
  if (metadata.color !== undefined) {
    sets.push("color = ?");
    values.push(metadata.color.trim() || null);
  }
  if (metadata.description !== undefined) {
    sets.push("description = ?");
    values.push(metadata.description.trim() || null);
  }

  if (sets.length === 0) {
    throw new Error("At least one metadata field is required.");
  }

  const result = db.run(
    `UPDATE boards SET ${sets.join(", ")} WHERE slug = ? AND archived_at IS NULL`,
    [...values, slug]
  );
  if (result.changes === 0) {
    throw new Error(`Board "${slug}" not found or is archived.`);
  }

  const updated = showBoard(slug, false);
  if (!updated) {
    throw new Error(`Board "${slug}" not found.`);
  }
  return updated;
}

export function archiveBoard(slug: string): void {
  const db = getDb();
  const result = db.run(
    "UPDATE boards SET archived_at = unixepoch() WHERE slug = ? AND archived_at IS NULL",
    [slug]
  );
  if (result.changes === 0) {
    throw new Error(`Board "${slug}" not found or already archived`);
  }
}

export interface RenameBoardResult {
  board: Board;
  dirRenamed: boolean;
}

export interface BoardStats {
  board: string;
  status_counts: {
    triage: number;
    todo: number;
    scheduled: number;
    ready: number;
    running: number;
    done: number;
    blocked: number;
    review: number;
  };
  assignee_counts: Record<string, number>;
  oldest_ready_age_seconds: number | null;
}

export function renameBoard(oldSlug: string, newSlug: string): RenameBoardResult {
  assertValidBoardSlug(oldSlug, "old board slug");
  assertValidBoardSlug(newSlug, "new board slug");

  if (oldSlug === newSlug) {
    throw new Error("New slug must differ from the current slug.");
  }

  // Check new slug is not taken by any board (archived or not)
  const existing = showBoard(newSlug, true);
  if (existing) {
    throw new Error(`Board with slug "${newSlug}" already exists.`);
  }

  // Check old board exists and is not archived
  const board = showBoard(oldSlug, false);
  if (!board) {
    throw new Error(`Board "${oldSlug}" not found or is archived.`);
  }

  const db = getDb();
  db.run("UPDATE boards SET slug = ? WHERE slug = ? AND archived_at IS NULL", [newSlug, oldSlug]);

  // Rename board data directory if it exists
  const oldDir = getBoardDataDir(oldSlug);
  const newDir = getBoardDataDir(newSlug);
  let dirRenamed = false;
  if (existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      dirRenamed = true;
    } catch (fsErr: any) {
      console.error(`Warning: failed to rename board data directory: ${fsErr.message}`);
    }
  } else {
    console.error(`Warning: board data directory "${oldDir}" not found; skipped directory rename.`);
  }

  const updated = showBoard(newSlug, false);
  if (!updated) {
    throw new Error(`Board "${newSlug}" not found after rename.`);
  }

  return { board: updated, dirRenamed };
}

export function getBoardStats(slug: string): BoardStats {
  const board = showBoard(slug, false);
  if (!board) {
    throw new Error(`Board "${slug}" not found or is archived.`);
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const statusCounts: BoardStats["status_counts"] = {
    triage: 0,
    todo: 0,
    scheduled: 0,
    ready: 0,
    running: 0,
    done: 0,
    blocked: 0,
    review: 0,
  };

  const statusRows = db.query(
    `SELECT status, COUNT(*) AS count
     FROM tasks
     WHERE board_id = ? AND archived_at IS NULL
     GROUP BY status`
  ).all(board.id) as { status: string; count: number }[];

  for (const row of statusRows) {
    if (row.status in statusCounts) {
      statusCounts[row.status as keyof BoardStats["status_counts"]] = Number(row.count);
    }
  }

  const assigneeRows = db.query(
    `SELECT assignee, COUNT(*) AS count
     FROM tasks
     WHERE board_id = ? AND archived_at IS NULL
       AND status IN ('ready', 'running')
       AND assignee IS NOT NULL
     GROUP BY assignee`
  ).all(board.id) as { assignee: string; count: number }[];

  const assigneeCounts: Record<string, number> = {};
  for (const row of assigneeRows) {
    assigneeCounts[row.assignee] = Number(row.count);
  }

  const oldestReady = db.query(
    `SELECT created_at FROM tasks
     WHERE board_id = ? AND archived_at IS NULL AND status = 'ready'
     ORDER BY created_at ASC LIMIT 1`
  ).get(board.id) as { created_at: number } | undefined;

  const oldestReadyAgeSeconds = oldestReady ? now - oldestReady.created_at : null;

  return {
    board: board.slug,
    status_counts: statusCounts,
    assignee_counts: assigneeCounts,
    oldest_ready_age_seconds: oldestReadyAgeSeconds,
  };
}

export function removeBoard(slug: string, hardDelete: boolean): void {
  if (!hardDelete) {
    archiveBoard(slug);
    return;
  }

  const db = getDb();
  const board = db.query(
    "SELECT id FROM boards WHERE slug = ?"
  ).get(slug) as { id: number } | undefined;
  if (!board) {
    throw new Error(`Board "${slug}" not found`);
  }

  const remove = db.transaction(() => {
    // Cascade-delete all task-related data for this board.
    db.run("DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)", [board.id]);
    db.run("DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)", [board.id]);
    db.run("DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)", [board.id]);
    db.run("DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)", [board.id]);
    db.run("DELETE FROM dependencies WHERE parent_id IN (SELECT id FROM tasks WHERE board_id = ?) OR child_id IN (SELECT id FROM tasks WHERE board_id = ?)", [board.id, board.id]);
    db.run("DELETE FROM workflow_templates WHERE board_id = ?", [board.id]);
    db.run("DELETE FROM tasks WHERE board_id = ?", [board.id]);

    const boardDir = getBoardDataDir(slug);
    rmSync(boardDir, { recursive: true, force: true });

    db.run("DELETE FROM boards WHERE slug = ?", [slug]);
  });

  remove();
}
