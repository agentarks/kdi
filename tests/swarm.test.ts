import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../src/db";
import { createBoard } from "../src/models/board";
import { showTask } from "../src/models/task";
import { createSwarmGraph, planSwarmGraph, validateSwarmInput } from "../src/models/swarm";
import { isBlockedByDependencies } from "../src/models/dependency";
import { getEvents } from "../src/models/taskEvent";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-swarm-test.db";

describe("swarm model", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    initDb(TEST_DB);
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  function makeBoard() {
    return createBoard("swarm-board", "/tmp/swarm-board");
  }

  it("validates at least one worker", () => {
    expect(() =>
      validateSwarmInput({
        board_id: 1,
        workers: [],
        verifier: "qa",
        synthesizer: "pm",
      })
    ).toThrow("At least one --worker is required.");
  });

  it("validates verifier", () => {
    expect(() =>
      validateSwarmInput({
        board_id: 1,
        workers: [{ profile: "backend", title: "auth" }],
        verifier: "",
        synthesizer: "pm",
      })
    ).toThrow("--verifier is required.");
  });

  it("validates synthesizer", () => {
    expect(() =>
      validateSwarmInput({
        board_id: 1,
        workers: [{ profile: "backend", title: "auth" }],
        verifier: "qa",
        synthesizer: "  ",
      })
    ).toThrow("--synthesizer is required.");
  });

  it("validates worker format", () => {
    expect(() =>
      validateSwarmInput({
        board_id: 1,
        workers: [{ profile: "backend", title: "" }],
        verifier: "qa",
        synthesizer: "pm",
      })
    ).toThrow('Invalid worker');
  });

  it("rejects duplicate worker titles", () => {
    expect(() =>
      validateSwarmInput({
        board_id: 1,
        workers: [
          { profile: "backend", title: "auth" },
          { profile: "frontend", title: "auth" },
        ],
        verifier: "qa",
        synthesizer: "pm",
      })
    ).toThrow('Duplicate worker title "auth"');
  });

  it("creates orchestrator in triage and children in ready", () => {
    const board = makeBoard();
    const graph = createSwarmGraph({
      board_id: board.id,
      workers: [
        { profile: "backend", title: "auth" },
        { profile: "frontend", title: "login" },
      ],
      verifier: "qa",
      synthesizer: "pm",
      body: "swarm body",
      priority: 5,
      session_id: "session-1",
    });

    const orchestrator = showTask(graph.orchestrator_id);
    expect(orchestrator).not.toBeNull();
    expect(orchestrator!.status).toBe("triage");
    expect(orchestrator!.title.startsWith("swarm:")).toBe(true);
    expect(orchestrator!.body).toBe("swarm body");
    expect(orchestrator!.priority).toBe(5);
    expect(orchestrator!.session_id).toBe("session-1");
    expect(orchestrator!.swarm_parent_id).toBeNull();

    expect(graph.worker_ids).toHaveLength(2);
    for (const workerId of graph.worker_ids) {
      const worker = showTask(workerId);
      expect(worker!.status).toBe("ready");
      expect(worker!.swarm_parent_id).toBe(graph.orchestrator_id);
    }

    const verifier = showTask(graph.verifier_id);
    expect(verifier!.status).toBe("ready");
    expect(verifier!.assignee).toBe("qa");
    expect(verifier!.swarm_parent_id).toBe(graph.orchestrator_id);

    const synthesizer = showTask(graph.synthesizer_id);
    expect(synthesizer!.status).toBe("ready");
    expect(synthesizer!.assignee).toBe("pm");
    expect(synthesizer!.swarm_parent_id).toBe(graph.orchestrator_id);
  });

  it("creates dependency edges", () => {
    const board = makeBoard();
    const graph = createSwarmGraph({
      board_id: board.id,
      workers: [
        { profile: "backend", title: "auth" },
        { profile: "frontend", title: "login" },
      ],
      verifier: "qa",
      synthesizer: "pm",
    });

    expect(isBlockedByDependencies(graph.verifier_id)).toBe(true);
    expect(isBlockedByDependencies(graph.synthesizer_id)).toBe(true);
  });

  it("emits swarm events", () => {
    const board = makeBoard();
    const graph = createSwarmGraph({
      board_id: board.id,
      workers: [{ profile: "backend", title: "auth" }],
      verifier: "qa",
      synthesizer: "pm",
    });

    const orchestratorEvents = getEvents(graph.orchestrator_id);
    expect(orchestratorEvents.some((e) => e.kind === "swarm_created")).toBe(true);

    const workerEvents = getEvents(graph.worker_ids[0]);
    expect(workerEvents.some((e) => e.kind === "swarm_worker_created")).toBe(true);

    const verifierEvents = getEvents(graph.verifier_id);
    expect(verifierEvents.some((e) => e.kind === "swarm_verifier_created")).toBe(true);

    const synthesizerEvents = getEvents(graph.synthesizer_id);
    expect(synthesizerEvents.some((e) => e.kind === "swarm_synthesizer_created")).toBe(true);
  });

  it("dry-run plan returns expected structure without mutating db", () => {
    const board = makeBoard();
    const plan = planSwarmGraph({
      board_id: board.id,
      workers: [{ profile: "backend", title: "auth" }],
      verifier: "qa",
      synthesizer: "pm",
      body: "plan body",
    });

    expect(plan.orchestrator.status).toBe("triage");
    expect(plan.workers).toHaveLength(1);
    expect(plan.workers[0].title).toBe("auth");
    expect(plan.workers[0].status).toBe("ready");
    expect(plan.verifier.title.startsWith("verify:")).toBe(true);
    expect(plan.synthesizer.title.startsWith("synthesize:")).toBe(true);

    const db = showTask(1);
    expect(db).toBeNull();
  });
});
