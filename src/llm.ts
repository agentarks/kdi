import type { Task } from "./models/task";
import { getBoardById } from "./models/board";

export interface LlmPrompt {
  type: "specify" | "decompose";
  task: Task;
  text: string;
}

export interface LlmSpecifyResponse {
  body: string;
  title?: string;
  assignee?: string;
}

export interface LlmChild {
  title: string;
  body?: string;
  assignee?: string;
  dependencies?: number[];
}

export interface LlmDecomposeResponse {
  children: LlmChild[];
}

export type LlmResponse =
  | { type: "specify"; data: LlmSpecifyResponse }
  | { type: "decompose"; data: LlmDecomposeResponse };

const MAX_RESPONSE_BYTES = 32768;

function getBoardSlug(boardId: number): string {
  const board = getBoardById(boardId);
  return board?.slug ?? String(boardId);
}

function renderTaskContext(task: Task): string {
  return (
    `- board: ${getBoardSlug(task.board_id)}\n` +
    `- title: ${task.title}\n` +
    `- body: ${task.body ?? ""}\n` +
    `- assignee: ${task.assignee ?? ""}\n` +
    `- tenant: ${task.tenant ?? ""}`
  );
}

export function buildSpecifyPrompt(task: Task): LlmPrompt {
  const text =
    `You are a task specifier for a Kanban dispatch system.\n` +
    `A task is currently in "triage" status and needs a clear, actionable body\n` +
    `before it can be promoted to "todo".\n\n` +
    `Return a single JSON object with no markdown formatting:\n` +
    `{\n` +
    `  "body": "<detailed, actionable body>",\n` +
    `  "title": "<optional refined title>",\n` +
    `  "assignee": "<optional profile name>"\n` +
    `}\n\n` +
    `Only "body" is required. If the existing title or assignee is already\n` +
    `sensible, omit those fields to keep them unchanged.\n\n` +
    `Existing task context:\n${renderTaskContext(task)}`;

  return { type: "specify", task, text };
}

export function buildDecomposePrompt(task: Task): LlmPrompt {
  const text =
    `You are a task decomposer for a Kanban dispatch system.\n` +
    `A task is currently in "triage" status and is too large to execute as-is.\n` +
    `Break it into 2-10 smaller child tasks that can be worked independently.\n\n` +
    `Return a single JSON object with no markdown formatting:\n` +
    `{\n` +
    `  "children": [\n` +
    `    {\n` +
    `      "title": "<child title>",\n` +
    `      "body": "<optional detailed body>",\n` +
    `      "assignee": "<optional profile name>",\n` +
    `      "dependencies": [<optional array of zero-based indices of children that must finish before this one>]\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Use dependencies only when a child genuinely cannot start until another\n` +
    `child finishes. A child may not depend on itself. Keep the graph acyclic.\n\n` +
    `Parent task context:\n${renderTaskContext(task)}`;

  return { type: "decompose", task, text };
}

function extractLastJson(text: string): string | null {
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "");
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      return line;
    }
  }
  return null;
}

export async function callTriageLlm(prompt: LlmPrompt): Promise<LlmResponse> {
  const apiKey = Bun.env.KDI_TRIAGE_LLM_API_KEY;
  if (!apiKey) {
    throw new Error("Triage LLM API key is not configured (KDI_TRIAGE_LLM_API_KEY).");
  }

  const baseUrl = (Bun.env.KDI_TRIAGE_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = Bun.env.KDI_TRIAGE_LLM_MODEL || "gpt-4o-mini";
  const timeoutMs = Number(Bun.env.KDI_TRIAGE_LLM_TIMEOUT_MS || "60000");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt.text }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const text = await response.text();
    const capped = text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;

    // OpenAI-compatible responses wrap content in choices.message.content
    let content = capped;
    try {
      const wrapper = JSON.parse(capped);
      if (wrapper.choices && Array.isArray(wrapper.choices) && wrapper.choices[0]?.message?.content) {
        content = String(wrapper.choices[0].message.content);
      }
    } catch {
      // not a wrapper; treat raw response as the content
    }

    const json = extractLastJson(content);
    if (!json) {
      throw new Error("no JSON object found in response");
    }

    const data = JSON.parse(json);
    if (prompt.type === "specify") {
      return { type: "specify", data: data as LlmSpecifyResponse };
    }
    return { type: "decompose", data: data as LlmDecomposeResponse };
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
