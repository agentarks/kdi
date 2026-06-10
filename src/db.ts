import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let dbInstance: Database | null = null;

export function defaultDbPath(): string {
  return process.env.KDI_DB || `${homedir()}/.local/share/kdi/kdi.db`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  workdir TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'ready', 'running', 'done', 'blocked', 'archived')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  workspace_kind TEXT DEFAULT 'worktree' CHECK (workspace_kind IN ('dir', 'worktree', 'scratch')),
  branch TEXT,
  result TEXT,
  summary TEXT,
  block_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS dependencies (
  parent_id INTEGER NOT NULL REFERENCES tasks(id),
  child_id INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
`;

export function initDb(path?: string): Database {
  if (dbInstance) return dbInstance;

  const dbPath = path || defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  dbInstance = new Database(dbPath, { create: true });
  dbInstance.exec("PRAGMA journal_mode = WAL");
  dbInstance.exec("PRAGMA busy_timeout = 5000");
  dbInstance.exec(SCHEMA);

  // Migrate: add started_at column if missing
  const tableInfo = dbInstance.query("PRAGMA table_info(tasks)").all() as any[];
  const hasStartedAt = tableInfo.some((col) => col.name === "started_at");
  if (!hasStartedAt) {
    dbInstance.exec("ALTER TABLE tasks ADD COLUMN started_at INTEGER");
  }
  
  return dbInstance;
}

export function getDb(): Database {
  if (!dbInstance) throw new Error("Database not initialized. Call initDb() first.");
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
