import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertValidBoardSlug } from "./slugs";

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;

export function defaultDbPath(): string {
  return process.env.KDI_DB || process.env.KDI_DB_PATH || `${homedir()}/.local/share/kdi/kdi.db`;
}

export function getBoardDataDir(slug: string): string {
  assertValidBoardSlug(slug);
  return join(dirname(defaultDbPath()), "boards", slug);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  workdir TEXT NOT NULL,
  default_workdir TEXT,
  base_ref TEXT NOT NULL DEFAULT 'origin/main',
  name TEXT,
  icon TEXT,
  color TEXT,
  description TEXT,
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
  workspace TEXT,
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
  max_retries INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  model_override TEXT,
  rate_limited_until INTEGER,
  session_id TEXT,
  workflow_template_id TEXT,
  current_step_key TEXT,
  swarm_parent_id INTEGER,
  goal_mode INTEGER NOT NULL DEFAULT 0,
  goal_max_turns INTEGER,
  goal_remaining_turns INTEGER,
  goal_judge_profile TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL,
  author TEXT,
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
  spawned_at INTEGER,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed', 'goal_continue')),
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

CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS kanban_notify_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT,
  notifier_profile TEXT NOT NULL,
  subscribed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  unsubscribed_at INTEGER,
  UNIQUE (task_id, platform, chat_id, thread_id)
);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id),
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (board_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_notify_subs_task ON kanban_notify_subs(task_id);
CREATE INDEX IF NOT EXISTS idx_notify_subs_active ON kanban_notify_subs(task_id, unsubscribed_at);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_board ON workflow_templates(board_id);

CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_run ON task_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);
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

    // Migrate: add default_workdir column to boards if missing
    const hasDefaultWorkdir = boardTableInfo.some((col) => col.name === "default_workdir");
    if (!hasDefaultWorkdir) {
      dbInstance.exec("ALTER TABLE boards ADD COLUMN default_workdir TEXT");
    }

    // Migrate: add board metadata columns if missing
    const hasBoardName = boardTableInfo.some((col) => col.name === "name");
    if (!hasBoardName) {
      dbInstance.exec("ALTER TABLE boards ADD COLUMN name TEXT");
      // Backfill existing boards so every board has a display name.
      dbInstance.exec("UPDATE boards SET name = slug WHERE name IS NULL");
    }
    const hasBoardIcon = boardTableInfo.some((col) => col.name === "icon");
    if (!hasBoardIcon) {
      dbInstance.exec("ALTER TABLE boards ADD COLUMN icon TEXT");
    }
    const hasBoardColor = boardTableInfo.some((col) => col.name === "color");
    if (!hasBoardColor) {
      dbInstance.exec("ALTER TABLE boards ADD COLUMN color TEXT");
    }
    const hasBoardDescription = boardTableInfo.some((col) => col.name === "description");
    if (!hasBoardDescription) {
      dbInstance.exec("ALTER TABLE boards ADD COLUMN description TEXT");
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

    // Migrate: add workspace if missing
    const hasWorkspace = tableInfo.some((col) => col.name === "workspace");
    if (!hasWorkspace) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN workspace TEXT");
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

    // Migrate: add max_retries and consecutive_failures if missing
    const hasMaxRetries = tableInfo.some((col) => col.name === "max_retries");
    if (!hasMaxRetries) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN max_retries INTEGER");
    }
    const hasConsecutiveFailures = tableInfo.some((col) => col.name === "consecutive_failures");
    if (!hasConsecutiveFailures) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    }

    // Migrate: add model_override if missing
    const hasModelOverride = tableInfo.some((col) => col.name === "model_override");
    if (!hasModelOverride) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN model_override TEXT");
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

    // Migrate: add rate_limited_until if missing
    const hasRateLimitedUntil = tableInfo.some((col) => col.name === "rate_limited_until");
    if (!hasRateLimitedUntil) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN rate_limited_until INTEGER");
    }
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_rate_limited_until ON tasks(status, rate_limited_until)");

    // Migrate: add session_id column if missing
    const hasSessionId = tableInfo.some((col) => col.name === "session_id");
    if (!hasSessionId) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
    }

    // Migrate: add workflow_template_id column if missing
    const hasWorkflowTemplateId = tableInfo.some((col) => col.name === "workflow_template_id");
    if (!hasWorkflowTemplateId) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN workflow_template_id TEXT");
    }

    // Migrate: add current_step_key column if missing
    const hasCurrentStepKey = tableInfo.some((col) => col.name === "current_step_key");
    if (!hasCurrentStepKey) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN current_step_key TEXT");
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

    // Migrate: add spawned_at to task_runs if missing
    const hasRunSpawnedAt = runsTableInfo.some((col) => col.name === "spawned_at");
    if (!hasRunSpawnedAt) {
      dbInstance.exec("ALTER TABLE task_runs ADD COLUMN spawned_at INTEGER");
    }

    // Migrate: add task_attachments table if missing
    const hasTaskAttachments = dbInstance.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_attachments'"
    ).get() as { 1: number } | undefined;
    if (!hasTaskAttachments) {
      dbInstance.exec(`
        CREATE TABLE task_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          filename TEXT NOT NULL,
          stored_path TEXT NOT NULL,
          content_type TEXT,
          size INTEGER NOT NULL,
          uploaded_by TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      dbInstance.exec("CREATE INDEX idx_task_attachments_task ON task_attachments(task_id)");
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

    // KDI-038: add goal-mode columns BEFORE the tasks_new table-recreate migration below,
    // so the SELECT in tasks_new can reference them on legacy databases.
    const preRecreateTableInfo = dbInstance.query("PRAGMA table_info(tasks)").all() as any[];
    const hasPreGoalMode = preRecreateTableInfo.some((col) => col.name === "goal_mode");
    if (!hasPreGoalMode) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN goal_mode INTEGER NOT NULL DEFAULT 0");
    }
    const hasPreGoalMaxTurns = preRecreateTableInfo.some((col) => col.name === "goal_max_turns");
    if (!hasPreGoalMaxTurns) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN goal_max_turns INTEGER");
    }
    const hasPreGoalRemainingTurns = preRecreateTableInfo.some((col) => col.name === "goal_remaining_turns");
    if (!hasPreGoalRemainingTurns) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN goal_remaining_turns INTEGER");
    }
    const hasPreGoalJudgeProfile = preRecreateTableInfo.some((col) => col.name === "goal_judge_profile");
    if (!hasPreGoalJudgeProfile) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN goal_judge_profile TEXT");
    }

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
            workspace TEXT,
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
            max_retries INTEGER,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            idempotency_key TEXT,
            model_override TEXT,
            rate_limited_until INTEGER,
            session_id TEXT,
            workflow_template_id TEXT,
            current_step_key TEXT,
            swarm_parent_id INTEGER,
            goal_mode INTEGER NOT NULL DEFAULT 0,
            goal_max_turns INTEGER,
            goal_remaining_turns INTEGER,
            goal_judge_profile TEXT
          );
          INSERT INTO tasks_new
            (id, board_id, title, body, assignee, status, priority, tenant, workspace_kind, workspace, branch, result, summary, block_reason, schedule_reason, review_reason, scheduled_at, created_by, skills, created_at, updated_at, started_at, archived_at, current_run_id, claim_lock, claim_expires, last_heartbeat_at, max_runtime_seconds, max_retries, consecutive_failures, idempotency_key, model_override, rate_limited_until, session_id, workflow_template_id, current_step_key, swarm_parent_id, goal_mode, goal_max_turns, goal_remaining_turns, goal_judge_profile)
          SELECT
            id, board_id, title, body, assignee, status,
            CASE priority WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE COALESCE(priority, 0) END,
            tenant, workspace_kind, workspace, branch, result, summary, block_reason, schedule_reason, review_reason, scheduled_at, COALESCE(created_by, 'unknown'), skills, created_at, updated_at, started_at, archived_at, current_run_id, claim_lock, claim_expires, last_heartbeat_at, max_runtime_seconds, max_retries, COALESCE(consecutive_failures, 0), idempotency_key, model_override, rate_limited_until, NULL, NULL, NULL, NULL AS swarm_parent_id, COALESCE(goal_mode, 0), goal_max_turns, goal_remaining_turns, goal_judge_profile
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

    // Create indexes for columns that are added by migrations, so old databases
    // do not fail during SCHEMA execution before the migrations can run.
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(status, scheduled_at)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(board_id, tenant)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(board_id, session_id)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workflow_template ON tasks(board_id, workflow_template_id)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_step_key ON tasks(board_id, current_step_key)");
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status)");

    // Migrate: add author column to comments if missing
    const commentsTableInfo = dbInstance.query("PRAGMA table_info(comments)").all() as any[];
    if (!commentsTableInfo.some((col) => col.name === "author")) {
      dbInstance.exec("ALTER TABLE comments ADD COLUMN author TEXT");
    }

    // Migrate: add kanban_notify_subs table and indexes if missing
    const hasNotifySubs = dbInstance.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kanban_notify_subs'"
    ).get() as { 1: number } | undefined;
    if (!hasNotifySubs) {
      dbInstance.exec(`
        CREATE TABLE kanban_notify_subs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          platform TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          thread_id TEXT,
          user_id TEXT,
          notifier_profile TEXT NOT NULL,
          subscribed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          unsubscribed_at INTEGER,
          UNIQUE (task_id, platform, chat_id, thread_id)
        )
      `);
      dbInstance.exec("CREATE INDEX idx_notify_subs_task ON kanban_notify_subs(task_id)");
      dbInstance.exec("CREATE INDEX idx_notify_subs_active ON kanban_notify_subs(task_id, unsubscribed_at)");
    }

    // Migrate: add workflow_templates table and index if missing
    const hasWorkflowTemplates = dbInstance.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_templates'"
    ).get() as { 1: number } | undefined;
    if (!hasWorkflowTemplates) {
      dbInstance.exec(`
        CREATE TABLE workflow_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          board_id INTEGER NOT NULL REFERENCES boards(id),
          template_id TEXT NOT NULL,
          name TEXT NOT NULL,
          steps TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (board_id, template_id)
        )
      `);
      dbInstance.exec("CREATE INDEX idx_workflow_templates_board ON workflow_templates(board_id)");
    }

    // Migrate: add swarm_parent_id column if missing
    const currentTableInfo = dbInstance.query("PRAGMA table_info(tasks)").all() as any[];
    const hasSwarmParentId = currentTableInfo.some((col) => col.name === "swarm_parent_id");
    if (!hasSwarmParentId) {
      dbInstance.exec("ALTER TABLE tasks ADD COLUMN swarm_parent_id INTEGER");
    }
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_swarm_parent ON tasks(board_id, swarm_parent_id)");

    // Goal-mode columns are added above (before the tasks_new table-recreate migration).
    // The index is created here so legacy databases get it after the table is in its
    // final shape.
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_tasks_goal_mode ON tasks(status, goal_mode)");

    // Migrate: extend task_runs.outcome CHECK to include 'goal_continue' (KDI-038).
    // Mirrors the existing tasks_new table-recreate pattern: only recreate if the
    // current CHECK constraint does not already contain the new value.
    const runsCreateSql = dbInstance.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_runs'"
    ).get() as { sql: string } | undefined;
    const hasGoalContinueOutcome = runsCreateSql?.sql?.includes("'goal_continue'");
    if (!hasGoalContinueOutcome) {
      const migrateOutcomes = dbInstance.transaction(() => {
        dbInstance!.exec(`
          CREATE TABLE task_runs_new (
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
            spawned_at INTEGER,
            ended_at INTEGER,
            outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'gave_up', 'reclaimed', 'goal_continue')),
            summary TEXT,
            metadata TEXT,
            error TEXT
          );
          INSERT INTO task_runs_new
            (id, task_id, profile, step_key, status, claim_lock, claim_expires, worker_pid, max_runtime_seconds, last_heartbeat_at, started_at, spawned_at, ended_at, outcome, summary, metadata, error)
          SELECT
            id, task_id, profile, step_key, status, claim_lock, claim_expires, worker_pid, max_runtime_seconds, last_heartbeat_at, started_at, spawned_at, ended_at, outcome, summary, metadata, error
          FROM task_runs;
          DROP TABLE task_runs;
          ALTER TABLE task_runs_new RENAME TO task_runs;
          CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at);
          CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status);
        `);
      });
      migrateOutcomes();
    }

  } catch (err) {
    closeDb();
    throw err;
  } finally {
    releaseInitLock(dbPath);
  }

  return dbInstance;
}

export function getDb(): Database {
  if (!dbInstance) throw new Error("Database not initialized. Run 'kdi init' first.");
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    currentDbPath = null;
  }
}
