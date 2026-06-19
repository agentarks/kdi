import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../../src/db";
import { createBoard } from "../../src/models/board";
import { cleanupDb } from "../cleanupDb";
import { clearOverrides, setFlag, FF_SWARM_MODE } from "../../src/flags";
import { swarmCommand } from "../../src/commands/swarm";

const SWARM_DB = "/tmp/kdi-commands-swarm-test.db";

let _origStderrWrite: typeof process.stderr.write | null = null;

function resetCommandOptions(cmd: unknown): void {
  const defaults: Record<string, unknown> = {};
  for (const option of (cmd as any).options ?? []) {
    if (option.defaultValue !== undefined) {
      defaults[option.attributeName()] = option.defaultValue;
    }
  }
  (cmd as any)._optionValues = defaults;
  for (const sub of (cmd as any).commands ?? []) {
    resetCommandOptions(sub);
  }
}

async function runSwarm(args: string[]): Promise<{ logs: string[]; message?: string }> {
  const originalExitCallback = (swarmCommand as any)._exitCallback;
  swarmCommand.exitOverride();

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };

  let message: string | undefined;
  try {
    await swarmCommand.parseAsync(args, { from: "user" });
  } catch (err: any) {
    message = err.message;
  } finally {
    (swarmCommand as any)._exitCallback = originalExitCallback;
    console.log = originalLog;
  }
  return { logs, message };
}

describe("KDI-041 swarm command", () => {
  beforeEach(() => {
    clearOverrides();
    cleanupDb(SWARM_DB);
    process.env.KDI_DB = SWARM_DB;
    delete process.env.KDI_BOARD;
    delete process.env.KDI_PROFILE;
    delete process.env.HERMES_PROFILE;
    resetCommandOptions(swarmCommand);
    _origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    initDb(SWARM_DB);
    createBoard("sw", "/tmp/sw");
  });

  afterEach(() => {
    if (_origStderrWrite) process.stderr.write = _origStderrWrite;
    clearOverrides();
    closeDb();
    cleanupDb(SWARM_DB);
    delete process.env.KDI_DB;
    delete process.env.KDI_BOARD;
    delete process.env.KDI_PROFILE;
    delete process.env.HERMES_PROFILE;
  });

  it("rejects when FF_SWARM_MODE is disabled", async () => {
    setFlag(FF_SWARM_MODE, false);
    const { message } = await runSwarm(["--worker", "backend:auth", "--verifier", "qa", "--synthesizer", "pm", "--board", "sw"]);
    expect(message).toContain("Swarm mode is not enabled");
  });

  it("rejects missing --worker", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { message } = await runSwarm(["--verifier", "qa", "--synthesizer", "pm", "--board", "sw"]);
    expect(message).toContain("At least one --worker is required");
  });

  it("rejects missing --verifier", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { message } = await runSwarm(["--worker", "backend:auth", "--synthesizer", "pm", "--board", "sw"]);
    expect(message).toContain("--verifier is required");
  });

  it("rejects missing --synthesizer", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { message } = await runSwarm(["--worker", "backend:auth", "--verifier", "qa", "--board", "sw"]);
    expect(message).toContain("--synthesizer is required");
  });

  it("rejects duplicate worker titles", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { message } = await runSwarm([
      "--worker", "backend:auth",
      "--worker", "frontend:auth",
      "--verifier", "qa",
      "--synthesizer", "pm",
      "--board", "sw",
    ]);
    expect(message).toContain('Duplicate worker title "auth"');
  });

  it("rejects worker missing :title suffix", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { message } = await runSwarm(["--worker", "backend", "--verifier", "qa", "--synthesizer", "pm", "--board", "sw"]);
    expect(message).toContain("Invalid worker");
  });

  it("--dry-run prints the planned graph and creates no tasks", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { logs } = await runSwarm([
      "--worker", "backend:auth",
      "--worker", "frontend:login",
      "--verifier", "qa",
      "--synthesizer", "pm",
      "--board", "sw",
      "--dry-run",
    ]);

    expect(logs.some((l) => l.includes("Orchestrator:"))).toBe(true);
    expect(logs.some((l) => l.includes("Worker: auth"))).toBe(true);
    expect(logs.some((l) => l.includes("Worker: login"))).toBe(true);
    expect(logs.some((l) => l.includes("Verifier:"))).toBe(true);
    expect(logs.some((l) => l.includes("Synthesizer:"))).toBe(true);
    expect(logs.some((l) => l.includes("auth -> verify"))).toBe(true);
    expect(logs.some((l) => l.includes("-> synthesize"))).toBe(true);

    const { showTask } = await import("../../src/models/task");
    expect(showTask(1)).toBeNull();
  });

  it("creates orchestrator, workers, verifier, and synthesizer", async () => {
    setFlag(FF_SWARM_MODE, true);
    const { logs, message } = await runSwarm([
      "--worker", "backend:auth",
      "--worker", "frontend:login",
      "--verifier", "qa",
      "--synthesizer", "pm",
      "--board", "sw",
      "--body", "build auth",
      "--priority", "3",
      "--session", "sess-1",
    ]);

    expect(message).toBeUndefined();
    const orchestratorId = logs.join(" ").match(/orchestrator #(\d+)/)?.[1];
    expect(orchestratorId).toBeDefined();

    const { showTask } = await import("../../src/models/task");
    const orchestrator = showTask(Number(orchestratorId));
    expect(orchestrator!.status).toBe("triage");
    expect(orchestrator!.body).toBe("build auth");
    expect(orchestrator!.priority).toBe(3);
    expect(orchestrator!.session_id).toBe("sess-1");
    expect(orchestrator!.swarm_parent_id).toBeNull();
  });
});
