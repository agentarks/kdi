import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;

export function defaultDbPath(): string {
  return process.env.KDI_DB || process.env.KDI_DB_PATH || `${homedir()}/.local/share/kdi/kdi.db`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  workdir TEXT NOT NULL,
  base_ref TEXT NOT NULL DEFAULT 'origin/main',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('triage', 'todo', 'scheduled', 'ready', 'running', 'done', 'blocked', 'review', 'archived')),
  priority INTEGER DEFAULT 0,
  tenant TEXT,
  workspace_kind TEXT DEFAULT 'worktree' CHECK (workspace_kind IN ('dir', 'worktree', 'scratch')),
  branch TEXT,
  result TEXT,
  summary TEXT,
  block_reason TEXT,
  schedule_reason TEXT,
  review_reason TEXT,
  scheduled_at INTEGER,
  created_by TEXT NOT NULL DEFAULT 'unknown',
  skills TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  archived_at INTEGER,
  claim_lock TEXT,
  claim_expires INTEGER,
  last_heartbeat_at INTEGER,
  max_runtime_seconds INTEGER,
  idempotency_key TEXT,
  model_override TEXT
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

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  profile TEXT,
  step_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'blocked', 'crashed', 'timed_out', 'failed', 'released')),
  claim_lock TEXT,
  claim_expires INTEGER,
  worker_pid INTEGER,
  max_runtime_seconds INTEGER,
  last_heartbeat_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed')),
  summary TEXT,
  metadata TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  run_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_run ON task_events(run_id, id);
`;

function initLockPath(dbPath: string): string {
  return `${dbPath}.init.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInitLock(dbPath: string): void {
  const path = initLockPath(dbPath);
  const maxWaitMs = 30000;
  const start = Date.now();

  while (true) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        if (Date.now() - start > maxWaitMs) {
          throw new Error(`Timeout waiting for database init lock: ${path}`);
        }

        try {
          const pid = parseInt(readFileSync(path, "utf8"), 10);
          if (isNaN(pid) || !isProcessAlive(pid)) {
            try {
              unlinkSync(path);
            } catch {}
            continue;
          }
        } catch {
          // Lock file may be in flux; retry
        }

        Bun.sleepSync(50);
        continue;
      }
      throw err;
    }
  }
}

function releaseInitLock(dbPath: string): void {
  try {
    unlinkSync(initLockPath(dbPath));
  } catch {}
}

export function initDb(path?: string): Database {
  const dbPath = path || defaultDbPath();
  if (dbInstance && currentDbPath === dbPath) return dbInstance;

  mkdirSync(dirname(dbPath), { recursive: true });

  acquireInitLock(dbPath);
  try {
    dbInstance = new Database(dbPath, { create: true });
    dbInstance.exec("PRAGMA journal_mode = WAL");
    dbInstance.exec("PRAGMA busy_timeout = 5000");
    dbInstance.exec(SCHEMA);
    currentDbPath = dbPath;

    // Migrate: add base_ref column to boards if missing
    const boardTableInfo = dbInstance.query("PRAGMA table_info(boards)").all() as any[];
    const hasBaseRef = boardTableInfo.some((col) => col.name === "base_ref");
    if (!hasBaseRef) {
      dbInstance.exec("ALTER TABLE boards ADD COLUMN base_ref TEXT NOT NULL DEFAULT 'origin/main'");
    }

    // Migrate: add started_at column if missing
    const tableInfo = dbInstance.query("PRAGMA table_info(tasks)").all() as any[];
    const hasStartedAt = tableInfo.some((col) => col.name === "started_at");
    if (!hasStartedAt) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN started_at INTEGER");
    }

    // Migrate: add current_run_id column if missing
    const hasCurrentRunId = tableInfo.some((col) => col.name === "current_run_id");
    if (!hasCurrentRunId) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN current_run_id INTEGER");
    }

    // Migrate: add claim_lock, claim_expires, last_heartbeat_at if missing
    const hasClaimLock = tableInfo.some((col) => col.name === "claim_lock");
    if (!hasClaimLock) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN claim_lock TEXT");
    }
    const hasClaimExpires = tableInfo.some((col) => col.name === "claim_expires");
    if (!hasClaimExpires) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN claim_expires INTEGER");
    }
    const hasLastHeartbeat = tableInfo.some((col) => col.name === "last_heartbeat_at");
    if (!hasLastHeartbeat) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN last_heartbeat_at INTEGER");
    }

    // Migrate: add idempotency_key if missing
    const hasIdempotencyKey = tableInfo.some((col) => col.name === "idempotency_key");
    if (!hasIdempotencyKey) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN idempotency_key TEXT");
    }

    // Migrate: add scheduled_at and schedule_reason if missing
    const hasScheduledAt = tableInfo.some((col) => col.name === "scheduled_at");
    if (!hasScheduledAt) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER");
    }
    const hasScheduleReason = tableInfo.some((col) => col.name === "schedule_reason");
    if (!hasScheduleReason) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN schedule_reason TEXT");
    }
    // Migrate: add review_reason if missing
    const hasReviewReason = tableInfo.some((col) => col.name === "review_reason");
    if (!hasReviewReason) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN review_reason TEXT");
    }

    // Migrate: add skills if missing
    const hasSkills = tableInfo.some((col) => col.name === "skills");
    if (!hasSkills) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN skills TEXT");
    }

    // Migrate: add max_runtime_seconds if missing
    const hasMaxRuntime = tableInfo.some((col) => col.name === "max_runtime_seconds");
    if (!hasMaxRuntime) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN max_runtime_seconds INTEGER");
    }

    // Migrate: add tenant if missing
    const hasTenant = tableInfo.some((col) => col.name === "tenant");
    if (!hasTenant) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN tenant TEXT");
    }

    // Migrate: add created_by if missing
    const hasCreatedBy = tableInfo.some((col) => col.name === "created_by");
    if (!hasCreatedBy) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown'");
    }
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(board_id, created_by)");

    // Migrate: add status column to task_runs if missing (for existing DBs)
    const runsTableInfo = dbInstance.query("PRAGMA table_info(task_runs)").all() as any[];
    const hasRunStatus = runsTableInfo.some((col) => col.name === "status");
    if (!hasRunStatus) {
      dbInstance.exec("ALTER TABLE task_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'blocked', 'crashed', 'timed_out', 'failed', 'released'))");
    }

    // Migrate: add max_runtime_seconds to task_runs if missing
    const hasRunMaxRuntime = runsTableInfo.some((col) => col.name === "max_runtime_seconds");
    if (!hasRunMaxRuntime) {
      dbInstance.exec("ALTER TABLE task_runs ADD COLUMN max_runtime_seconds INTEGER");
    }

    // Migrate: optimize idempotency index to composite
    const idempotencyIndexSql = dbInstance.query(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_idempotency'"
    ).get() as { sql: string } | undefined;
    if (!idempotencyIndexSql || !idempotencyIndexSql.sql.includes("board_id")) {
      dbInstance.exec("DROP INDEX IF EXISTS idx_tasks_idempotency");
      dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(board_id, idempotency_key, archived_at)");
    }
    // Partial unique index for race-safe idempotency
    dbInstance.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_idempotency ON tasks(board_id, idempotency_key) WHERE archived_at IS NULL");

    // Migrate: add 'triage' / 'review' / 'scheduled' to status CHECK constraint via table recreation
    const createSql = dbInstance.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get() as { sql: string } | undefined;
    const hasTriage = createSql?.sql?.includes("'triage'");
    const hasReview = createSql?.sql?.includes("'review'");
    const hasScheduledInTable = createSql?.sql?.includes("'scheduled'");
    const hasPriorityIndex = !!dbInstance.query(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_tasks_priority'"
    ).get();
    if (!hasTriage || !hasReview || !hasScheduledInTable || !hasPriorityIndex) {
      const migrate = dbInstance.transaction(() => {
        dbInstance!.exec(`
          CREATE TABLE tasks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id),
            title TEXT NOT NULL,
            body TEXT,
            assignee TEXT,
            status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('triage', 'todo', 'scheduled', 'ready', 'running', 'done', 'blocked', 'review', 'archived')),
            priority INTEGER DEFAULT 0,
            tenant TEXT,
            workspace_kind TEXT DEFAULT 'worktree' CHECK (workspace_kind IN ('dir', 'worktree', 'scratch')),
            branch TEXT,
            result TEXT,
            summary TEXT,
            block_reason TEXT,
            schedule_reason TEXT,
            review_reason TEXT,
            scheduled_at INTEGER,
            created_by TEXT NOT NULL DEFAULT 'unknown',
            skills TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            started_at INTEGER,
            archived_at INTEGER,
            current_run_id INTEGER,
            claim_lock TEXT,
            claim_expires INTEGER,
            last_heartbeat_at INTEGER,
            max_runtime_seconds INTEGER,
            idempotency_key TEXT,
            model_override TEXT
          );
          INSERT INTO tasks_new
            (id, board_id, title, body, assignee, status, priority, tenant, workspace_kind, branch, result, summary, block_reason, schedule_reason, review_reason, scheduled_at, created_by, skills, created_at, updated_at, started_at, archived_at, current_run_id, claim_lock, claim_expires, last_heartbeat_at, max_runtime_seconds, idempotency_key)
          SELECT
            id, board_id, title, body, assignee, status,
            CASE priority WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE COALESCE(priority, 0) END,
            tenant, workspace_kind, branch, result, summary, block_reason, schedule_reason, review_reason, scheduled_at, COALESCE(created_by, 'unknown'), skills, created_at, updated_at, started_at, archived_at, current_run_id, claim_lock, claim_expires, last_heartbeat_at, max_runtime_seconds, idempotency_key
          FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id, status);
          CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
          CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(board_id, idempotency_key, archived_at);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_idempotency ON tasks(board_id, idempotency_key) WHERE archived_at IS NULL;
          CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(board_id, created_by);
        `);
      });
      migrate();
    }

    // Migrate: add model_override if missing
    const modelOverrideInfo = dbInstance.query("PRAGMA table_info(tasks)").all() as any[];
    const hasModelOverride = modelOverrideInfo.some((col) => col.name === "model_override");
    if (!hasModelOverride) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN model_override TEXT");
    }

    // Create indexes for columns that are added by migrations, so old databases
    // do not fail during SCHEMA execution before the migrations can run.
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(status, scheduled_at)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(board_id, tenant)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status)");
  } catch (err) {
    closeDb();
    throw err;
  } finally {
    releaseInitLock(dbPath);
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
    currentDbPath = null;
  }
}
