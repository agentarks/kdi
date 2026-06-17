import { getDb } from "../db";
import { showTask, type Task } from "./task";
import { addEvent } from "./taskEvent";

const TEMPLATE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 255;
const MAX_STEPS = 100;
const MAX_STEP_KEY_LENGTH = 255;

export interface WorkflowTemplate {
  id: number;
  board_id: number;
  template_id: string;
  name: string;
  steps: string[];
  created_at: number;
  updated_at: number;
}


export function defineWorkflowTemplate(
  boardId: number,
  templateId: string,
  name: string,
  steps: string[]
): WorkflowTemplate {
  if (!TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new Error(
      `Invalid template id "${templateId}". Use only letters, numbers, underscores, and hyphens.`
    );
  }

  if (templateId.length > 255) {
    throw new Error("Template id must be 255 characters or fewer.");
  }

  const trimmedName = name.trim();
  if (trimmedName === "") {
    throw new Error("Template name cannot be empty.");
  }

  if (trimmedName.length > MAX_NAME_LENGTH) {
    throw new Error(`Template name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("Template must have at least one step.");
  }

  if (steps.length > MAX_STEPS) {
    throw new Error(`Template cannot have more than ${MAX_STEPS} steps.`);
  }

  const seen = new Set<string>();
  for (const step of steps) {
    const trimmed = step.trim();
    if (trimmed === "") {
      throw new Error("Step keys cannot be empty.");
    }
    if (trimmed.length > MAX_STEP_KEY_LENGTH) {
      throw new Error(
        `Step key "${trimmed}" exceeds ${MAX_STEP_KEY_LENGTH} characters.`
      );
    }
    if (seen.has(trimmed)) {
      throw new Error(`Duplicate step key "${trimmed}".`);
    }
    seen.add(trimmed);
  }

  const normalizedSteps = steps.map((s) => s.trim());
  const stepsJson = JSON.stringify(normalizedSteps);
  const db = getDb();

  const upsert = db.transaction(() => {
    const existing = db
      .query(
        "SELECT id FROM workflow_templates WHERE board_id = ? AND template_id = ?"
      )
      .get(boardId, templateId) as { id: number } | undefined;

    if (existing) {
      db.run(
        "UPDATE workflow_templates SET name = ?, steps = ?, updated_at = unixepoch() WHERE id = ?",
        [trimmedName, stepsJson, existing.id]
      );
      return existing.id;
    }

    const result = db.run(
      "INSERT INTO workflow_templates (board_id, template_id, name, steps) VALUES (?, ?, ?, ?)",
      [boardId, templateId, trimmedName, stepsJson]
    );
    return Number(result.lastInsertRowid);
  });

  const id = upsert();
  const template = getWorkflowTemplateById(id);
  if (!template) {
    throw new Error("Template not found after upsert.");
  }
  return template;
}

export function listWorkflowTemplates(boardId: number): WorkflowTemplate[] {
  const db = getDb();
  const rows = db
    .query(
      "SELECT id, board_id, template_id, name, steps, created_at, updated_at FROM workflow_templates WHERE board_id = ? ORDER BY template_id ASC"
    )
    .all(boardId) as WorkflowTemplate[];
  return rows.map(hydrateTemplate);
}

export function getWorkflowTemplate(
  boardId: number,
  templateId: string
): WorkflowTemplate | null {
  const db = getDb();
  const row = db
    .query(
      "SELECT id, board_id, template_id, name, steps, created_at, updated_at FROM workflow_templates WHERE board_id = ? AND template_id = ?"
    )
    .get(boardId, templateId) as WorkflowTemplate | undefined;
  return row ? hydrateTemplate(row) : null;
}

function getWorkflowTemplateById(id: number): WorkflowTemplate | null {
  const db = getDb();
  const row = db
    .query(
      "SELECT id, board_id, template_id, name, steps, created_at, updated_at FROM workflow_templates WHERE id = ?"
    )
    .get(id) as WorkflowTemplate | undefined;
  return row ? hydrateTemplate(row) : null;
}

function hydrateTemplate(raw: WorkflowTemplate): WorkflowTemplate {
  return {
    ...raw,
    steps: parseSteps(raw.steps),
  };
}

function parseSteps(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // fall through
    }
  }
  return [];
}

export function validateStepKey(template: WorkflowTemplate, key: string): void {
  if (!template.steps.includes(key)) {
    throw new Error(
      `Step "${key}" not found in workflow template "${template.template_id}". Valid steps: ${template.steps.join(", ")}`
    );
  }
}

export function advanceTaskStep(taskId: number, reason?: string): Task {
  const db = getDb();
  const task = showTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found or already archived.`);
  }

  const template = requireTemplate(task);
  const currentKey = task.current_step_key;
  const currentIndex = currentKey === null ? -1 : template.steps.indexOf(currentKey);

  if (currentKey !== null && currentIndex === -1) {
    throw new Error(
      `Task ${taskId} is on step "${currentKey}" which no longer exists in template "${template.template_id}".`
    );
  }

  const nextIndex = currentIndex + 1;
  const isTerminal = nextIndex >= template.steps.length;

  return db.transaction(() => {
    if (isTerminal) {
      db.run(
        "UPDATE tasks SET status = 'done', current_step_key = NULL, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL",
        [taskId]
      );
    } else {
      db.run(
        "UPDATE tasks SET current_step_key = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL",
        [template.steps[nextIndex], taskId]
      );
    }

    const updated = showTask(taskId);
    if (!updated) {
      throw new Error(`Task ${taskId} not found after step update.`);
    }

    const payload: Record<string, unknown> = {};
    if (currentKey !== null) payload.from = currentKey;
    if (!isTerminal) payload.to = updated.current_step_key;
    if (reason) payload.reason = reason;

    addEvent(taskId, "stepped", payload);

    if (isTerminal) {
      addEvent(taskId, "completed", { source: "workflow_terminal_step" });
    }

    return updated;
  })();
}

export function setTaskStep(
  taskId: number,
  targetKey: string,
  reason?: string
): Task {
  const db = getDb();
  const task = showTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found or already archived.`);
  }

  const template = requireTemplate(task);
  validateStepKey(template, targetKey);

  const previousKey = task.current_step_key;

  return db.transaction(() => {
    db.run(
      "UPDATE tasks SET current_step_key = ?, updated_at = unixepoch() WHERE id = ? AND archived_at IS NULL",
      [targetKey, taskId]
    );

    const updated = showTask(taskId);
    if (!updated) {
      throw new Error(`Task ${taskId} not found after step update.`);
    }

    const payload: Record<string, unknown> = { to: targetKey };
    if (previousKey !== null) payload.from = previousKey;
    if (reason) payload.reason = reason;

    addEvent(taskId, "stepped", payload);
    return updated;
  })();
}

function requireTemplate(task: Task): WorkflowTemplate {
  if (!task.workflow_template_id) {
    throw new Error(`Task ${task.id} has no workflow template.`);
  }
  const template = getWorkflowTemplate(task.board_id, task.workflow_template_id);
  if (!template) {
    throw new Error(
      `Workflow template "${task.workflow_template_id}" not found for task ${task.id}. Define it with 'kdi workflows define'.`
    );
  }
  return template;
}
