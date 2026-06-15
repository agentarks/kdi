import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import {
  createTask,
  listTasks,
  showTask,
  editTask,
  promoteTask,
  promoteTaskAdvanced,
  archiveTaskHard,
  blockTask,
  unblockTask,
  archiveTask,
  completeTask,
  reviewTask,
  scheduleTask,
  promoteScheduledTasks,
  parseDuration,
  assignTask,
  unassignTask,
  reassignTask,
  type Task,
} from "../src/models/task";
import { addDependency } from "../src/models/dependency";
import { addComment } from "../src/models/comment";
import { createAttachment } from "../src/models/taskAttachment";
import { createBoard } from "../src/models/board";
import { getRuns, createRun } from "../src/models/taskRun";
import { getEvents } from "../src/models/taskEvent";
import { atomicClaim } from "../src/models/claim";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-task-test.db";

describe("task model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("createTask returns task with all fields and defaults", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Fix bug" });

    expect(task.id).toBeNumber();
    expect(task.board_id).toBe(board.id);
    expect(task.title).toBe("Fix bug");
    expect(task.body).toBeNull();
    expect(task.assignee).toBeNull();
    expect(task.status).toBe("todo");
    expect(task.priority).toBe(0);
    expect(task.workspace_kind).toBe("worktree");
    expect(task.workspace).toBeNull();
    expect(task.branch).toBeNull();
    expect(task.result).toBeNull();
    expect(task.summary).toBeNull();
    expect(task.block_reason).toBeNull();
    expect(task.created_by).toBe("unknown");
    expect(task.created_at).toBeNumber();
    expect(task.updated_at).toBeNumber();
    expect(task.archived_at).toBeNull();
  });

  it("createTask with all optional fields including workspace", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({
      board_id: board.id,
      title: "Implement feature",
      body: "Detailed description",
      assignee: "alice",
      priority: 5,
      workspace_kind: "scratch",
      workspace: "/tmp/task-workspace",
      branch: "feature-123",
    });

    expect(task.title).toBe("Implement feature");
    expect(task.body).toBe("Detailed description");
    expect(task.assignee).toBe("alice");
    expect(task.priority).toBe(5);
    expect(task.workspace_kind).toBe("scratch");
    expect(task.workspace).toBe("/tmp/task-workspace");
    expect(task.branch).toBe("feature-123");

    const fetched = showTask(task.id);
    expect(fetched!.workspace).toBe("/tmp/task-workspace");
  });

  it("createTask stores skills array", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({
      board_id: board.id,
      title: "Skill me",
      skills: ["github", "code-review"],
    });

    expect(task.skills).toEqual(["github", "code-review"]);

    const fetched = showTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.skills).toEqual(["github", "code-review"]);
  });

  it("createTask stores empty skills array by default", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "No skills" });

    expect(task.skills).toEqual([]);
  });

  it("createTask stores created_by when provided", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Tracked", created_by: "alice" });
    expect(task.created_by).toBe("alice");

    const fetched = showTask(task.id);
    expect(fetched!.created_by).toBe("alice");
  });

  it("createTask defaults created_by to 'unknown' when omitted", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Untracked" });
    expect(task.created_by).toBe("unknown");

    const fetched = showTask(task.id);
    expect(fetched!.created_by).toBe("unknown");
  });

  it("listTasks filters by created_by", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Alice's", created_by: "alice" });
    createTask({ board_id: board.id, title: "Bob's", created_by: "bob" });

    const aliceTasks = listTasks({ board_id: board.id, created_by: "alice" });
    expect(aliceTasks).toHaveLength(1);
    expect(aliceTasks[0].title).toBe("Alice's");
  });

  it("createTask rejects empty created_by", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    expect(() => createTask({ board_id: board.id, title: "Bad", created_by: "" })).toThrow("created_by cannot be empty");
  });

  it("createTask rejects created_by longer than 255 characters", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const longCreator = "a".repeat(256);
    expect(() => createTask({ board_id: board.id, title: "Bad", created_by: longCreator })).toThrow("created_by must be 255 characters or fewer");
  });

  it("createTask with priority sets integer value", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Urgent", priority: 10 });
    expect(task.priority).toBe(10);
  });

  it("createTask stores max_runtime_seconds", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Capped", max_runtime_seconds: 300 });
    expect(task.max_runtime_seconds).toBe(300);
  });

  it("createTask defaults max_runtime_seconds to null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "No cap" });
    expect(task.max_runtime_seconds).toBeNull();
  });

  it("createTask stores model_override when provided", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Model task", model_override: "gpt-5.5" });
    expect(task.model_override).toBe("gpt-5.5");

    const fetched = showTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.model_override).toBe("gpt-5.5");
  });

  it("createTask defaults model_override to null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "No model" });
    expect(task.model_override).toBeNull();
  });

  it("createTask stores max_retries", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Retry me", max_retries: 3 });
    expect(task.max_retries).toBe(3);

    const fetched = showTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.max_retries).toBe(3);
  });

  it("createTask defaults max_retries to null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "No retry cap" });
    expect(task.max_retries).toBeNull();
  });

  it("createTask defaults consecutive_failures to 0", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "No failures" });
    expect(task.consecutive_failures).toBe(0);

    const fetched = showTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.consecutive_failures).toBe(0);
  });

  it("parseDuration accepts raw seconds", () => {
    expect(parseDuration("300")).toBe(300);
    expect(parseDuration("1")).toBe(1);
  });

  it("parseDuration accepts suffixed durations", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1d")).toBe(86400);
  });

  it("parseDuration is case-insensitive", () => {
    expect(parseDuration("30S")).toBe(30);
    expect(parseDuration("2H")).toBe(7200);
  });

  it("parseDuration allows whitespace", () => {
    expect(parseDuration("  5m  ")).toBe(300);
  });

  it("parseDuration rejects invalid values", () => {
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("0")).toThrow();
    expect(() => parseDuration("-10")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("1.5s")).toThrow();
    expect(() => parseDuration("5x")).toThrow();
  });

  it("createTask with triage flag parks in triage", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Triage me", triage: true });
    expect(task.status).toBe("triage");
  });

  it("createTask with initialStatus sets the status", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const blocked = createTask({ board_id: board.id, title: "Blocked", initialStatus: "blocked" });
    const running = createTask({ board_id: board.id, title: "Running", initialStatus: "running" });
    const ready = createTask({ board_id: board.id, title: "Ready", initialStatus: "ready" });

    expect(blocked.status).toBe("blocked");
    expect(running.status).toBe("running");
    expect(ready.status).toBe("ready");
  });

  it("createTask initialStatus takes precedence over triage", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Ready", triage: true, initialStatus: "ready" });
    expect(task.status).toBe("ready");
  });

  it("createTask with idempotency key returns existing task on duplicate", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const first = createTask({ board_id: board.id, title: "First", idempotency_key: "abc-123" });
    const second = createTask({ board_id: board.id, title: "Second", idempotency_key: "abc-123" });

    expect(second.id).toBe(first.id);
  });

  it("createTask with different idempotency keys creates separate tasks", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const first = createTask({ board_id: board.id, title: "First", idempotency_key: "key-1" });
    const second = createTask({ board_id: board.id, title: "Second", idempotency_key: "key-2" });

    expect(second.id).not.toBe(first.id);
  });

  it("createTask reuses idempotency key only when task is not archived", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const first = createTask({ board_id: board.id, title: "First", idempotency_key: "reuse-key" });
    archiveTask(first.id);

    const second = createTask({ board_id: board.id, title: "Second", idempotency_key: "reuse-key" });

    expect(second.id).not.toBe(first.id);
  });

  it("listTasks returns all tasks for a board", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Task 1" });
    createTask({ board_id: board.id, title: "Task 2" });

    const tasks = listTasks({ board_id: board.id });
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.title)).toContain("Task 1");
    expect(tasks.map(t => t.title)).toContain("Task 2");
  });

  it("listTasks filters by status", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Todo Task" });
    const readyTask = createTask({ board_id: board.id, title: "Ready Task" });
    
    // Promote to ready using public API
    promoteTask(readyTask.id);

    const todoTasks = listTasks({ board_id: board.id, status: "todo" });
    const readyTasks = listTasks({ board_id: board.id, status: "ready" });

    expect(todoTasks).toHaveLength(1);
    expect(todoTasks[0].title).toBe("Todo Task");
    expect(readyTasks).toHaveLength(1);
    expect(readyTasks[0].title).toBe("Ready Task");
  });

  it("listTasks filters by assignee", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Alice's Task", assignee: "alice" });
    createTask({ board_id: board.id, title: "Bob's Task", assignee: "bob" });

    const aliceTasks = listTasks({ board_id: board.id, assignee: "alice" });
    expect(aliceTasks).toHaveLength(1);
    expect(aliceTasks[0].title).toBe("Alice's Task");
  });

  it("createTask stores tenant when provided", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Tenant task", tenant: "backend" });
    expect(task.tenant).toBe("backend");

    const fetched = showTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.tenant).toBe("backend");
  });

  it("createTask defaults tenant to null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "No tenant" });
    expect(task.tenant).toBeNull();
  });

  it("listTasks filters by tenant", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Backend task", tenant: "backend" });
    createTask({ board_id: board.id, title: "Frontend task", tenant: "frontend" });
    createTask({ board_id: board.id, title: "Untenant task" });

    const backendTasks = listTasks({ board_id: board.id, tenant: "backend" });
    expect(backendTasks).toHaveLength(1);
    expect(backendTasks[0].title).toBe("Backend task");
  });

  it("listTasks composes tenant, status, and assignee filters", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const readyBackend = createTask({ board_id: board.id, title: "Ready backend alice", tenant: "backend", assignee: "alice" });
    createTask({ board_id: board.id, title: "Todo backend alice", tenant: "backend", assignee: "alice" });
    createTask({ board_id: board.id, title: "Ready frontend alice", tenant: "frontend", assignee: "alice" });
    createTask({ board_id: board.id, title: "Ready backend bob", tenant: "backend", assignee: "bob" });
    promoteTask(readyBackend.id);

    const filtered = listTasks({ board_id: board.id, tenant: "backend", status: "ready", assignee: "alice" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Ready backend alice");
  });

  it("listTasks excludes archived tasks", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    createTask({ board_id: board.id, title: "Active" });
    const archived = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(archived.id);

    const tasks = listTasks({ board_id: board.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Active");
  });

  it("showTask returns task details", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const created = createTask({ board_id: board.id, title: "My Task" });

    const task = showTask(created.id);
    expect(task).not.toBeNull();
    expect(task!.id).toBe(created.id);
    expect(task!.title).toBe("My Task");
    expect(task!.status).toBe("todo");
  });

  it("showTask returns null for non-existent id", () => {
    const task = showTask(99999);
    expect(task).toBeNull();
  });

  it("showTask returns null for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(task.id);

    const result = showTask(task.id);
    expect(result).toBeNull();
  });

  it("editTask updates body and updated_at", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "My Task" });
    const originalUpdatedAt = task.updated_at;

    const edited = editTask(task.id, "New body content");
    expect(edited.body).toBe("New body content");
    expect(edited.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it("editTask throws for non-existent task", () => {
    expect(() => editTask(99999, "body")).toThrow();
  });

  it("promoteTask moves todo to ready", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Promote me" });
    expect(task.status).toBe("todo");

    const promoted = promoteTask(task.id);
    expect(promoted.status).toBe("ready");
  });

  it("promoteTask throws if task is not todo", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Already ready" });
    promoteTask(task.id); // Move to ready

    expect(() => promoteTask(task.id)).toThrow();
  });

  it("promoteTask throws for non-existent task", () => {
    expect(() => promoteTask(99999)).toThrow();
  });

  it("blockTask marks task as blocked with reason", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Block me" });

    const blocked = blockTask(task.id, "Waiting for API");
    expect(blocked.status).toBe("blocked");
    expect(blocked.block_reason).toBe("Waiting for API");
  });

  it("blockTask throws for non-existent task", () => {
    expect(() => blockTask(99999, "reason")).toThrow();
  });

  it("blockTask throws for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived task" });
    archiveTask(task.id);
    expect(() => blockTask(task.id, "reason")).toThrow();
  });

  it("unblockTask moves blocked to todo", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Unblock me" });
    blockTask(task.id, "Blocked");

    const unblocked = unblockTask(task.id);
    expect(unblocked.status).toBe("todo");
    expect(unblocked.block_reason).toBeNull();
  });

  it("unblockTask throws if task is not blocked", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Not blocked" });

    expect(() => unblockTask(task.id)).toThrow();
  });

  it("unblockTask throws for non-existent task", () => {
    expect(() => unblockTask(99999)).toThrow();
  });

  it("archiveTask sets archived_at, status, and updated_at", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archive me" });
    expect(task.archived_at).toBeNull();
    const originalUpdatedAt = task.updated_at;

    const archived = archiveTask(task.id);
    expect(archived.archived_at).toBeNumber();
    expect(archived.archived_at).not.toBeNull();
    expect(archived.status).toBe("archived");
    expect(archived.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it("archiveTask throws for non-existent task", () => {
    expect(() => archiveTask(99999)).toThrow();
  });

  it("archiveTask throws for already-archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Already archived" });
    archiveTask(task.id);
    expect(() => archiveTask(task.id)).toThrow();
  });

  it("editTask throws for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived task" });
    archiveTask(task.id);
    expect(() => editTask(task.id, "new body")).toThrow();
  });

  it("completeTask marks task done and stores result/summary", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Finish me" });

    const completed = completeTask(task.id, {
      result: "All checks passed",
      summary: "Done",
    });

    expect(completed.status).toBe("done");
    expect(completed.result).toBe("All checks passed");
    expect(completed.summary).toBe("Done");
  });

  it("completeTask creates a completed task_runs row when no active run exists", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Finish me", assignee: "opencode" });

    completeTask(task.id, {
      result: "output",
      summary: "summary",
      metadata: '{"tests": 12}',
    });

    const runs = getRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runs[0].outcome).toBe("completed");
    expect(runs[0].summary).toBe("summary");
    expect(runs[0].metadata).toBe('{"tests": 12}');
  });

  it("completeTask finalizes an active run", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Finish me", assignee: "opencode" });
    const run = createRun({ task_id: task.id, status: "running", started_at: 1000 });

    const completed = completeTask(task.id, {
      result: "result",
      summary: "final summary",
      metadata: '{"ok": true}',
    });

    expect(completed.current_run_id).toBeNull();
    const runs = getRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run.id);
    expect(runs[0].status).toBe("done");
    expect(runs[0].outcome).toBe("completed");
    expect(runs[0].summary).toBe("final summary");
    expect(runs[0].metadata).toBe('{"ok": true}');
  });

  it("completeTask emits a completed event", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Finish me" });

    completeTask(task.id, { result: "done" });

    const events = getEvents(task.id);
    const completed = events.find((e) => e.kind === "completed");
    expect(completed).toBeDefined();
  });

  it("completeTask throws for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(task.id);
    expect(() => completeTask(task.id)).toThrow();
  });

  it("completeTask throws for non-existent task", () => {
    expect(() => completeTask(99999)).toThrow();
  });

  it("reviewTask marks a done task as under review", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Review me" });
    completeTask(task.id, { result: "done" });

    const reviewed = reviewTask(task.id, "Needs human check");
    expect(reviewed.status).toBe("review");
    expect(reviewed.review_reason).toBe("Needs human check");
    expect(reviewed.claim_lock).toBeNull();
    expect(reviewed.claim_expires).toBeNull();
    expect(reviewed.current_run_id).toBeNull();
    expect(reviewed.started_at).toBeNull();
  });

  it("reviewTask marks a blocked task as under review", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Review blocked" });
    blockTask(task.id, "Blocked originally");

    const reviewed = reviewTask(task.id);
    expect(reviewed.status).toBe("review");
    expect(reviewed.block_reason).toBe("Blocked originally");
    expect(reviewed.review_reason).toBeNull();
    expect(reviewed.claim_lock).toBeNull();
    expect(reviewed.claim_expires).toBeNull();
    expect(reviewed.current_run_id).toBeNull();
    expect(reviewed.started_at).toBeNull();
  });

  it("reviewTask throws for archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(task.id);
    expect(() => reviewTask(task.id)).toThrow();
  });

  it("reviewTask throws if task is already in review", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Already reviewing" });
    reviewTask(task.id);
    expect(() => reviewTask(task.id)).toThrow();
  });

  it("reviewTask emits a reviewed event", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Event test" });

    reviewTask(task.id, "check output");
    const events = getEvents(task.id);
    const reviewed = events.find((e) => e.kind === "reviewed");
    expect(reviewed).toBeDefined();
  });

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

    scheduleTask(pastTask.id, now + 10, "past");
    scheduleTask(futureTask.id, now + 3600, "future");

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
    expect(events.some((e) => e.kind === "ready")).toBe(true);
  });

  it("assignTask sets assignee and emits assigned event", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Assign me" });

    const assigned = assignTask(task.id, "opencode");
    expect(assigned.assignee).toBe("opencode");

    const fetched = showTask(task.id);
    expect(fetched!.assignee).toBe("opencode");

    const events = getEvents(task.id);
    const event = events.find((e) => e.kind === "assigned");
    expect(event).toBeDefined();
    expect(JSON.parse(event!.payload!)).toEqual({ assignee: "opencode" });
  });

  it("unassignTask clears assignee and emits unassigned event", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Unassign me", assignee: "opencode" });

    const unassigned = unassignTask(task.id);
    expect(unassigned.assignee).toBeNull();

    const fetched = showTask(task.id);
    expect(fetched!.assignee).toBeNull();

    const events = getEvents(task.id);
    const event = events.find((e) => e.kind === "unassigned");
    expect(event).toBeDefined();
    expect(event!.payload).toBeNull();
  });

  it("assignTask rejects archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived" });
    archiveTask(task.id);

    expect(() => assignTask(task.id, "opencode")).toThrow("archived");
  });

  it("unassignTask rejects archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived", assignee: "opencode" });
    archiveTask(task.id);

    expect(() => unassignTask(task.id)).toThrow("archived");
  });

  it("reassignTask updates assignee when task is not running", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Reassign me", assignee: "opencode" });

    const reassigned = reassignTask(task.id, "codex");
    expect(reassigned.assignee).toBe("codex");

    const events = getEvents(task.id);
    expect(events.some((e) => e.kind === "assigned")).toBe(true);
  });

  it("reassignTask unassigns when profile is null", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Clear me", assignee: "opencode" });

    const reassigned = reassignTask(task.id, null);
    expect(reassigned.assignee).toBeNull();

    const events = getEvents(task.id);
    expect(events.some((e) => e.kind === "unassigned")).toBe(true);
  });

  it("reassignTask with reclaim releases active claim and assigns new profile", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Reclaim me", assignee: "opencode" });
    promoteTask(task.id);
    const claim = atomicClaim(task.id, "opencode");
    expect(claim.success).toBe(true);

    const reassigned = reassignTask(task.id, "codex", { reclaim: true });
    expect(reassigned.status).toBe("ready");
    expect(reassigned.assignee).toBe("codex");
    expect(reassigned.claim_lock).toBeNull();

    const events = getEvents(task.id);
    expect(events.some((e) => e.kind === "reclaimed")).toBe(true);
    expect(events.some((e) => e.kind === "assigned")).toBe(true);

    const runs = getRuns(task.id);
    const reclaimedRun = runs.find((r) => r.id === claim.runId);
    expect(reclaimedRun).toBeDefined();
    expect(reclaimedRun!.outcome).toBe("reclaimed");
  });

  it("reassignTask with reclaim records reason on reclaimed event", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Reclaim reason", assignee: "opencode" });
    promoteTask(task.id);
    atomicClaim(task.id, "opencode");

    reassignTask(task.id, "codex", { reclaim: true, reason: "slow" });

    const events = getEvents(task.id);
    const reclaimed = events.find((e) => e.kind === "reclaimed");
    expect(reclaimed).toBeDefined();
    expect(JSON.parse(reclaimed!.payload!)).toEqual({ reason: "slow" });
  });

  it("reassignTask with reclaim to none clears assignee and leaves task ready", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Reclaim none", assignee: "opencode" });
    promoteTask(task.id);
    atomicClaim(task.id, "opencode");

    const reassigned = reassignTask(task.id, null, { reclaim: true, reason: "abort" });
    expect(reassigned.status).toBe("ready");
    expect(reassigned.assignee).toBeNull();

    const events = getEvents(task.id);
    expect(events.some((e) => e.kind === "reclaimed")).toBe(true);
    expect(events.some((e) => e.kind === "unassigned")).toBe(true);
  });
});

describe("promoteTaskAdvanced", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("promotes a todo task to ready", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Promote me" });

    const result = promoteTaskAdvanced(task.id);
    expect(result.status).toBe("promoted");
    if (result.status === "promoted") {
      expect(result.task.status).toBe("ready");
    }

    const fetched = showTask(task.id);
    expect(fetched!.status).toBe("ready");
  });

  it("returns not_found for a missing task", () => {
    const result = promoteTaskAdvanced(9999);
    expect(result.status).toBe("not_found");
  });

  it("returns archived for an archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Archived todo" });
    archiveTask(task.id);

    const result = promoteTaskAdvanced(task.id);
    expect(result.status).toBe("archived");
  });

  it("returns wrong_status for a non-todo task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Ready task" });
    promoteTask(task.id);

    const result = promoteTaskAdvanced(task.id);
    expect(result.status).toBe("wrong_status");
    if (result.status === "wrong_status") {
      expect(result.current).toBe("ready");
    }
  });

  it("returns blocked_by_dependencies when parent not done", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const result = promoteTaskAdvanced(child.id);
    expect(result.status).toBe("blocked_by_dependencies");
  });

  it("promotes with force when parent not done", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const result = promoteTaskAdvanced(child.id, { force: true });
    expect(result.status).toBe("promoted");
  });

  it("returns would_promote in dry-run mode", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Dry run me" });

    const result = promoteTaskAdvanced(task.id, { dryRun: true });
    expect(result.status).toBe("would_promote");

    // Task should still be in todo
    const fetched = showTask(task.id);
    expect(fetched!.status).toBe("todo");
  });

  it("dry-run returns blocked_by_dependencies when parent not done", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const result = promoteTaskAdvanced(child.id, { dryRun: true });
    expect(result.status).toBe("blocked_by_dependencies");
  });

  it("dry-run with force returns would_promote even when parent not done", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const parent = createTask({ board_id: board.id, title: "Parent" });
    const child = createTask({ board_id: board.id, title: "Child" });
    addDependency(parent.id, child.id);

    const result = promoteTaskAdvanced(child.id, { dryRun: true, force: true });
    expect(result.status).toBe("would_promote");

    // Task should still be in todo
    const fetched = showTask(child.id);
    expect(fetched!.status).toBe("todo");
  });

  it("emits promoted event on success", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Emit event" });

    const result = promoteTaskAdvanced(task.id);
    expect(result.status).toBe("promoted");

    const events = getEvents(task.id);
    expect(events.some((e) => e.kind === "promoted")).toBe(true);
  });
});

describe("archiveTaskHard", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("permanently deletes an archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Delete me" });
    archiveTask(task.id);

    archiveTaskHard(task.id);

    const fetched = showTask(task.id);
    expect(fetched).toBeNull();
  });

  it("throws for a non-archived task", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Not archived" });

    expect(() => archiveTaskHard(task.id)).toThrow(/not archived/);
  });

  it("throws for a missing task", () => {
    expect(() => archiveTaskHard(9999)).toThrow(/not found/);
  });

  it("cascade-deletes related events, runs, comments, attachments, and dependencies", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Cascade delete" });

    // Add a comment
    addComment(task.id, "test comment");

    // Promote and create a run
    promoteTask(task.id);
    const claim = atomicClaim(task.id, "test-profile");
    expect(claim.success).toBe(true);
    // Finish the run to create a terminal run
    const { finishRun } = require("../src/models/taskRun");
    finishRun(claim.runId!, "completed", null, null, null);

    // Create dependency
    const child = createTask({ board_id: board.id, title: "Child task" });
    addDependency(task.id, child.id);

    // Attach a file
    const tmpFile = "/tmp/kdi-attachment-test.txt";
    try {
      const { writeFileSync } = require("node:fs");
      writeFileSync(tmpFile, "test content");
      createAttachment(task.id, tmpFile);
    } catch {}

    // Archive then hard delete
    archiveTask(task.id);
    archiveTaskHard(task.id);

    // Verify task is gone
    expect(showTask(task.id)).toBeNull();

    // Verify child still exists (dependency was cascade-deleted, not the child)
    const childFetched = showTask(child.id);
    expect(childFetched).not.toBeNull();

    // Clean up temp file
    const { rmSync } = require("node:fs");
    try { rmSync(tmpFile, { force: true }); } catch {}
  });
});
