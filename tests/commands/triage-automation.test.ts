import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getBoardDataDir } from "../../src/db";
import { cleanupDb } from "../cleanupDb";
import { createBoard } from "../../src/models/board";
import { createTask, showTask } from "../../src/models/task";
import { getEvents } from "../../src/models/taskEvent";
import { specifyTaskCommand, decomposeTaskCommand } from "../../src/commands/tasks";
import { setFlag, clearOverrides, FF_TRIAGE_AUTOMATION } from "../../src/flags";

const TEST_DB = "/tmp/kdi-triage-automation-cmd-test.db";

function startMockLlm(response: unknown): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        choices: [{ message: { content: JSON.stringify(response) } }],
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    stop: () => server.stop(),
  };
}

async function runCommand(
  command: typeof specifyTaskCommand | typeof decomposeTaskCommand,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ exitCode: number; logs: string[]; errors: string[] }> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;

  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${code}`); }) as typeof process.exit;

  try {
    await command.parseAsync(args, { from: "user" });
  } catch (err: any) {
    if (!err?.message?.startsWith("exit:")) {
      errors.push(String(err.message));
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
    (command as any)._optionValues = {};
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  return { exitCode, logs, errors };
}

describe("triage automation commands", () => {
  let sourceDir: string;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    sourceDir = mkdtempSync(join(tmpdir(), "kdi-triage-cmd-"));
    initDb(TEST_DB);
    clearOverrides();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(TEST_DB);
    delete process.env.KDI_DB;
    delete process.env.KDI_TRIAGE_LLM_API_KEY;
    delete process.env.KDI_TRIAGE_LLM_BASE_URL;
    clearOverrides();
    try {
      rmSync(getBoardDataDir("triage-cmd"), { recursive: true, force: true });
    } catch {}
    try {
      rmSync(sourceDir, { recursive: true, force: true });
    } catch {}
  });

  it("specify with flag disabled still promotes manually when body present", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, false);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Triage", body: "Body", triage: true });

    const { exitCode, logs } = await runCommand(specifyTaskCommand, [String(task.id), "--board", "triage-cmd"]);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes(`Specified task ${task.id}`))).toBe(true);
    expect(showTask(task.id)!.status).toBe("todo");
  });

  it("decompose is rejected when flag disabled", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, false);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Epic", triage: true });

    const { exitCode, errors } = await runCommand(decomposeTaskCommand, [String(task.id), "--board", "triage-cmd"]);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Triage automation feature is not enabled"))).toBe(true);
    expect(showTask(task.id)!.status).toBe("triage");
  });

  it("specify --tenant is rejected when flag disabled", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, false);
    createBoard("triage-cmd", "/tmp/triage-cmd");

    const { exitCode, errors } = await runCommand(specifyTaskCommand, ["--all", "--tenant", "backend", "--board", "triage-cmd"]);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Triage automation feature is not enabled"))).toBe(true);
  });

  it("specify uses LLM when flag enabled", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Triage", triage: true });

    const mock = startMockLlm({ body: "LLM body", title: "LLM title" });
    const { exitCode, logs, errors } = await runCommand(
      specifyTaskCommand,
      [String(task.id), "--board", "triage-cmd"],
      { KDI_TRIAGE_LLM_API_KEY: "sk-test", KDI_TRIAGE_LLM_BASE_URL: mock.url }
    );
    mock.stop();

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes(`Specified task ${task.id}`))).toBe(true);
    const updated = showTask(task.id)!;
    expect(updated.status).toBe("todo");
    expect(updated.body).toBe("LLM body");
    expect(updated.title).toBe("LLM title");

    const events = getEvents(task.id);
    expect(events.some((e) => e.kind === "specified" && e.payload?.includes("llm"))).toBe(true);
  });

  it("specify --skip-llm uses manual path even when flag enabled", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Triage", body: "Body", triage: true });

    const { exitCode, logs } = await runCommand(specifyTaskCommand, [String(task.id), "--skip-llm", "--board", "triage-cmd"]);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes(`Specified task ${task.id}`))).toBe(true);
    expect(showTask(task.id)!.body).toBe("Body");
  });

  it("specify --all sweeps triage tasks", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const t1 = createTask({ board_id: board.id, title: "A", triage: true });
    const t2 = createTask({ board_id: board.id, title: "B", triage: true });

    const mock = startMockLlm({ body: "Body" });
    const { exitCode, logs } = await runCommand(
      specifyTaskCommand,
      ["--all", "--board", "triage-cmd"],
      { KDI_TRIAGE_LLM_API_KEY: "sk-test", KDI_TRIAGE_LLM_BASE_URL: mock.url }
    );
    mock.stop();

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Specified 2/2 tasks"))).toBe(true);
    expect(showTask(t1.id)!.status).toBe("todo");
    expect(showTask(t2.id)!.status).toBe("todo");
  });

  it("specify --all --tenant filters by tenant", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    createTask({ board_id: board.id, title: "Foo", triage: true, tenant: "backend" });
    createTask({ board_id: board.id, title: "Bar", triage: true, tenant: "frontend" });

    const mock = startMockLlm({ body: "Body" });
    const { exitCode, logs } = await runCommand(
      specifyTaskCommand,
      ["--all", "--tenant", "backend", "--board", "triage-cmd"],
      { KDI_TRIAGE_LLM_API_KEY: "sk-test", KDI_TRIAGE_LLM_BASE_URL: mock.url }
    );
    mock.stop();

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Specified 1/1 tasks"))).toBe(true);
  });

  it("decompose creates children and archives parent", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Epic", triage: true });

    const mock = startMockLlm({
      children: [{ title: "A" }, { title: "B", dependencies: [0] }],
    });
    const { exitCode, logs } = await runCommand(
      decomposeTaskCommand,
      [String(task.id), "--board", "triage-cmd"],
      { KDI_TRIAGE_LLM_API_KEY: "sk-test", KDI_TRIAGE_LLM_BASE_URL: mock.url }
    );
    mock.stop();

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Decomposed task") && l.includes("created 2 children"))).toBe(true);
    expect(showTask(task.id)).toBeNull();
  });

  it("decompose --all --tenant filters by tenant", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    createTask({ board_id: board.id, title: "Foo", triage: true, tenant: "backend" });
    createTask({ board_id: board.id, title: "Bar", triage: true, tenant: "frontend" });

    const mock = startMockLlm({ children: [{ title: "A" }, { title: "B" }] });
    const { exitCode, logs } = await runCommand(
      decomposeTaskCommand,
      ["--all", "--tenant", "backend", "--board", "triage-cmd"],
      { KDI_TRIAGE_LLM_API_KEY: "sk-test", KDI_TRIAGE_LLM_BASE_URL: mock.url }
    );
    mock.stop();

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Decomposed 1/1 tasks"))).toBe(true);
  });

  it("rejects non-numeric task IDs for specify", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    createBoard("triage-cmd", "/tmp/triage-cmd");

    const { exitCode, errors } = await runCommand(specifyTaskCommand, ["abc", "--board", "triage-cmd"]);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Invalid task ID"))).toBe(true);
  });

  it("rejects non-numeric task IDs for decompose", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    createBoard("triage-cmd", "/tmp/triage-cmd");

    const { exitCode, errors } = await runCommand(decomposeTaskCommand, ["abc", "--board", "triage-cmd"]);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Invalid task ID"))).toBe(true);
  });

  it("missing API key exits before mutating for specify", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Triage", triage: true });

    const { exitCode, errors } = await runCommand(specifyTaskCommand, [String(task.id), "--board", "triage-cmd"]);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Triage LLM API key is not configured"))).toBe(true);
    expect(showTask(task.id)!.status).toBe("triage");
  });

  it("missing API key exits before mutating for decompose", async () => {
    setFlag(FF_TRIAGE_AUTOMATION, true);
    const board = createBoard("triage-cmd", "/tmp/triage-cmd");
    const task = createTask({ board_id: board.id, title: "Epic", triage: true });

    const { exitCode, errors } = await runCommand(decomposeTaskCommand, [String(task.id), "--board", "triage-cmd"]);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Triage LLM API key is not configured"))).toBe(true);
    expect(showTask(task.id)!.status).toBe("triage");
  });
});
