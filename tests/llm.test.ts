import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  buildSpecifyPrompt,
  buildDecomposePrompt,
  callTriageLlm,
  type LlmSpecifyResponse,
  type LlmDecomposeResponse,
} from "../src/llm";
import { createBoard } from "../src/models/board";
import { createTask, type Task } from "../src/models/task";
import { initDb, closeDb } from "../src/db";
import { cleanupDb } from "./cleanupDb";

const TEST_DB = "/tmp/kdi-llm-test.db";

let originalFetch: typeof fetch;

function initTask(overrides: Partial<Task> = {}): Task {
  const board = createBoard("llm-board", "/tmp/llm-board");
  return createTask({
    board_id: board.id,
    title: "Epic task",
    body: "Some body",
    assignee: "alice",
    tenant: "backend",
    triage: true,
    ...overrides,
  });
}

describe("llm client", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    process.env.KDI_DB = TEST_DB;
    initDb(TEST_DB);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.KDI_TRIAGE_LLM_API_KEY;
    delete process.env.KDI_TRIAGE_LLM_BASE_URL;
    delete process.env.KDI_TRIAGE_LLM_MODEL;
    delete process.env.KDI_TRIAGE_LLM_TIMEOUT_MS;
    closeDb();
    cleanupDb(TEST_DB);
    delete process.env.KDI_DB;
  });

  it("buildSpecifyPrompt includes board slug and task context", () => {
    const task = initTask();
    const prompt = buildSpecifyPrompt(task);
    expect(prompt.type).toBe("specify");
    expect(prompt.task.id).toBe(task.id);
    expect(prompt.text).toContain("llm-board");
    expect(prompt.text).toContain("Epic task");
    expect(prompt.text).toContain("Some body");
    expect(prompt.text).toContain("alice");
    expect(prompt.text).toContain("backend");
  });

  it("buildDecomposePrompt includes board slug and task context", () => {
    const task = initTask();
    const prompt = buildDecomposePrompt(task);
    expect(prompt.type).toBe("decompose");
    expect(prompt.text).toContain("llm-board");
    expect(prompt.text).toContain("Epic task");
  });

  it("callTriageLlm sends OpenAI-compatible request and parses specify response", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    const data: LlmSpecifyResponse = {
      body: "Detailed body",
      title: "Refined title",
      assignee: "bob",
    };

    let requestUrl: string | undefined;
    let requestBody: unknown;
    global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(`{"choices":[{"message":{"content":"${JSON.stringify(data).replace(/"/g, '\\"')}"}}]}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const task = initTask();
    const result = await callTriageLlm(buildSpecifyPrompt(task));

    expect(requestUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: "gpt-4o-mini",
      messages: expect.any(Array),
    });
    expect(result.type).toBe("specify");
    expect((result.data as LlmSpecifyResponse).body).toBe("Detailed body");
    expect((result.data as LlmSpecifyResponse).title).toBe("Refined title");
    expect((result.data as LlmSpecifyResponse).assignee).toBe("bob");
  });

  it("callTriageLlm parses decompose response", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    const data: LlmDecomposeResponse = {
      children: [
        { title: "Child A", body: "Do A", dependencies: [] },
        { title: "Child B", dependencies: [0] },
      ],
    };

    global.fetch = mock(async () => {
      return new Response(`{"choices":[{"message":{"content":"${JSON.stringify(data).replace(/"/g, '\\"')}"}}]}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const task = initTask();
    const result = await callTriageLlm(buildDecomposePrompt(task));

    expect(result.type).toBe("decompose");
    const decomposed = result.data as LlmDecomposeResponse;
    expect(decomposed.children).toHaveLength(2);
    expect(decomposed.children[1].dependencies).toEqual([0]);
  });

  it("callTriageLlm extracts last JSON line", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    global.fetch = mock(async () => {
      return new Response(`Here is the JSON:\n{"body":"only line"}`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const task = initTask();
    const result = await callTriageLlm(buildSpecifyPrompt(task));
    expect((result.data as LlmSpecifyResponse).body).toBe("only line");
  });

  it("callTriageLlm throws on missing API key", async () => {
    const task = initTask();
    await expect(callTriageLlm(buildSpecifyPrompt(task))).rejects.toThrow(
      "Triage LLM API key is not configured"
    );
  });

  it("callTriageLlm throws on non-JSON response", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    global.fetch = mock(async () => {
      return new Response("not json", { status: 200 });
    });

    const task = initTask();
    await expect(callTriageLlm(buildSpecifyPrompt(task))).rejects.toThrow();
  });

  it("callTriageLlm throws on HTTP error", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    global.fetch = mock(async () => {
      return new Response("bad request", { status: 400 });
    });

    const task = initTask();
    await expect(callTriageLlm(buildSpecifyPrompt(task))).rejects.toThrow("HTTP 400");
  });

  it("callTriageLlm throws on timeout", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    process.env.KDI_TRIAGE_LLM_TIMEOUT_MS = "10";
    global.fetch = mock((_url, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        });
      });
    });

    const task = initTask();
    await expect(callTriageLlm(buildSpecifyPrompt(task))).rejects.toThrow("request timed out");
  });

  it("callTriageLlm uses custom base URL, model, and timeout", async () => {
    process.env.KDI_TRIAGE_LLM_API_KEY = "sk-test";
    process.env.KDI_TRIAGE_LLM_BASE_URL = "https://example.com/v1/";
    process.env.KDI_TRIAGE_LLM_MODEL = "custom-model";

    let requestUrl: string | undefined;
    let requestBody: unknown;
    global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response('{"choices":[{"message":{"content":"{\\"body\\":\\"ok\\"}"}}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const task = initTask();
    await callTriageLlm(buildSpecifyPrompt(task));

    expect(requestUrl).toBe("https://example.com/v1/chat/completions");
    expect(requestBody).toMatchObject({ model: "custom-model" });
  });
});
