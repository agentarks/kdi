import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";
import { createBoard } from "../src/models/board";
import {
  createTask,
  showTask,
  specifyTaskWithLlm,
  decomposeTask,
  listTasks,
  type Task,
} from "../src/models/task";
import { addDependency, isBlockedByDependencies } from "../src/models/dependency";
import { getEvents } from "../src/models/taskEvent";
import { setFlag, clearOverrides, FF_TRIAGE_AUTOMATION } from "../src/flags";

const TEST_DB = "/tmp/kdi-triage-automation-test.db";

let originalFetch: typeof fetch;

function mockFetch(response: unknown) {
  global.fetch = mock(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
}

function initTask(overrides: Partial<Task> = {}): Task {
  const board = createBoard("triage-board", "/tmp/triage-board");
  return createTask({
    board_id: board.id,
    title: "Triage me",
    triage: true,
    ...overrides,
  });
}

describe("triage automation model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    initDb(TEST_DB);
    clearOverrides();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    closeDb();
    cleanupDb(TEST_DB);
    delete process.env.KDI_DB;
    delete process.env.KDI_TRIAGE_LLM_API_KEY;
    clearOverrides();
  });

  describe("specifyTaskWithLlm", () => {
    it("skipLlm uses manual promotion and requires body", async () => {
      const task = initTask({ body: "Body" });
      const result = await specifyTaskWithLlm(task.id, { skipLlm: true });
      expect(result.status).toBe("todo");

      const events = getEvents(task.id);
      expect(events.some((e) => e.kind === "specified")).toBe(true);
    });

    it("skipLlm rejects empty body", async () => {
      const task = initTask();
      await expect(specifyTaskWithLlm(task.id, { skipLlm: true })).rejects.toThrow(
        "Triage task needs a body before promotion"
      );
      expect(showTask(task.id)!.status).toBe("triage");
    });

    it("LLM success updates body/title/assignee and promotes to todo", async () => {
      process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
      setFlag(FF_TRIAGE_AUTOMATION, true);

      const task = initTask();
      mockFetch({ body: "LLM body", title: "LLM title", assignee: "llm-agent" });

      const result = await specifyTaskWithLlm(task.id);
      expect(result.status).toBe("todo");
      expect(result.body).toBe("LLM body");
      expect(result.title).toBe("LLM title");
      expect(result.assignee).toBe("llm-agent");

      const events = getEvents(task.id);
      const specified = events.find((e) => e.kind === "specified");
      expect(specified).toBeDefined();
      expect(JSON.parse(specified!.payload!)).toEqual({ llm: true });
    });

    it("LLM success omits optional fields", async () => {
      process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
      setFlag(FF_TRIAGE_AUTOMATION, true);

      const task = initTask({ title: "Keep me", assignee: "parent" });
      mockFetch({ body: "LLM body" });

      const result = await specifyTaskWithLlm(task.id);
      expect(result.title).toBe("Keep me");
      expect(result.assignee).toBe("parent");
    });

    it("missing API key throws without mutating", async () => {
      setFlag(FF_TRIAGE_AUTOMATION, true);
      const task = initTask();
      await expect(specifyTaskWithLlm(task.id)).rejects.toThrow(
        "Triage LLM API key is not configured"
      );
      expect(showTask(task.id)!.status).toBe("triage");
    });

    it("invalid LLM response blocks task", async () => {
      process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
      setFlag(FF_TRIAGE_AUTOMATION, true);

      const task = initTask();
      mockFetch({ body: "" });

      await expect(specifyTaskWithLlm(task.id)).rejects.toThrow("LLM specify failed");
      const updated = showTask(task.id)!;
      expect(updated.status).toBe("blocked");
      expect(updated.block_reason).toContain("LLM specify failed");

      const events = getEvents(task.id);
      expect(events.some((e) => e.kind === "blocked")).toBe(true);
    });

    it("missing body in LLM response blocks with exact reason", async () => {
      process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
      setFlag(FF_TRIAGE_AUTOMATION, true);

      const task = initTask();
      mockFetch({ body: "" });

      await expect(specifyTaskWithLlm(task.id)).rejects.toThrow(
        "LLM specify failed: missing body in response"
      );
      expect(showTask(task.id)!.block_reason).toBe(
        "LLM specify failed: missing body in response"
      );
    });

    it("rejects non-triage task", async () => {
      const task = initTask({ initialStatus: "todo" });
      await expect(specifyTaskWithLlm(task.id, { skipLlm: true })).rejects.toThrow(
        "not in triage status"
      );
    });
  });

  describe("decomposeTask", () => {
    it("creates children, dependencies, archives parent, emits decomposed event", () => {
      const task = initTask({ tenant: "backend", assignee: "alice" });
      const children = decomposeTask(task.id, {
        children: [
          { title: "A" },
          { title: "B", dependencies: [0] },
          { title: "C", body: "do c", dependencies: [0, 1] },
        ],
      });

      expect(children).toHaveLength(3);
      expect(children.every((c) => c.status === "todo")).toBe(true);
      expect(children.every((c) => c.tenant === "backend")).toBe(true);
      expect(children[0].assignee).toBe("alice");
      expect(children[1].assignee).toBe("alice");
      expect(children[2].body).toBe("do c");

      expect(isBlockedByDependencies(children[1].id)).toBe(true);
      expect(isBlockedByDependencies(children[2].id)).toBe(true);

      const parent = showTask(task.id);
      expect(parent).toBeNull();

      const events = getEvents(task.id);
      const decomposed = events.find((e) => e.kind === "decomposed");
      expect(decomposed).toBeDefined();
      const payload = JSON.parse(decomposed!.payload!);
      expect(payload.child_count).toBe(3);
      expect(payload.child_ids).toEqual(children.map((c) => c.id));
    });

    it("child assignee defaults to parent assignee when omitted", () => {
      const task = initTask({ assignee: "parent" });
      const children = decomposeTask(task.id, {
        children: [{ title: "A" }, { title: "B", assignee: "explicit" }],
      });
      expect(children[0].assignee).toBe("parent");
      expect(children[1].assignee).toBe("explicit");
    });

    it("rejects non-triage parent", () => {
      const task = initTask({ initialStatus: "todo" });
      expect(() =>
        decomposeTask(task.id, { children: [{ title: "A" }, { title: "B" }] })
      ).toThrow("not in triage status");
    });

    it("rejects too few children", () => {
      const task = initTask();
      expect(() => decomposeTask(task.id, { children: [{ title: "A" }] })).toThrow();
      expect(showTask(task.id)!.status).toBe("blocked");
    });

    it("rejects too many children", () => {
      const task = initTask();
      const children = Array.from({ length: 11 }, (_, i) => ({ title: `C${i}` }));
      expect(() => decomposeTask(task.id, { children })).toThrow();
      expect(showTask(task.id)!.status).toBe("blocked");
    });

    it("rejects empty child title", () => {
      const task = initTask();
      expect(() =>
        decomposeTask(task.id, { children: [{ title: "A" }, { title: "" }] })
      ).toThrow();
      expect(showTask(task.id)!.status).toBe("blocked");
    });

    it("rejects self-dependency and blocks parent", () => {
      const task = initTask();
      expect(() =>
        decomposeTask(task.id, { children: [{ title: "A" }, { title: "B", dependencies: [1] }] })
      ).toThrow();
      expect(showTask(task.id)!.status).toBe("blocked");
    });

    it("rejects invalid dependency index", () => {
      const task = initTask();
      expect(() =>
        decomposeTask(task.id, { children: [{ title: "A" }, { title: "B", dependencies: [99] }] })
      ).toThrow();
      expect(showTask(task.id)!.status).toBe("blocked");
    });

    it("rejects circular dependency and blocks parent", () => {
      const task = initTask();
      expect(() =>
        decomposeTask(task.id, {
          children: [
            { title: "A", dependencies: [1] },
            { title: "B", dependencies: [0] },
          ],
        })
      ).toThrow();
      expect(showTask(task.id)!.status).toBe("blocked");
    });

    it("does not create children when decomposition is invalid", () => {
      const task = initTask();
      const before = listTasks({ board_id: task.board_id }).length;
      try {
        decomposeTask(task.id, { children: [{ title: "A" }] });
      } catch {}
      const after = listTasks({ board_id: task.board_id, includeArchived: true }).length;
      expect(after).toBe(before);
    });
  });
});
