# KDI-002: Scheduled Status Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scheduled` task status with a future timestamp, a dedicated `schedule_reason` column, and dispatcher auto-promotion to `ready` when the time arrives.

**Architecture:** Extend the existing `tasks` table and `Task` model with `scheduled` status, `scheduled_at`, and `schedule_reason`. Add model functions `scheduleTask`, `unblockTask` (extended), and `promoteScheduledTasks`. Wire `promoteScheduledTasks` into the dispatcher tick. Add a `kdi schedule` CLI command and extend `kdi unblock` with an optional reason.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, Commander.js, SQLite table-recreation migrations.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/db.ts` | Schema + migration: add `scheduled` status, `scheduled_at`, `schedule_reason`, and index. |
| `src/models/task.ts` | `Task` interface, `TASK_COLUMNS`, `scheduleTask`, `unblockTask`, `promoteScheduledTasks`. |
| `src/commands/tasks.ts` | `scheduleTaskCommand`, `unblockTaskCommand --reason`, status validation. |
| `src/index.ts` | Register `scheduleTaskCommand`. |
| `src/dispatcher.ts` | Call `promoteScheduledTasks` at start of each tick. |
| `tests/task.test.ts` | Model tests for schedule/unblock/promote. |
| `tests/dispatcher.test.ts` | Dispatcher tick promotes and claims scheduled task. |
| `tests/db.test.ts` | Schema/index assertions. |

---

## Chunk 1: Schema and Model

### Task 1: Add scheduled status and columns to schema

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Add `scheduled_at` and `schedule_reason` columns via migration**

After the existing `idempotency_key` migration block in `initDb`, add:

```typescript
// Migrate: add scheduled_at and schedule_reason if missing
const hasScheduledAt = tableInfo.some((col) => col.name === "scheduled_at");
if (!hasScheduledAt) {
  dbInstance.exec("ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER");
}
const hasScheduleReason = tableInfo.some((col) => col.name === "schedule_reason");
if (!hasScheduleReason) {
  dbInstance.exec("ALTER TABLE tasks ADD COLUMN schedule_reason TEXT");
}
```

- [ ] **Step 2: Add `'scheduled'` to status CHECK via table recreation**

Update the triage table-recreation migration so the new `tasks_new` definition includes `'scheduled'` in the CHECK and adds the two new columns. Replace the existing `CREATE TABLE tasks_new (...)` block with:

```sql
CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  body TEXT,
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('triage', 'todo', 'scheduled', 'ready', 'running', 'done', 'blocked', 'archived')),
  priority INTEGER DEFAULT 0,
  workspace_kind TEXT DEFAULT 'worktree' CHECK (workspace_kind IN ('dir', 'worktree', 'scratch')),
  branch TEXT,
  result TEXT,
  summary TEXT,
  block_reason TEXT,
  schedule_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  archived_at INTEGER,
  current_run_id INTEGER,
  claim_lock TEXT,
  claim_expires INTEGER,
  last_heartbeat_at INTEGER,
  idempotency_key TEXT,
  scheduled_at INTEGER
);
```

Also add after the index recreation inside that migration:

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(status, scheduled_at);
```

- [ ] **Step 3: Add index in SCHEMA constant for fresh DBs**

After `CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ...` in the `SCHEMA` constant, add:

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(status, scheduled_at);
```

- [ ] **Step 4: Run DB tests to verify schema**

Run:

```bash
bun test tests/db.test.ts
```

Expected: all pass (we will add explicit scheduled assertions later).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts

git commit -m "feat(KDI-002): schema for scheduled status, scheduled_at, schedule_reason"
```

---

### Task 2: Extend Task model

**Files:**
- Modify: `src/models/task.ts`

- [ ] **Step 1: Update `TASK_COLUMNS` and `Task` interface**

Add `scheduled_at` and `schedule_reason` to `TASK_COLUMNS` and to the `Task` interface. Update `Task["status"]` to include `"scheduled"`. Update `InitialTaskStatus` to include `"scheduled"`.

```typescript
export const TASK_COLUMNS =
  "id, board_id, title, body, assignee, status, priority, " +
  "workspace_kind, branch, result, summary, block_reason, schedule_reason, " +
  "created_at, updated_at, started_at, archived_at, current_run_id, " +
  "claim_lock, claim_expires, last_heartbeat_at, idempotency_key, scheduled_at";

export interface Task {
  ...
  status: "triage" | "todo" | "scheduled" | "ready" | "running" | "done" | "blocked" | "archived";
  block_reason: string | null;
  schedule_reason: string | null;
  ...
  scheduled_at: number | null;
}

export type InitialTaskStatus = Exclude<Task["status"], "archived" | "done">;
```

- [ ] **Step 2: Update `createTask` default object**

Add `schedule_reason: null` and `scheduled_at: null` to the returned task object.

- [ ] **Step 3: Implement `scheduleTask`**

Add below `completeTask`:

```typescript
export function scheduleTask(id: number, scheduledAt: number, reason?: string): Task {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  if (scheduledAt <= now) {
    throw new Error("Scheduled time must be in the future");
  }

  const result = db.run(
    `UPDATE tasks SET status = 'scheduled', scheduled_at = ?, schedule_reason = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [scheduledAt, reason ?? null, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found after scheduling`);
  }
  addEvent(task.id, "scheduled", { at: scheduledAt, reason });
  return task;
}
```

- [ ] **Step 4: Extend `unblockTask` to accept optional reason and handle scheduled**

Replace `unblockTask` with:

```typescript
export function unblockTask(id: number, reason?: string): Task {
  const db = getDb();
  const task = showTask(id);
  if (!task) {
    throw new Error(`Task ${id} not found`);
  }
  if (task.status !== "blocked" && task.status !== "scheduled") {
    throw new Error(`Task ${id} is not in 'blocked' or 'scheduled' status`);
  }

  if (reason) {
    db.run(
      `INSERT INTO comments (task_id, text, created_at) VALUES (?, ?, unixepoch())`,
      [id, reason]
    );
  }

  const targetStatus = task.status === "scheduled" ? "ready" : "todo";
  const result = db.run(
    `UPDATE tasks SET status = ?, block_reason = NULL, schedule_reason = NULL, scheduled_at = NULL, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL`,
    [targetStatus, id]
  );

  if (result.changes === 0) {
    throw new Error(`Task ${id} not found or already archived`);
  }

  const updated = showTask(id);
  if (!updated) {
    throw new Error(`Task ${id} not found after unblocking`);
  }

  if (task.status === "scheduled") {
    addEvent(updated.id, "ready", { reason, source: "unblock" });
  } else {
    addEvent(updated.id, "unblocked", { reason });
  }
  return updated;
}
```

- [ ] **Step 5: Implement `promoteScheduledTasks`**

Add below `unblockTask`:

```typescript
export function promoteScheduledTasks(now: number): number {
  const db = getDb();
  const tasks = db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE status = 'scheduled' AND scheduled_at <= ? AND archived_at IS NULL ORDER BY scheduled_at ASC`
  ).all(now) as Task[];

  for (const task of tasks) {
    db.run(
      `UPDATE tasks SET status = 'ready', scheduled_at = NULL, schedule_reason = NULL, updated_at = unixepoch() WHERE id = ?`,
      [task.id]
    );
    addEvent(task.id, "ready", { source: "scheduled", at: task.scheduled_at });
  }

  return tasks.length;
}
```

- [ ] **Step 6: Run task model tests**

Run:

```bash
bun test tests/task.test.ts
```

Expected: existing tests pass; new tests will be added next.

- [ ] **Step 7: Commit**

```bash
git add src/models/task.ts

git commit -m "feat(KDI-002): scheduleTask, unblock scheduled, promoteScheduledTasks"
```

---

## Chunk 2: CLI

### Task 3: Add `kdi schedule` command and extend `kdi unblock`

**Files:**
- Modify: `src/commands/tasks.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update `VALID_STATUSES`**

Change:

```typescript
const VALID_STATUSES = ["triage", "todo", "scheduled", "ready", "running", "done", "blocked"] as const;
```

- [ ] **Step 2: Add `scheduleTaskCommand`**

Add with the other command exports:

```typescript
function parseTimestamp(raw: string): number {
  if (/^\d+$/.test(raw)) {
    const seconds = parseInt(raw, 10);
    return seconds;
  }
  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }
  return Math.floor(date.getTime() / 1000);
}

export const scheduleTaskCommand = new Command("schedule")
  .description("Schedule a task to become ready at a future time")
  .argument("<task_id>", "Task ID")
  .requiredOption("--at <timestamp>", "ISO 8601 or Unix timestamp (seconds)")
  .option("--reason <text>", "Reason for scheduling")
  .action((taskId: string, options: { at: string; reason?: string }) => {
    try {
      const id = parseTaskId(taskId);
      const scheduledAt = parseTimestamp(options.at);
      const now = Math.floor(Date.now() / 1000);
      if (scheduledAt <= now) {
        throw new Error("Scheduled time must be in the future");
      }
      const task = scheduleTask(id, scheduledAt, options.reason);
      console.log(`Scheduled task ${task.id} for ${new Date(scheduledAt * 1000).toISOString()}.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 3: Import `scheduleTask` into tasks command file**

Update the import from `../models/task` to include `scheduleTask`.

- [ ] **Step 4: Extend `unblockTaskCommand`**

Change to:

```typescript
export const unblockTaskCommand = new Command("unblock")
  .description("Unblock a task (or immediately ready a scheduled task)")
  .argument("<task_id>", "Task ID")
  .option("--reason <text>", "Optional reason recorded as comment")
  .action((taskId: string, options: { reason?: string }) => {
    try {
      const id = parseTaskId(taskId);
      const task = unblockTask(id, options.reason);
      if (task.status === "ready") {
        console.log(`Task ${task.id} is now ready.`);
      } else {
        console.log(`Unblocked task ${task.id}.`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 5: Update `showTaskCommand` output**

After the block reason line, add:

```typescript
if (task.scheduled_at) console.log(`Scheduled at: ${new Date(task.scheduled_at * 1000).toISOString()}`);
if (task.schedule_reason) console.log(`Schedule reason: ${task.schedule_reason}`);
```

- [ ] **Step 6: Register command in `src/index.ts`**

Import `scheduleTaskCommand` and add:

```typescript
program.addCommand(scheduleTaskCommand);
```

- [ ] **Step 7: Run CLI smoke test**

Build and run:

```bash
bun run build
./kdi create "test" --board <existing-board-slug> --initial-status todo
./kdi schedule <task_id> --at $(($(date +%s) + 3600)) --reason "wait"
./kdi show <task_id>
./kdi unblock <task_id> --reason "now"
```

Expected: schedule succeeds, show displays scheduled status, unblock moves to ready.

- [ ] **Step 8: Commit**

```bash
git add src/commands/tasks.ts src/index.ts

git commit -m "feat(KDI-002): kdi schedule and unblock --reason commands"
```

---

## Chunk 3: Dispatcher Integration

### Task 4: Promote scheduled tasks in dispatcher tick

**Files:**
- Modify: `src/dispatcher.ts`

- [ ] **Step 1: Import `promoteScheduledTasks`**

```typescript
import { TASK_COLUMNS, type Task, promoteScheduledTasks } from "./models/task";
```

- [ ] **Step 2: Call at start of `tick()`**

After `reapStaleClaims()` and before `listReadyTasks()`, add:

```typescript
promoteScheduledTasks(Math.floor(Date.now() / 1000));
```

- [ ] **Step 3: Run dispatcher tests**

Run:

```bash
bun test tests/dispatcher.test.ts
```

Expected: existing tests pass; new test added next.

- [ ] **Step 4: Commit**

```bash
git add src/dispatcher.ts

git commit -m "feat(KDI-002): dispatcher auto-promotes scheduled tasks"
```

---

## Chunk 4: Tests

### Task 5: Add model tests

**Files:**
- Modify: `tests/task.test.ts`

- [ ] **Step 1: Import `scheduleTask` and `promoteScheduledTasks`**

Update the import from `../src/models/task`.

- [ ] **Step 2: Add tests**

Append to the `describe("task model")` block:

```typescript
it("scheduleTask parks task in scheduled with scheduled_at and schedule_reason", () => {
  const board = createBoard("alpha", "/tmp/alpha");
  const task = createTask({ board_id: board.id, title: "Schedule me" });
  const at = Math.floor(Date.now() / 1000) + 3600;

  const scheduled = scheduleTask(task.id, at, "wait for deploy");
  expect(scheduled.status).toBe("scheduled");
  expect(scheduled.scheduled_at).toBe(at);
  expect(scheduled.schedule_reason).toBe("wait for deploy");
});

it("scheduleTask rejects past timestamps", () => {
  const board = createBoard("alpha", "/tmp/alpha");
  const task = createTask({ board_id: board.id, title: "Schedule me" });
  const at = Math.floor(Date.now() / 1000) - 1;
  expect(() => scheduleTask(task.id, at)).toThrow("future");
});

it("unblockTask on scheduled task moves to ready and records reason comment", () => {
  const board = createBoard("alpha", "/tmp/alpha");
  const task = createTask({ board_id: board.id, title: "Scheduled" });
  const at = Math.floor(Date.now() / 1000) + 3600;
  scheduleTask(task.id, at, "wait");

  const ready = unblockTask(task.id, "deploy landed");
  expect(ready.status).toBe("ready");
  expect(ready.scheduled_at).toBeNull();
  expect(ready.schedule_reason).toBeNull();

  const events = getEvents(task.id);
  expect(events.some((e) => e.kind === "ready")).toBe(true);
});

it("unblockTask on blocked task still moves to todo and records comment", () => {
  const board = createBoard("alpha", "/tmp/alpha");
  const task = createTask({ board_id: board.id, title: "Blocked" });
  blockTask(task.id, "blocked");

  const unblocked = unblockTask(task.id, "resolved");
  expect(unblocked.status).toBe("todo");
  expect(unblocked.block_reason).toBeNull();
});

it("promoteScheduledTasks promotes only tasks whose scheduled_at has passed", () => {
  const board = createBoard("alpha", "/tmp/alpha");
  const now = Math.floor(Date.now() / 1000);
  const pastTask = createTask({ board_id: board.id, title: "Past" });
  const futureTask = createTask({ board_id: board.id, title: "Future" });

  // Simulate already-scheduled tasks by direct DB manipulation is not needed;
  // scheduleTask rejects past, so we schedule future then manually move time via re-insert.
  scheduleTask(pastTask.id, now + 10, "past");
  scheduleTask(futureTask.id, now + 3600, "future");

  // Promote as if now is 20s later
  const promoted = promoteScheduledTasks(now + 20);
  expect(promoted).toBe(1);

  expect(showTask(pastTask.id)!.status).toBe("ready");
  expect(showTask(futureTask.id)!.status).toBe("scheduled");
});

it("promoteScheduledTasks emits ready events", () => {
  const board = createBoard("alpha", "/tmp/alpha");
  const now = Math.floor(Date.now() / 1000);
  const task = createTask({ board_id: board.id, title: "Past" });
  scheduleTask(task.id, now + 5, "reason");

  promoteScheduledTasks(now + 10);
  const events = getEvents(task.id);
  expect(events.some((e) => e.kind === "ready" && e.payload?.includes("scheduled"))).toBe(true);
});
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/task.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/task.test.ts

git commit -m "test(KDI-002): scheduled status model behavior"
```

---

### Task 6: Add dispatcher test

**Files:**
- Modify: `tests/dispatcher.test.ts`

- [ ] **Step 1: Add test for tick promoting scheduled task**

Append a new test inside the dispatcher describe block:

```typescript
it("promotes scheduled task to ready and claims it in same tick", async () => {
  const board = createBoard("sched", "/tmp/sched");
  const task = createTask({ board_id: board.id, title: "Auto promote", assignee: "opencode" });
  const at = Math.floor(Date.now() / 1000) - 1;

  // Directly set scheduled in the past (bypass scheduleTask future-check)
  getDb().run(
    `UPDATE tasks SET status = 'scheduled', scheduled_at = ? WHERE id = ?`,
    [at, task.id]
  );

  let claimed = false;
  const result = await tick({
    spawnHarness: async () => {
      claimed = true;
      return { stdout: "done", stderr: "", exitCode: 0, pid: 1234 };
    },
    createWorktree: () => "/tmp/sched-wt",
    removeWorktree: () => ({ removed: true, path: "/tmp/sched-wt" }),
  });

  expect(result.processed).toBe(1);
  expect(claimed).toBe(true);
  const updated = showTask(task.id);
  expect(updated!.status).toBe("done");
});
```

- [ ] **Step 2: Run dispatcher tests**

```bash
bun test tests/dispatcher.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/dispatcher.test.ts

git commit -m "test(KDI-002): dispatcher auto-promotes scheduled task"
```

---

### Task 7: Add schema tests

**Files:**
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Add scheduled schema assertions**

Inside the schema test, add:

```typescript
// Verify scheduled status exists in CHECK constraint
const tasksCreateSql = db.query(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
).get() as { sql: string };
expect(tasksCreateSql.sql).toContain("'scheduled'");

// Verify scheduled columns exist
const taskColumns = db.query("PRAGMA table_info(tasks)").all() as any[];
const columnNames = taskColumns.map((c) => c.name);
expect(columnNames).toContain("scheduled_at");
expect(columnNames).toContain("schedule_reason");

// Verify scheduled index exists
const indexNames = indexes.map((i: any) => i.name);
expect(indexNames).toContain("idx_tasks_scheduled_at");
```

- [ ] **Step 2: Run DB tests**

```bash
bun test tests/db.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/db.test.ts

git commit -m "test(KDI-002): schema assertions for scheduled status"
```

---

## Chunk 5: Final Verification

### Task 8: Full test suite and build

**Files:**
- All of the above.

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 2: Build binary**

```bash
bun run build
```

Expected: `kdi` binary is produced.

- [ ] **Step 3: Manual CLI smoke test**

Use a real board slug from `kdi boards list`:

```bash
./kdi create "KDI-002 smoke" --board <slug> --initial-status todo
./kdi schedule <id> --at $(($(date +%s) + 120)) --reason "smoke test"
./kdi show <id>
./kdi list --board <slug> --status scheduled
./kdi unblock <id> --reason "skip wait"
```

Expected: status transitions match spec.

- [ ] **Step 4: Update STATUS.md**

Add under "Task Lifecycle" or KDI-002 section:

```markdown
## Scheduled Status (KDI-002) — Done
- [x] `scheduled` status added to tasks CHECK constraint with migration
- [x] `scheduled_at` and `schedule_reason` columns added
- [x] `kdi schedule <task_id> --at <timestamp> [--reason ...]` parks task in scheduled
- [x] `kdi unblock <task_id> [--reason ...]` immediately promotes scheduled → ready
- [x] Dispatcher auto-promotes scheduled tasks to ready when `scheduled_at` passes
```

- [ ] **Step 5: Commit**

```bash
git add STATUS.md

git commit -m "docs(KDI-002): mark scheduled status complete in STATUS"
```

---

## Completion

Plan complete and saved to `docs/superpowers/plans/2026-06-11-kdi-002-scheduled-status.md`. Ready to execute?
