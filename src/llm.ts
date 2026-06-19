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
const MAX_CONTENT_BYTES = 16384;

function getBoardSlug(boardId: number): string {
  const board = getBoardById(boardId);
  return board?.slug ?? String(boardId);
}

// Scan a string for the last balanced top-level `{...}` substring. Handles
// multi-line and pretty-printed JSON by tracking brace depth and string
// state, including backslash escapes. Returns the last candidate whose
// substring is valid JSON, or null if none is.
function extractLastJsonObject(text: string): string | null {
  let lastValid: string | null = null;

  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "{") continue;

    const rest = text.slice(i);
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let j = 0; j < rest.length; j++) {
      const ch = rest[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end < 0) continue;
    const candidate = rest.slice(0, end + 1);
    try {
      JSON.parse(candidate);
      lastValid = candidate;
    } catch {
      // not valid JSON; keep scanning for an earlier `{`
    }
  }

  return lastValid;
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

export function buildSpecifyPrompt(task: Task): LlmPrompt & { type: "specify" } {
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

export function buildDecomposePrompt(task: Task): LlmPrompt & { type: "decompose" } {
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

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "");
}

export async function callTriageLlm(prompt: LlmPrompt & { type: "specify" }): Promise<LlmSpecifyResponse>;
export async function callTriageLlm(prompt: LlmPrompt & { type: "decompose" }): Promise<LlmDecomposeResponse>;
export async function callTriageLlm(prompt: LlmPrompt): Promise<LlmSpecifyResponse | LlmDecomposeResponse>;
export async function callTriageLlm(prompt: LlmPrompt): Promise<LlmSpecifyResponse | LlmDecomposeResponse> {
  const apiKey = Bun.env.KDI_TRIAGE_LLM_API_KEY;
  if (!apiKey) {
    throw new Error("Triage LLM API key is not configured (KDI_TRIAGE_LLM_API_KEY).");
  }

  const baseUrl = (Bun.env.KDI_TRIAGE_LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = Bun.env.KDI_TRIAGE_LLM_MODEL || "gpt-4o-mini";
  const timeoutMs = Number(Bun.env.KDI_TRIAGE_LLM_TIMEOUT_MS || "60000");
  const temperature = Number(Bun.env.KDI_TRIAGE_LLM_TEMPERATURE || "0.2");

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
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }

    // OpenAI-compatible responses wrap content in choices.message.content.
    // Detect the wrapper shape independently of content truthiness so an
    // empty / null / missing content still takes the unwrap branch instead
    // of being parsed as the JSON payload itself.
    let content: string;
    try {
      const wrapper = JSON.parse(text);
      if (
        wrapper &&
        typeof wrapper === "object" &&
        Array.isArray(wrapper.choices) &&
        wrapper.choices[0]?.message &&
        "content" in wrapper.choices[0].message
      ) {
        content = String(wrapper.choices[0].message.content ?? "");
      } else {
        content = text;
      }
    } catch {
      content = text;
    }

    if (content.length > MAX_CONTENT_BYTES) {
      throw new Error(`response content exceeded ${MAX_CONTENT_BYTES} bytes`);
    }

    const cleaned = stripCodeFences(content);
    const json = extractLastJsonObject(cleaned);
    if (!json) {
      const preview = cleaned.slice(0, 200).replace(/\s+/g, " ");
      throw new Error(`no JSON object found in response: ${preview}`);
    }

    const data = JSON.parse(json) as unknown;
    if (prompt.type === "specify") {
      if (!data || typeof data !== "object" || typeof (data as LlmSpecifyResponse).body !== "string") {
        throw new Error("specify response missing required 'body' string field");
      }
      return data as LlmSpecifyResponse;
    }
    if (!data || typeof data !== "object" || !Array.isArray((data as LlmDecomposeResponse).children)) {
      throw new Error("decompose response missing required 'children' array field");
    }
    return data as LlmDecomposeResponse;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
