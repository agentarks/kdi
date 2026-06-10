# kdi — Multi-Agent Kanban Dispatch Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-binary kanban dispatch system that queues tasks for AI coding agents, runs them in isolated git worktrees, and tracks results via SQLite.

**Architecture:** A CLI-first tool using Bun's native SQLite (bun:sqlite) with WAL mode. Core domain models (Board, Task, Comment) live in `src/models/`. Harness profiles are parsed from YAML with Go-template-style substitution. A background dispatcher polls for `ready` tasks, claims them via CAS, spawns the configured harness in a git worktree, and records results. All commands are wired through commander.js.

**Tech Stack:** Bun (runtime + SQLite), TypeScript, commander.js (CLI), yaml (profile parsing), git (worktree isolation)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/db.ts` | SQLite connection, schema creation, migrations, WAL config |
| `src/models/board.ts` | Board CRUD: create, list, show, archive |
| `src/models/task.ts` | Task CRUD + lifecycle transitions (promote, block, unblock, archive) |
| `src/models/comment.ts` | Comment CRUD for tasks |
| `src/models/dependency.ts` | Parent/child dependency tracking and resolution |
| `src/profiles.ts` | Load `~/.config/kdi/profiles.yaml`, validate, template substitution |
| `src/dispatcher.ts` | Background polling loop: claim ready tasks, spawn harness, record results |
| `src/worktree.ts` | Git worktree creation, branch naming, cleanup |
| `src/observability.ts` | Metrics (ticks, claims, durations), board-specific logging |
| `src/flags.ts` | Feature flag registry (`FF_ENABLE_KANBAN_DISPATCH`) |
| `src/commands/boards.ts` | `kdi boards create/list/show/archive` handlers |
| `src/commands/tasks.ts` | `kdi create/list/show/edit/comment/promote/block/unblock/archive` handlers |
| `src/commands/dispatch.ts` | `kdi dispatch` daemon command |
| `src/index.ts` | Commander.js entry point, command registration, `--version` |
| `tests/db.test.ts` | Database layer tests |
| `tests/board.test.ts` | Board model tests |
| `tests/task.test.ts` | Task lifecycle tests |
| `tests/profiles.test.ts` | Profile parsing and template tests |
| `tests/dispatcher.test.ts` | Dispatcher logic tests (mocked spawn) |

---

## Chunk 1: Foundation (DB, Schema, Feature Flags)

### Task 1: Database Layer with WAL Mode

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, getDb, closeDb } from "../src/db";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-test.db";

describe("db", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("creates schema and returns a Database instance", () => {
    const db = initDb(TEST_DB);
    expect(db).toBeInstanceOf(Database);
    
    // Verify WAL mode
    const journal = db.query("PRAGMA journal_mode").get();
    expect(journal).toEqual({ journal_mode: "wal" });
    
    // Verify tables exist
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: any) => t.name);
    expect(names).toContain("boards");
    expect(names).toContain("tasks");
    expect(names).toContain("comments");
    expect(names).toContain("dependencies");
  });

  it("returns the same instance on subsequent calls", () => {
    const db1 = initDb(TEST_DB);
    const db2 = getDb();
    expect(db1).toBe(db2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db.test.ts`

Expected: FAIL with "Cannot find module '../src/db'"

- [ ] **Step 3: Implement the database layer**

Create `src/db.ts`:

```typescript
import { Database } from "bun:sqlite";

let dbInstance: Database | null = null;

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

export function initDb(path: string): Database {
  if (dbInstance) return dbInstance;
  
  dbInstance = new Database(path, { create: true });
  dbInstance.exec("PRAGMA journal_mode = WAL");
  dbInstance.exec("PRAGMA busy_timeout = 5000");
  dbInstance.exec(SCHEMA);
  
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/db.test.ts`

Expected: PASS (2/2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(db): SQLite layer with WAL mode and schema"
```

---

### Task 2: Feature Flags

**Files:**
- Create: `src/flags.ts`
- Create: `tests/flags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/flags.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { isEnabled, setFlag } from "../src/flags";

describe("flags", () => {
  it("FF_ENABLE_KANBAN_DISPATCH defaults to false", () => {
    expect(isEnabled("FF_ENABLE_KANBAN_DISPATCH")).toBe(false);
  });

  it("setFlag enables a flag", () => {
    setFlag("FF_ENABLE_KANBAN_DISPATCH", true);
    expect(isEnabled("FF_ENABLE_KANBAN_DISPATCH")).toBe(true);
  });

  it("unknown flags default to false", () => {
    expect(isEnabled("FF_UNKNOWN")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/flags.test.ts`

Expected: FAIL with "Cannot find module '../src/flags'"

- [ ] **Step 3: Implement feature flags**

Create `src/flags.ts`:

```typescript
const flags: Record<string, boolean> = {
  FF_ENABLE_KANBAN_DISPATCH: false,
};

export function isEnabled(flag: string): boolean {
  const env = process.env[flag];
  if (env !== undefined) return env === "1" || env === "true";
  return flags[flag] ?? false;
}

export function setFlag(flag: string, value: boolean): void {
  flags[flag] = value;
}

export function registerFlag(flag: string, defaultValue: boolean): void {
  flags[flag] = defaultValue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/flags.test.ts`

Expected: PASS (3/3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/flags.ts tests/flags.test.ts
git commit -m "feat(flags): feature flag registry with env override"
```

---

## Chunk 2: Models (Boards, Tasks, Comments, Dependencies)

### Task 3: Board Model

**Files:**
- Create: `src/models/board.ts`
- Create: `tests/board.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/board.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import {
  createBoard,
  listBoards,
  showBoard,
  archiveBoard,
} from "../src/models/board";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-board-test.db";

describe("board model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("creates a board and returns it", () => {
    const board = createBoard("myproj", "/home/user/myproj");
    expect(board.slug).toBe("myproj");
    expect(board.workdir).toBe("/home/user/myproj");
    expect(board.id).toBeGreaterThan(0);
    expect(board.archived_at).toBeNull();
  });

  it("lists all non-archived boards", () => {
    createBoard("proj-a", "/a");
    createBoard("proj-b", "/b");
    archiveBoard("proj-a");
    
    const boards = listBoards();
    expect(boards.length).toBe(1);
    expect(boards[0].slug).toBe("proj-b");
  });

  it("shows board with task counts", () => {
    createBoard("proj-c", "/c");
    const info = showBoard("proj-c");
    expect(info.slug).toBe("proj-c");
    expect(info.task_counts).toEqual({ todo: 0, ready: 0, running: 0, done: 0, blocked: 0 });
  });

  it("archives a board", () => {
    createBoard("proj-d", "/d");
    archiveBoard("proj-d");
    const info = showBoard("proj-d");
    expect(info.archived_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/board.test.ts`

Expected: FAIL with "Cannot find module '../src/models/board'"

- [ ] **Step 3: Implement the board model**

Create `src/models/board.ts`:

```typescript
import { getDb } from "../db";

export interface Board {
  id: number;
  slug: string;
  workdir: string;
  created_at: number;
  archived_at: number | null;
}

export interface BoardInfo extends Board {
  task_counts: Record<string, number>;
}

export function createBoard(slug: string, workdir: string): Board {
  const db = getDb();
  const stmt = db.prepare("INSERT INTO boards (slug, workdir) VALUES (?, ?) RETURNING *");
  const row = stmt.get(slug, workdir) as Board;
  return row;
}

export function listBoards(): Board[] {
  const db = getDb();
  return db.query("SELECT * FROM boards WHERE archived_at IS NULL ORDER BY created_at DESC").all() as Board[];
}

export function showBoard(slug: string): BoardInfo {
  const db = getDb();
  const board = db.query("SELECT * FROM boards WHERE slug = ?").get(slug) as Board | undefined;
  if (!board) throw new Error(`Board not found: ${slug}`);
  
  const counts: Record<string, number> = { todo: 0, ready: 0, running: 0, done: 0, blocked: 0 };
  const rows = db.query("SELECT status, COUNT(*) as count FROM tasks WHERE board_id = ? AND archived_at IS NULL GROUP BY status").all(board.id) as { status: string; count: number }[];
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  
  return { ...board, task_counts: counts };
}

export function archiveBoard(slug: string): void {
  const db = getDb();
  db.prepare("UPDATE boards SET archived_at = unixepoch() WHERE slug = ?").run(slug);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/board.test.ts`

Expected: PASS (4/4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/models/board.ts tests/board.test.ts
git commit -m "feat(boards): CRUD + archive with task counts"
```

---

### Task 4: Task Model

**Files:**
- Create: `src/models/task.ts`
- Create: `tests/task.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/task.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  blockTask,
  unblockTask,
  archiveTask,
} from "../src/models/task";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-task-test.db";

describe("task model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
    createBoard("myproj", "/home/user/myproj");
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("creates a task", () => {
    const task = createTask({ boardSlug: "myproj", title: "backend: auth", assignee: "opencode" });
    expect(task.title).toBe("backend: auth");
    expect(task.status).toBe("todo");
    expect(task.assignee).toBe("opencode");
  });

  it("lists tasks filtered by status", () => {
    createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    const t2 = createTask({ boardSlug: "myproj", title: "t2", assignee: "claude" });
    promoteTask(t2.id);
    
    const ready = listTasks({ boardSlug: "myproj", status: "ready" });
    expect(ready.length).toBe(1);
    expect(ready[0].title).toBe("t2");
  });

  it("promotes todo -> ready", () => {
    const task = createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    promoteTask(task.id);
    const updated = showTask(task.id);
    expect(updated.status).toBe("ready");
  });

  it("blocks with reason", () => {
    const task = createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    blockTask(task.id, "waiting for API");
    const updated = showTask(task.id);
    expect(updated.status).toBe("blocked");
    expect(updated.block_reason).toBe("waiting for API");
  });

  it("unblocks -> todo", () => {
    const task = createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    blockTask(task.id, "waiting");
    unblockTask(task.id);
    const updated = showTask(task.id);
    expect(updated.status).toBe("todo");
    expect(updated.block_reason).toBeNull();
  });

  it("archives a task", () => {
    const task = createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    archiveTask(task.id);
    const updated = showTask(task.id);
    expect(updated.archived_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/task.test.ts`

Expected: FAIL with "Cannot find module '../src/models/task'"

- [ ] **Step 3: Implement the task model**

Create `src/models/task.ts`:

```typescript
import { getDb } from "../db";

export type TaskStatus = "todo" | "ready" | "running" | "done" | "blocked" | "archived";

export interface Task {
  id: number;
  board_id: number;
  title: string;
  body: string | null;
  assignee: string | null;
  status: TaskStatus;
  priority: string;
  workspace_kind: string;
  branch: string | null;
  result: string | null;
  summary: string | null;
  block_reason: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface CreateTaskInput {
  boardSlug: string;
  title: string;
  assignee?: string;
  body?: string;
  priority?: string;
  workspaceKind?: string;
  branch?: string;
}

export interface ListTasksFilter {
  boardSlug: string;
  status?: string;
  assignee?: string;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const board = db.query("SELECT id FROM boards WHERE slug = ?").get(input.boardSlug) as { id: number } | undefined;
  if (!board) throw new Error(`Board not found: ${input.boardSlug}`);
  
  const stmt = db.prepare(`
    INSERT INTO tasks (board_id, title, assignee, body, priority, workspace_kind, branch)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  
  return stmt.get(
    board.id,
    input.title,
    input.assignee ?? null,
    input.body ?? null,
    input.priority ?? "medium",
    input.workspaceKind ?? "worktree",
    input.branch ?? null
  ) as Task;
}

export function listTasks(filter: ListTasksFilter): Task[] {
  const db = getDb();
  const board = db.query("SELECT id FROM boards WHERE slug = ?").get(filter.boardSlug) as { id: number } | undefined;
  if (!board) throw new Error(`Board not found: ${filter.boardSlug}`);
  
  let sql = "SELECT * FROM tasks WHERE board_id = ? AND archived_at IS NULL";
  const params: any[] = [board.id];
  
  if (filter.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter.assignee) {
    sql += " AND assignee = ?";
    params.push(filter.assignee);
  }
  
  sql += " ORDER BY created_at DESC";
  return db.query(sql).all(...params) as Task[];
}

export function showTask(id: number): Task {
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

export function editTask(id: number, body: string): void {
  const db = getDb();
  db.prepare("UPDATE tasks SET body = ?, updated_at = unixepoch() WHERE id = ?").run(body, id);
}

export function promoteTask(id: number): void {
  const db = getDb();
  const result = db.prepare("UPDATE tasks SET status = 'ready', updated_at = unixepoch() WHERE id = ? AND status = 'todo'").run(id);
  if (result.changes === 0) throw new Error(`Task ${id} is not in 'todo' status`);
}

export function blockTask(id: number, reason: string): void {
  const db = getDb();
  db.prepare("UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = unixepoch() WHERE id = ?").run(reason, id);
}

export function unblockTask(id: number): void {
  const db = getDb();
  db.prepare("UPDATE tasks SET status = 'todo', block_reason = NULL, updated_at = unixepoch() WHERE id = ? AND status = 'blocked'").run(id);
}

export function archiveTask(id: number): void {
  const db = getDb();
  db.prepare("UPDATE tasks SET status = 'archived', archived_at = unixepoch(), updated_at = unixepoch() WHERE id = ?").run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/task.test.ts`

Expected: PASS (6/6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/models/task.ts tests/task.test.ts
git commit -m "feat(tasks): full lifecycle CRUD with status transitions"
```

---

### Task 5: Comment Model

**Files:**
- Create: `src/models/comment.ts`
- Modify: `src/models/task.ts` (add comment loading to showTask)

- [ ] **Step 1: Write the failing test**

Create `tests/comment.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import { addComment, getComments } from "../src/models/comment";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-comment-test.db";

describe("comment model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
    createBoard("myproj", "/home/user/myproj");
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("adds and retrieves comments", () => {
    const task = createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    addComment(task.id, "this looks good");
    addComment(task.id, "needs more tests");
    
    const comments = getComments(task.id);
    expect(comments.length).toBe(2);
    expect(comments[0].text).toBe("this looks good");
    expect(comments[1].text).toBe("needs more tests");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/comment.test.ts`

Expected: FAIL with "Cannot find module '../src/models/comment'"

- [ ] **Step 3: Implement the comment model**

Create `src/models/comment.ts`:

```typescript
import { getDb } from "../db";

export interface Comment {
  id: number;
  task_id: number;
  text: string;
  created_at: number;
}

export function addComment(taskId: number, text: string): Comment {
  const db = getDb();
  return db.prepare("INSERT INTO comments (task_id, text) VALUES (?, ?) RETURNING *").get(taskId, text) as Comment;
}

export function getComments(taskId: number): Comment[] {
  const db = getDb();
  return db.query("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Comment[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/comment.test.ts`

Expected: PASS (1/1 test)

- [ ] **Step 5: Commit**

```bash
git add src/models/comment.ts tests/comment.test.ts
git commit -m "feat(comments): add and retrieve task comments"
```

---

### Task 6: Dependency Model

**Files:**
- Create: `src/models/dependency.ts`
- Create: `tests/dependency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/dependency.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import { addDependency, isBlockedByDependencies, getChildTasks } from "../src/models/dependency";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-dep-test.db";

describe("dependency model", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
    createBoard("myproj", "/home/user/myproj");
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("blocks child when parent is not done", () => {
    const parent = createTask({ boardSlug: "myproj", title: "parent", assignee: "opencode" });
    const child = createTask({ boardSlug: "myproj", title: "child", assignee: "opencode" });
    addDependency(parent.id, child.id);
    
    expect(isBlockedByDependencies(child.id)).toBe(true);
  });

  it("unblocks child when parent is done", () => {
    const parent = createTask({ boardSlug: "myproj", title: "parent", assignee: "opencode" });
    const child = createTask({ boardSlug: "myproj", title: "child", assignee: "opencode" });
    addDependency(parent.id, child.id);
    
    // Simulate parent done by updating status directly
    const db = (await import("../src/db")).getDb();
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(parent.id);
    
    expect(isBlockedByDependencies(child.id)).toBe(false);
  });

  it("lists child tasks for a parent", () => {
    const parent = createTask({ boardSlug: "myproj", title: "parent", assignee: "opencode" });
    const child1 = createTask({ boardSlug: "myproj", title: "child1", assignee: "opencode" });
    const child2 = createTask({ boardSlug: "myproj", title: "child2", assignee: "opencode" });
    addDependency(parent.id, child1.id);
    addDependency(parent.id, child2.id);
    
    const children = getChildTasks(parent.id);
    expect(children.map((c: any) => c.title)).toContain("child1");
    expect(children.map((c: any) => c.title)).toContain("child2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/dependency.test.ts`

Expected: FAIL with "Cannot find module '../src/models/dependency'"

- [ ] **Step 3: Implement the dependency model**

Create `src/models/dependency.ts`:

```typescript
import { getDb } from "../db";
import type { Task } from "./task";

export function addDependency(parentId: number, childId: number): void {
  const db = getDb();
  db.prepare("INSERT INTO dependencies (parent_id, child_id) VALUES (?, ?)").run(parentId, childId);
}

export function isBlockedByDependencies(taskId: number): boolean {
  const db = getDb();
  const row = db.query(`
    SELECT COUNT(*) as count 
    FROM dependencies d
    JOIN tasks t ON d.parent_id = t.id
    WHERE d.child_id = ? AND t.status != 'done'
  `).get(taskId) as { count: number };
  return row.count > 0;
}

export function getChildTasks(parentId: number): Task[] {
  const db = getDb();
  return db.query(`
    SELECT t.* FROM tasks t
    JOIN dependencies d ON t.id = d.child_id
    WHERE d.parent_id = ?
  `).all(parentId) as Task[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/dependency.test.ts`

Expected: PASS (3/3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/models/dependency.ts tests/dependency.test.ts
git commit -m "feat(dependencies): parent/child blocking with resolution"
```

---

## Chunk 3: Harness Profiles

### Task 7: Profile Loading and Validation

**Files:**
- Create: `src/profiles.ts`
- Create: `tests/profiles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/profiles.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadProfiles, getProfile, substituteCommand } from "../src/profiles";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const TEST_CONFIG_DIR = "/tmp/kdi-test-config";

describe("profiles", () => {
  beforeEach(() => {
    try { rmSync(TEST_CONFIG_DIR, { recursive: true }); } catch {}
    mkdirSync(`${TEST_CONFIG_DIR}/kdi`, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_CONFIG_DIR, { recursive: true }); } catch {}
  });

  it("loads built-in profiles when file is missing", () => {
    const profiles = loadProfiles(`${TEST_CONFIG_DIR}/kdi/empty.yaml`);
    expect(profiles.opencode).toBeDefined();
    expect(profiles.claude).toBeDefined();
    expect(profiles.codex).toBeDefined();
    expect(profiles.pi).toBeDefined();
  });

  it("loads custom profiles from YAML", () => {
    writeFileSync(`${TEST_CONFIG_DIR}/kdi/profiles.yaml`, `
opencode:
  command: "opencode run --agent {{agent}} --cwd {{workdir}}"
  env:
    OPENAI_API_KEY: "test"
    `);
    
    const profiles = loadProfiles(`${TEST_CONFIG_DIR}/kdi/profiles.yaml`);
    expect(profiles.opencode.command).toBe("opencode run --agent {{agent}} --cwd {{workdir}}");
    expect(profiles.opencode.env).toEqual({ OPENAI_API_KEY: "test" });
  });

  it("substitutes template variables", () => {
    const cmd = substituteCommand("opencode run --cwd {{workdir}} --branch {{branch}}", {
      workdir: "/tmp/proj",
      branch: "feature-x",
      task_id: "42",
      agent: "default",
    });
    expect(cmd).toBe("opencode run --cwd /tmp/proj --branch feature-x");
  });

  it("throws for unknown profile", () => {
    const profiles = loadProfiles(`${TEST_CONFIG_DIR}/kdi/profiles.yaml`);
    expect(() => getProfile("unknown")).toThrow("Unknown profile: unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/profiles.test.ts`

Expected: FAIL with "Cannot find module '../src/profiles'"

- [ ] **Step 3: Implement the profile system**

Create `src/profiles.ts`:

```typescript
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import YAML from "yaml";

export interface Profile {
  name: string;
  command: string;
  env?: Record<string, string>;
  agent?: string;
}

const BUILT_IN_PROFILES: Record<string, Profile> = {
  opencode: {
    name: "opencode",
    command: "opencode run --agent {{agent}} --cwd {{workdir}}",
  },
  claude: {
    name: "claude",
    command: "claude --cwd {{workdir}}",
  },
  codex: {
    name: "codex",
    command: "codex --cwd {{workdir}}",
  },
  pi: {
    name: "pi",
    command: "pi run --cwd {{workdir}}",
  },
};

let profileCache: Record<string, Profile> | null = null;

export function loadProfiles(path: string = defaultProfilePath()): Record<string, Profile> {
  if (profileCache) return profileCache;
  
  if (!existsSync(path)) {
    profileCache = { ...BUILT_IN_PROFILES };
    return profileCache;
  }
  
  const content = readFileSync(path, "utf-8");
  const parsed = YAML.parse(content) || {};
  
  profileCache = {};
  for (const [name, config] of Object.entries(parsed)) {
    const p = config as any;
    if (!p.command) throw new Error(`Profile ${name} missing required 'command' field`);
    profileCache[name] = {
      name,
      command: p.command,
      env: p.env,
      agent: p.agent,
    };
  }
  
  return profileCache;
}

export function getProfile(name: string): Profile {
  if (!profileCache) loadProfiles();
  const profile = profileCache![name];
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  return profile;
}

export function substituteCommand(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export function clearProfileCache(): void {
  profileCache = null;
}

function defaultProfilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dir = `${home}/.config/kdi`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return `${dir}/profiles.yaml`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/profiles.test.ts`

Expected: PASS (4/4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/profiles.ts tests/profiles.test.ts
git commit -m "feat(profiles): YAML profile loading with template substitution"
```

---

## Chunk 4: CLI Commands

### Task 8: CLI Entry Point and Board Commands

**Files:**
- Create: `src/commands/boards.ts`
- Modify: `src/index.ts` (create it)
- Test: Manual CLI invocation

- [ ] **Step 1: Create the boards command handler**

Create `src/commands/boards.ts`:

```typescript
import { Command } from "commander";
import { createBoard, listBoards, showBoard, archiveBoard } from "../models/board";
import { initDb } from "../db";

export function registerBoardCommands(program: Command): void {
  const boards = program.command("boards").description("Board management");
  
  boards
    .command("create <slug>")
    .description("Create a new board")
    .requiredOption("--workdir <path>", "Working directory for the board")
    .action((slug: string, options: { workdir: string }) => {
      initDb();
      const board = createBoard(slug, options.workdir);
      console.log(`Created board ${board.slug} (id: ${board.id})`);
    });
  
  boards
    .command("list")
    .description("List all boards")
    .action(() => {
      initDb();
      const boards = listBoards();
      if (boards.length === 0) {
        console.log("No boards found");
        return;
      }
      for (const b of boards) {
        console.log(`${b.slug}\t${b.workdir}`);
      }
    });
  
  boards
    .command("show <slug>")
    .description("Show board details")
    .action((slug: string) => {
      initDb();
      const info = showBoard(slug);
      console.log(`Board: ${info.slug}`);
      console.log(`Workdir: ${info.workdir}`);
      console.log("Task counts:");
      for (const [status, count] of Object.entries(info.task_counts)) {
        console.log(`  ${status}: ${count}`);
      }
    });
  
  boards
    .command("archive <slug>")
    .description("Archive a board")
    .action((slug: string) => {
      initDb();
      archiveBoard(slug);
      console.log(`Archived board ${slug}`);
    });
}
```

- [ ] **Step 2: Create the CLI entry point**

Create `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from "commander";
import { registerBoardCommands } from "./commands/boards";

const program = new Command();

program
  .name("kdi")
  .description("Multi-Agent Kanban Dispatch")
  .version("0.1.0");

registerBoardCommands(program);

program.parse();
```

- [ ] **Step 3: Test CLI commands**

Run: `bun run src/index.ts --version`

Expected: `0.1.0`

Run: `bun run src/index.ts boards create myproj --workdir /tmp/myproj`

Expected: `Created board myproj (id: 1)`

Run: `bun run src/index.ts boards list`

Expected: `myproj\t/tmp/myproj`

- [ ] **Step 4: Commit**

```bash
git add src/commands/boards.ts src/index.ts
git commit -m "feat(cli): board commands and entry point"
```

---

### Task 9: Task Commands

**Files:**
- Create: `src/commands/tasks.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the tasks command handler**

Create `src/commands/tasks.ts`:

```typescript
import { Command } from "commander";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  blockTask,
  unblockTask,
  archiveTask,
} from "../models/task";
import { addComment, getComments } from "../models/comment";
import { initDb } from "../db";

export function registerTaskCommands(program: Command): void {
  program
    .command("create <title>")
    .description("Create a new task")
    .requiredOption("--board <slug>", "Board slug")
    .option("--assignee <profile>", "Harness profile")
    .option("--body <text>", "Task body")
    .option("--priority <level>", "Priority (low/medium/high)")
    .action((title: string, options: any) => {
      initDb();
      const task = createTask({
        boardSlug: options.board,
        title,
        assignee: options.assignee,
        body: options.body,
        priority: options.priority,
      });
      console.log(task.id);
    });
  
  program
    .command("list")
    .description("List tasks")
    .requiredOption("--board <slug>", "Board slug")
    .option("--status <status>", "Filter by status")
    .option("--assignee <profile>", "Filter by assignee")
    .action((options: any) => {
      initDb();
      const tasks = listTasks({
        boardSlug: options.board,
        status: options.status,
        assignee: options.assignee,
      });
      for (const t of tasks) {
        console.log(`${t.id}\t${t.status}\t${t.title}`);
      }
    });
  
  program
    .command("show <task_id>")
    .description("Show task details")
    .action((taskId: string) => {
      initDb();
      const task = showTask(parseInt(taskId));
      const comments = getComments(task.id);
      console.log(`Task #${task.id}: ${task.title}`);
      console.log(`Status: ${task.status}`);
      console.log(`Assignee: ${task.assignee ?? "unassigned"}`);
      if (task.body) console.log(`Body: ${task.body}`);
      if (task.block_reason) console.log(`Blocked: ${task.block_reason}`);
      if (task.result) console.log(`Result: ${task.result}`);
      if (comments.length > 0) {
        console.log("Comments:");
        for (const c of comments) {
          console.log(`  [${new Date(c.created_at * 1000).toISOString()}] ${c.text}`);
        }
      }
    });
  
  program
    .command("edit <task_id>")
    .description("Edit task body")
    .requiredOption("--body <text>", "New body")
    .action((taskId: string, options: any) => {
      initDb();
      editTask(parseInt(taskId), options.body);
      console.log(`Updated task ${taskId}`);
    });
  
  program
    .command("comment <task_id> <text>")
    .description("Add a comment")
    .action((taskId: string, text: string) => {
      initDb();
      addComment(parseInt(taskId), text);
      console.log(`Comment added to task ${taskId}`);
    });
  
  program
    .command("promote <task_id>")
    .description("Promote task to ready")
    .action((taskId: string) => {
      initDb();
      promoteTask(parseInt(taskId));
      console.log(`Promoted task ${taskId} to ready`);
    });
  
  program
    .command("block <task_id>")
    .description("Block a task")
    .requiredOption("--reason <text>", "Block reason")
    .action((taskId: string, options: any) => {
      initDb();
      blockTask(parseInt(taskId), options.reason);
      console.log(`Blocked task ${taskId}`);
    });
  
  program
    .command("unblock <task_id>")
    .description("Unblock a task")
    .action((taskId: string) => {
      initDb();
      unblockTask(parseInt(taskId));
      console.log(`Unblocked task ${taskId}`);
    });
  
  program
    .command("archive <task_id>")
    .description("Archive a task")
    .action((taskId: string) => {
      initDb();
      archiveTask(parseInt(taskId));
      console.log(`Archived task ${taskId}`);
    });
}
```

- [ ] **Step 2: Wire into entry point**

Modify `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from "commander";
import { registerBoardCommands } from "./commands/boards";
import { registerTaskCommands } from "./commands/tasks";

const program = new Command();

program
  .name("kdi")
  .description("Multi-Agent Kanban Dispatch")
  .version("0.1.0");

registerBoardCommands(program);
registerTaskCommands(program);

program.parse();
```

- [ ] **Step 3: Test task commands**

Run: `bun run src/index.ts create "backend: auth" --board myproj --assignee opencode`

Expected: `1` (task ID)

Run: `bun run src/index.ts show 1`

Expected: Task details with title "backend: auth"

- [ ] **Step 4: Commit**

```bash
git add src/commands/tasks.ts src/index.ts
git commit -m "feat(cli): all task lifecycle commands"
```

---

## Chunk 5: Dispatcher, Worktree, and Observability

### Task 10: Git Worktree Operations

**Files:**
- Create: `src/worktree.ts`
- Create: `tests/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worktree.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createWorktree, removeWorktree } from "../src/worktree";
import { mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("worktree", () => {
  let repoDir: string;
  
  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "kdi-repo-"));
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test'", { cwd: repoDir });
    execSync("echo 'hello' > file.txt && git add . && git commit -m 'init'", { cwd: repoDir });
  });
  
  afterAll(() => {
    rmSync(repoDir, { recursive: true });
  });

  it("creates a worktree branch", () => {
    const workdir = createWorktree(repoDir, "opencode", "42");
    expect(workdir).toContain("wt/opencode/42");
    
    // Verify branch exists
    const branches = execSync("git branch -a", { cwd: repoDir }).toString();
    expect(branches).toContain("wt/opencode/42");
    
    removeWorktree(repoDir, "opencode", "42");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worktree.test.ts`

Expected: FAIL with "Cannot find module '../src/worktree'"

- [ ] **Step 3: Implement worktree operations**

Create `src/worktree.ts`:

```typescript
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export function createWorktree(repoDir: string, profile: string, taskId: string): string {
  const branch = `wt/${profile}/${taskId}`;
  const worktreePath = join(repoDir, ".git", "worktrees", taskId);
  
  // Ensure base branch exists (default origin/main, fallback to main)
  try {
    execSync("git rev-parse --verify origin/main", { cwd: repoDir, stdio: "pipe" });
  } catch {
    // origin/main doesn't exist, use current HEAD
  }
  
  execSync(`git branch -f ${branch} origin/main 2>/dev/null || git branch -f ${branch} HEAD`, { cwd: repoDir });
  execSync(`git worktree add ${worktreePath} ${branch}`, { cwd: repoDir });
  
  return worktreePath;
}

export function removeWorktree(repoDir: string, profile: string, taskId: string): void {
  const branch = `wt/${profile}/${taskId}`;
  const worktreePath = join(repoDir, ".git", "worktrees", taskId);
  
  try {
    execSync(`git worktree remove ${worktreePath} --force`, { cwd: repoDir });
  } catch {
    // Worktree may already be removed
  }
  
  try {
    execSync(`git branch -D ${branch}`, { cwd: repoDir });
  } catch {
    // Branch may already be deleted
  }
  
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/worktree.test.ts`

Expected: PASS (1/1 test)

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts tests/worktree.test.ts
git commit -m "feat(worktree): git worktree creation and cleanup"
```

---

### Task 11: Dispatcher Loop

**Files:**
- Create: `src/dispatcher.ts`
- Create: `tests/dispatcher.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/dispatcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask, promoteTask } from "../src/models/task";
import { tick } from "../src/dispatcher";
import { rmSync } from "node:fs";

const TEST_DB = "/tmp/kdi-dispatch-test.db";

describe("dispatcher", () => {
  beforeEach(() => {
    try { rmSync(TEST_DB); } catch {}
    initDb(TEST_DB);
    createBoard("myproj", "/tmp/myproj");
  });

  afterEach(() => {
    closeDb();
    try { rmSync(TEST_DB); } catch {}
  });

  it("claims and dispatches a ready task", async () => {
    const task = createTask({ boardSlug: "myproj", title: "t1", assignee: "opencode" });
    promoteTask(task.id);
    
    let claimed = false;
    await tick({
      spawnHarness: async (cmd, cwd, env) => {
        claimed = true;
        return { stdout: "done", stderr: "", exitCode: 0 };
      },
    });
    
    expect(claimed).toBe(true);
  });

  it("skips tasks with unresolved dependencies", async () => {
    const parent = createTask({ boardSlug: "myproj", title: "parent", assignee: "opencode" });
    const child = createTask({ boardSlug: "myproj", title: "child", assignee: "opencode" });
    promoteTask(child.id);
    
    // Add dependency
    const db = (await import("../src/db")).getDb();
    db.prepare("INSERT INTO dependencies (parent_id, child_id) VALUES (?, ?)").run(parent.id, child.id);
    
    let claimed = false;
    await tick({
      spawnHarness: async () => {
        claimed = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    
    expect(claimed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/dispatcher.test.ts`

Expected: FAIL with "Cannot find module '../src/dispatcher'"

- [ ] **Step 3: Implement the dispatcher**

Create `src/dispatcher.ts`:

```typescript
import { getDb } from "./db";
import { getProfile, substituteCommand } from "./profiles";
import { createWorktree, removeWorktree } from "./worktree";
import { showBoard } from "./models/board";
import { isEnabled } from "./flags";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

export interface HarnessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TickOptions {
  spawnHarness?: (command: string, cwd: string, env: Record<string, string>) => Promise<HarnessResult>;
}

export async function tick(options: TickOptions = {}): Promise<void> {
  if (!isEnabled("FF_ENABLE_KANBAN_DISPATCH")) return;
  
  const db = getDb();
  
  // Find all ready tasks, ordered by creation time
  const tasks = db.query(`
    SELECT t.*, b.slug as board_slug, b.workdir as board_workdir
    FROM tasks t
    JOIN boards b ON t.board_id = b.id
    WHERE t.status = 'ready' AND t.archived_at IS NULL
    ORDER BY t.created_at ASC
  `).all() as any[];
  
  for (const task of tasks) {
    // Check dependencies
    const depRow = db.query(`
      SELECT COUNT(*) as count FROM dependencies d
      JOIN tasks t ON d.parent_id = t.id
      WHERE d.child_id = ? AND t.status != 'done'
    `).get(task.id) as { count: number };
    
    if (depRow.count > 0) continue;
    
    // CAS: try to claim task (ready -> running)
    const claim = db.prepare("UPDATE tasks SET status = 'running', updated_at = unixepoch() WHERE id = ? AND status = 'ready'").run(task.id);
    if (claim.changes === 0) continue; // Another dispatcher claimed it
    
    // Resolve profile and spawn
    try {
      const profile = getProfile(task.assignee);
      const workdir = createWorktree(task.board_workdir, profile.name, String(task.id));
      
      const command = substituteCommand(profile.command, {
        workdir,
        branch: task.branch ?? "main",
        task_id: String(task.id),
        agent: profile.agent ?? "default",
      });
      
      const result = options.spawnHarness
        ? await options.spawnHarness(command, workdir, profile.env || {})
        : await defaultSpawnHarness(command, workdir, profile.env || {});
      
      // Update task with result
      const newStatus = result.exitCode === 0 ? "done" : "blocked";
      db.prepare(`
        UPDATE tasks 
        SET status = ?, result = ?, summary = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(
        newStatus,
        result.stdout,
        result.exitCode === 0 ? "completed" : `failed with exit code ${result.exitCode}: ${result.stderr}`,
        task.id
      );
      
      removeWorktree(task.board_workdir, profile.name, String(task.id));
    } catch (err: any) {
      db.prepare("UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = unixepoch() WHERE id = ?").run(
        err.message,
        task.id
      );
    }
  }
}

function defaultSpawnHarness(command: string, cwd: string, env: Record<string, string>): Promise<HarnessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });
    
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

export function startDispatcher(pollIntervalMs: number = 5000): { stop: () => void } {
  let running = true;
  
  async function loop() {
    while (running) {
      try {
        await tick();
      } catch (err) {
        console.error("Dispatcher tick failed:", err);
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }
  
  loop();
  
  return {
    stop: () => { running = false; }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/dispatcher.test.ts`

Expected: PASS (2/2 tests)

- [ ] **Step 5: Wire dispatch command into CLI**

Modify `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from "commander";
import { registerBoardCommands } from "./commands/boards";
import { registerTaskCommands } from "./commands/tasks";
import { registerDispatchCommand } from "./commands/dispatch";

const program = new Command();

program
  .name("kdi")
  .description("Multi-Agent Kanban Dispatch")
  .version("0.1.0");

registerBoardCommands(program);
registerTaskCommands(program);
registerDispatchCommand(program);

program.parse();
```

Create `src/commands/dispatch.ts`:

```typescript
import { Command } from "commander";
import { startDispatcher } from "../dispatcher";
import { initDb } from "../db";
import { isEnabled, setFlag } from "../flags";

export function registerDispatchCommand(program: Command): void {
  program
    .command("dispatch")
    .description("Start the background task dispatcher")
    .option("--interval <ms>", "Poll interval in milliseconds", "5000")
    .action((options: any) => {
      initDb();
      setFlag("FF_ENABLE_KANBAN_DISPATCH", true);
      
      const interval = parseInt(options.interval);
      console.log(`Starting dispatcher (interval: ${interval}ms)...`);
      
      const dispatcher = startDispatcher(interval);
      
      process.on("SIGINT", () => {
        console.log("\nStopping dispatcher...");
        dispatcher.stop();
        process.exit(0);
      });
      
      process.on("SIGTERM", () => {
        dispatcher.stop();
        process.exit(0);
      });
    });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/dispatcher.ts tests/dispatcher.test.ts src/commands/dispatch.ts src/index.ts
git commit -m "feat(dispatcher): background polling with CAS claim and harness spawn"
```

---

### Task 12: Observability

**Files:**
- Create: `src/observability.ts`
- Modify: `src/dispatcher.ts` (add metrics hooks)

- [ ] **Step 1: Write the failing test**

Create `tests/observability.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { recordTick, recordClaim, recordTaskDuration, getMetrics, resetMetrics } from "../src/observability";

describe("observability", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("records dispatcher ticks", () => {
    recordTick();
    recordTick();
    const m = getMetrics();
    expect(m.ticks).toBe(2);
  });

  it("records claim success/failure", () => {
    recordClaim(true);
    recordClaim(false);
    const m = getMetrics();
    expect(m.claims.success).toBe(1);
    expect(m.claims.failure).toBe(1);
  });

  it("records task durations per agent", () => {
    recordTaskDuration("opencode", 1000);
    recordTaskDuration("opencode", 2000);
    const m = getMetrics();
    expect(m.agents.opencode.count).toBe(2);
    expect(m.agents.opencode.totalDuration).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/observability.test.ts`

Expected: FAIL with "Cannot find module '../src/observability'"

- [ ] **Step 3: Implement observability**

Create `src/observability.ts`:

```typescript
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface AgentMetrics {
  count: number;
  totalDuration: number;
  errors: number;
}

interface Metrics {
  ticks: number;
  claims: { success: number; failure: number };
  agents: Record<string, AgentMetrics>;
  taskAges: number[];
}

let metrics: Metrics = {
  ticks: 0,
  claims: { success: 0, failure: 0 },
  agents: {},
  taskAges: [],
};

export function recordTick(): void {
  metrics.ticks++;
}

export function recordClaim(success: boolean): void {
  if (success) metrics.claims.success++;
  else metrics.claims.failure++;
}

export function recordTaskDuration(agent: string, durationMs: number): void {
  if (!metrics.agents[agent]) {
    metrics.agents[agent] = { count: 0, totalDuration: 0, errors: 0 };
  }
  metrics.agents[agent].count++;
  metrics.agents[agent].totalDuration += durationMs;
}

export function recordAgentError(agent: string): void {
  if (!metrics.agents[agent]) {
    metrics.agents[agent] = { count: 0, totalDuration: 0, errors: 0 };
  }
  metrics.agents[agent].errors++;
}

export function recordTaskAge(ageMs: number): void {
  metrics.taskAges.push(ageMs);
  // Keep last 1000 ages
  if (metrics.taskAges.length > 1000) {
    metrics.taskAges = metrics.taskAges.slice(-1000);
  }
}

export function getMetrics(): Metrics {
  return { ...metrics };
}

export function resetMetrics(): void {
  metrics = {
    ticks: 0,
    claims: { success: 0, failure: 0 },
    agents: {},
    taskAges: [],
  };
}

export function getLogPath(boardSlug: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dir = `${home}/.local/share/kdi/logs`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/${boardSlug}.log`;
}

export function logToBoard(boardSlug: string, message: string): void {
  const path = getLogPath(boardSlug);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  // Append using Bun's file API for atomic writes
  const file = Bun.file(path);
  // Note: In production, use proper file append. This is simplified.
  Bun.write(path, file.size > 0 ? Bun.file(path).text() + line : line);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/observability.test.ts`

Expected: PASS (3/3 tests)

- [ ] **Step 5: Integrate metrics into dispatcher**

Modify `src/dispatcher.ts` to import and use observability:

Add imports at top:
```typescript
import { recordTick, recordClaim, recordTaskDuration, recordAgentError, recordTaskAge, logToBoard } from "./observability";
```

In the `tick` function, add at the top:
```typescript
recordTick();
```

After CAS claim:
```typescript
if (claim.changes === 0) {
  recordClaim(false);
  continue;
}
recordClaim(true);
```

Before spawning, record age:
```typescript
const ageMs = Date.now() - task.created_at * 1000;
recordTaskAge(ageMs);
```

After harness completes:
```typescript
const durationMs = Date.now() - startTime;
recordTaskDuration(profile.name, durationMs);
if (result.exitCode !== 0) {
  recordAgentError(profile.name);
}
logToBoard(task.board_slug, `Task ${task.id} ${newStatus} (${durationMs}ms)`);
```

- [ ] **Step 6: Commit**

```bash
git add src/observability.ts tests/observability.test.ts src/dispatcher.ts
git commit -m "feat(observability): metrics collection and board logging"
```

---

## Chunk 6: Integration and Polish

### Task 13: Database Path Resolution

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Update initDb to support default path**

Modify `src/db.ts` to add default path resolution:

```typescript
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function defaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dir = `${home}/.local/share/kdi`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/kdi.db`;
}
```

Update `initDb` signature:
```typescript
export function initDb(path?: string): Database {
  if (dbInstance) return dbInstance;
  const dbPath = path || defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  dbInstance = new Database(dbPath, { create: true });
  // ... rest unchanged
}
```

- [ ] **Step 2: Test default path**

Run: `bun test tests/db.test.ts`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): default database path in ~/.local/share/kdi"
```

---

### Task 14: End-to-End Acceptance Test

**Files:**
- Create: `tests/e2e.test.ts`

- [ ] **Step 1: Write the E2E test**

Create `tests/e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = "/tmp/kdi-e2e.db";
const CLI = "bun run src/index.ts";

describe("e2e", () => {
  let repoDir: string;
  
  beforeAll(() => {
    try { rmSync(TEST_DB); } catch {}
    repoDir = mkdtempSync(join(tmpdir(), "kdi-e2e-repo-"));
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test'", { cwd: repoDir });
    execSync("echo 'hello' > file.txt && git add . && git commit -m 'init'", { cwd: repoDir });
  });
  
  afterAll(() => {
    try { rmSync(TEST_DB); } catch {}
    try { rmSync(repoDir, { recursive: true }); } catch {}
  });

  it("full task lifecycle", () => {
    // Create board
    const boardOut = execSync(`${CLI} boards create e2e --workdir ${repoDir}`, { env: { ...process.env, KDI_DB: TEST_DB } }).toString();
    expect(boardOut).toContain("Created board e2e");
    
    // Create task
    const taskId = execSync(`${CLI} create "backend: auth" --board e2e --assignee opencode`, { env: { ...process.env, KDI_DB: TEST_DB } }).toString().trim();
    expect(parseInt(taskId)).toBeGreaterThan(0);
    
    // Show task
    const showOut = execSync(`${CLI} show ${taskId}`, { env: { ...process.env, KDI_DB: TEST_DB } }).toString();
    expect(showOut).toContain("backend: auth");
    expect(showOut).toContain("Status: todo");
    
    // Promote
    execSync(`${CLI} promote ${taskId}`, { env: { ...process.env, KDI_DB: TEST_DB } });
    
    // Show again
    const showReady = execSync(`${CLI} show ${taskId}`, { env: { ...process.env, KDI_DB: TEST_DB } }).toString();
    expect(showReady).toContain("Status: ready");
  });

  it("version returns semantic version", () => {
    const version = execSync(`${CLI} --version`).toString().trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 2: Add KDI_DB support to db.ts**

Modify `src/db.ts` defaultDbPath:

```typescript
export function defaultDbPath(): string {
  if (process.env.KDI_DB) return process.env.KDI_DB;
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dir = `${home}/.local/share/kdi`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/kdi.db`;
}
```

- [ ] **Step 3: Run E2E test**

Run: `bun test tests/e2e.test.ts`

Expected: PASS (2/2 tests)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e.test.ts src/db.ts
git commit -m "test(e2e): full lifecycle acceptance tests"
```

---

## Execution Order

**Sequential (dependencies exist):**
1. Task 1 (DB) → Task 2 (Flags) → Task 3 (Boards) → Task 4 (Tasks) → Task 5 (Comments) → Task 6 (Dependencies)

**Parallel-safe (no shared state, but require core models):**
- Task 7 (Profiles) can start after Task 1
- Task 10 (Worktree) can start after Task 1

**Sequential (require multiple subsystems):**
- Task 8-9 (CLI) after Tasks model
- Task 11 (Dispatcher) after Tasks, Dependencies, Profiles, Worktree
- Task 12 (Observability) after Dispatcher

**Final integration:**
- Task 13 (DB path polish)
- Task 14 (E2E)

---

## Agent Dispatch Strategy

**Use superpowers:subagent-driven-development with the following dispatch plan:**

1. **Dispatch Chunk 1 sequentially** - DB and Flags are foundation, must be stable
2. **Dispatch Chunk 2 sequentially** - Models build on DB
3. **Dispatch Chunk 3 in parallel with Chunk 2** - Profiles are independent
4. **Dispatch Chunk 4 after Chunk 2** - CLI needs models
5. **Dispatch Chunk 5 after Chunks 2, 3, and Worktree** - Dispatcher integrates everything
6. **Dispatch Chunk 6 last** - Integration and E2E

For maximum parallelism, dispatch these groups concurrently once their prerequisites are done:
- Group A: Task 1 + Task 2 (foundation)
- Group B: Task 3 + Task 4 + Task 5 + Task 6 (models) — after Group A
- Group C: Task 7 (profiles) + Task 10 (worktree) — after Group A
- Group D: Task 8 + Task 9 (CLI) — after Group B
- Group E: Task 11 (dispatcher) — after Groups B, C
- Group F: Task 12 (observability) — after Group E
- Group G: Task 13 + Task 14 (polish) — after all above

**Per task:** Fresh implementer subagent → spec reviewer → code quality reviewer → mark complete.
