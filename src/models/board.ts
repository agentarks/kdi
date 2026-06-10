import { getDb } from "../db";

export interface Board {
  id: number;
  slug: string;
  workdir: string;
  created_at: number;
  archived_at: number | null;
}

export interface BoardWithTaskCounts extends Board {
  taskCounts: {
    todo: number;
    ready: number;
    running: number;
    done: number;
    blocked: number;
  };
}

export function createBoard(slug: string, workdir: string): Board {
  const db = getDb();
  try {
    const result = db.run(
      "INSERT INTO boards (slug, workdir) VALUES (?, ?)",
      [slug, workdir]
    );
    return {
      id: Number(result.lastInsertRowid),
      slug,
      workdir,
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

export function listBoards(): Board[] {
  const db = getDb();
  return db.query(
    "SELECT id, slug, workdir, created_at, archived_at FROM boards WHERE archived_at IS NULL ORDER BY created_at DESC"
  ).all() as Board[];
}

export function showBoard(slug: string): BoardWithTaskCounts | null {
  const db = getDb();
  const board = db.query(
    "SELECT id, slug, workdir, created_at, archived_at FROM boards WHERE slug = ? AND archived_at IS NULL"
  ).get(slug) as Board | undefined;

  if (!board) return null;

  const counts = db.query(
    `SELECT 
      SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
    FROM tasks 
    WHERE board_id = ? AND archived_at IS NULL`
  ).get(board.id) as {
    todo: number | null;
    ready: number | null;
    running: number | null;
    done: number | null;
    blocked: number | null;
  };

  return {
    ...board,
    taskCounts: {
      todo: counts.todo ?? 0,
      ready: counts.ready ?? 0,
      running: counts.running ?? 0,
      done: counts.done ?? 0,
      blocked: counts.blocked ?? 0,
    },
  };
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
