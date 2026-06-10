import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { createTask } from "../src/models/task";
import {
  addEvent,
  getEvents,
  tailEvents,
  getRecentEvents,
  getEventsAfter,
} from "../src/models/taskEvent";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-task-event-test.db";

describe("taskEvent model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("addEvent returns event with all fields", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Test" });
    const event = addEvent(task.id, "blocked", { reason: "Waiting" });

    expect(event.id).toBeNumber();
    expect(event.task_id).toBe(task.id);
    expect(event.run_id).toBeNull();
    expect(event.kind).toBe("blocked");
    expect(event.payload).toBe('{"reason":"Waiting"}');
    expect(event.created_at).toBeNumber();
  });

  it("addEvent with runId stores runId", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Test" });
    const event = addEvent(task.id, "claimed", { assignee: "alice" }, 42);

    expect(event.run_id).toBe(42);
  });

  it("getEvents returns events ordered by created_at DESC", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Test" });
    addEvent(task.id, "created");
    addEvent(task.id, "promoted");
    addEvent(task.id, "blocked", { reason: "x" });

    const events = getEvents(task.id);
    expect(events).toHaveLength(4); // 3 + createTask emits "created"
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("blocked");
    expect(kinds[1]).toBe("promoted");
    expect(kinds[2]).toBe("created");
  });

  it("tailEvents without sinceId returns all events DESC", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Test" });
    addEvent(task.id, "promoted");

    const events = tailEvents(task.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].kind).toBe("promoted");
  });

  it("tailEvents with sinceId returns only newer events ASC", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Test" });
    const first = addEvent(task.id, "promoted");
    const second = addEvent(task.id, "blocked");

    const events = tailEvents(task.id, first.id);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(second.id);
    expect(events[0].kind).toBe("blocked");
  });

  it("getRecentEvents returns board-wide recent events", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task1 = createTask({ board_id: board.id, title: "T1" });
    const task2 = createTask({ board_id: board.id, title: "T2" });
    addEvent(task1.id, "promoted");
    addEvent(task2.id, "blocked");

    const events = getRecentEvents(10);
    const taskIds = events.map((e) => e.task_id);
    expect(taskIds).toContain(task1.id);
    expect(taskIds).toContain(task2.id);
  });

  it("getEventsAfter returns only events after sinceId", () => {
    const board = createBoard("alpha", "/tmp/alpha");
    const task = createTask({ board_id: board.id, title: "Test" });
    const first = addEvent(task.id, "promoted");
    addEvent(task.id, "blocked");
    addEvent(task.id, "unblocked");

    const events = getEventsAfter(first.id);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("blocked");
    expect(events[1].kind).toBe("unblocked");
  });
});
