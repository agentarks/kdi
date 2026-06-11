import { getDb } from "../db";

export interface Board {
  id: number;
  slug: string;
  workdir: string;
  base_ref: string;
  created_at: number;
  archived_at: number | null;
}

export interface BoardWithTaskCounts extends Board {
  taskCounts: {
    triage: number;
    todo: number;
    ready: number;
    running: number;
    done: number;
    blocked: number;
    archived: number;
  };
}

export function createBoard(slug: string, workdir: string, baseRef: string = "origin/main"): Board {
  const db = getDb();
  try {
    const result = db.run(
      "INSERT INTO boards (slug, workdir, base_ref) VALUES (?, ?, ?)",
      [slug, workdir, baseRef]
    );
    return {
      id: Number(result.lastInsertRowid),
      slug,
      workdir,
      base_ref: baseRef,
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
    `SELECT id, slug, workdir, base_ref, created_at, archived_at FROM boards ${whereClause} ORDER BY created_at DESC`
  ).all() as Board[];
}

export function showBoard(slug: string, includeArchived: boolean = false): BoardWithTaskCounts | null {
  const db = getDb();
  const archivedClause = includeArchived ? "" : "AND archived_at IS NULL";
  const board = db.query(
    `SELECT id, slug, workdir, base_ref, created_at, archived_at FROM boards WHERE slug = ? ${archivedClause}`
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
      archived: counts.archived ?? 0,
    },
  };
}

export function getBoardById(id: number): Board | null {
  const db = getDb();
  const board = db.query(
    `SELECT id, slug, workdir, base_ref, created_at, archived_at FROM boards WHERE id = ?`
  ).get(id) as Board | undefined;
  return board ?? null;
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
