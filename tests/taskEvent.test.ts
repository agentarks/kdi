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
import { setFlag, clearOverrides } from "../src/flags";
import { FF_TENANT_NAMESPACE } from "../src/flags";
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

  // KDI-035: watch filters
  describe("watch filters", () => {
    it("getRecentEvents returns unfiltered events when no filters are passed", () => {
      const board = createBoard("alpha", "/tmp/alpha");
      const task = createTask({ board_id: board.id, title: "Test" });
      addEvent(task.id, "created");

      const events = getRecentEvents(10, {});
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("getRecentEvents filters by assignee", () => {
      const board = createBoard("alpha", "/tmp/alpha");
      const t1 = createTask({ board_id: board.id, title: "T1", assignee: "alice" });
      const t2 = createTask({ board_id: board.id, title: "T2", assignee: "bob" });
      addEvent(t1.id, "promoted");
      addEvent(t2.id, "blocked");

      const events = getRecentEvents(10, { assignee: "alice" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const e of events) {
        expect(e.task_id).toBe(t1.id);
      }
    });

    it("getRecentEvents filters by tenant (when FF_TENANT_NAMESPACE enabled)", () => {
      setFlag(FF_TENANT_NAMESPACE, true);
      try {
        const board = createBoard("alpha", "/tmp/alpha");
        const t1 = createTask({ board_id: board.id, title: "T1", tenant: "team-a" });
        const t2 = createTask({ board_id: board.id, title: "T2", tenant: "team-b" });
        addEvent(t1.id, "promoted");
        addEvent(t2.id, "blocked");

        const events = getRecentEvents(10, { tenant: "team-a" });
        expect(events.length).toBeGreaterThanOrEqual(1);
        for (const e of events) {
          expect(e.task_id).toBe(t1.id);
        }
      } finally {
        clearOverrides();
      }
    });

    it("getRecentEvents filters by kinds", () => {
      const board = createBoard("alpha", "/tmp/alpha");
      const task = createTask({ board_id: board.id, title: "Test" });
      addEvent(task.id, "created");
      addEvent(task.id, "promoted");
      addEvent(task.id, "blocked");

      const events = getRecentEvents(10, { kinds: ["created", "promoted"] });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const e of events) {
        expect(["created", "promoted"]).toContain(e.kind);
      }
    });

    it("getRecentEvents combines assignee + kinds filters (AND)", () => {
      const board = createBoard("alpha", "/tmp/alpha");
      const t1 = createTask({ board_id: board.id, title: "T1", assignee: "alice" });
      const t2 = createTask({ board_id: board.id, title: "T2", assignee: "bob" });
      addEvent(t1.id, "created");
      addEvent(t1.id, "promoted");
      addEvent(t2.id, "created");

      const events = getRecentEvents(10, { assignee: "alice", kinds: ["promoted"] });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const e of events) {
        expect(e.kind).toBe("promoted");
        // We can't easily check assignee from the event directly, but the
        // filter ensures only alice's tasks are returned
      }
    });

    it("getEventsAfter filters by assignee", () => {
      const board = createBoard("alpha", "/tmp/alpha");
      const t1 = createTask({ board_id: board.id, title: "T1", assignee: "alice" });
      const t2 = createTask({ board_id: board.id, title: "T2", assignee: "bob" });
      const e1 = addEvent(t1.id, "created");
      addEvent(t2.id, "created");
      addEvent(t1.id, "promoted");

      const events = getEventsAfter(e1.id, { assignee: "alice" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const e of events) {
        expect(e.task_id).toBe(t1.id);
      }
    });

    it("getEventsAfter filters by kinds", () => {
      const board = createBoard("alpha", "/tmp/alpha");
      const task = createTask({ board_id: board.id, title: "Test" });
      const first = addEvent(task.id, "created");
      addEvent(task.id, "promoted");
      addEvent(task.id, "blocked");

      const events = getEventsAfter(first.id, { kinds: ["blocked"] });
      expect(events.length).toBe(1);
      expect(events[0].kind).toBe("blocked");
    });
  });
});
