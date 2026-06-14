import { getDb, getBoardDataDir } from "../db";
import { showBoard } from "./board";
import { showTask, type Task } from "./task";
import { isEnabled, FF_CREATED_BY } from "../flags";
import { resolve, isAbsolute } from "node:path";

// Field-level caps for prompt overflow prevention.
const TITLE_CAP = 500;
const BODY_CAP = 8000;
const PARENT_RESULT_CAP = 2000;
const PRIOR_ATTEMPT_SUMMARY_CAP = 2000;
const PRIOR_ATTEMPT_ERROR_CAP = 2000;
const COMMENT_CAP = 2000;
const ROLE_HISTORY_NOTE_CAP = 500;

const ATTACHMENTS_CAP = 20;
const PARENTS_CAP = 10;
const ATTEMPTS_CAP = 20;
const ROLE_HISTORY_CAP = 100;
const COMMENTS_CAP = 50;

const ROLE_HISTORY_KINDS = new Set([
  "created",
  "assigned",
  "unassigned",
  "claimed",
  "reclaimed",
  "completed",
  "blocked",
  "unblocked",
  "reviewed",
  "specified",
  "ready",
  "scheduled",
  "heartbeat",
]);

export interface ParentResult {
  task_id: number;
  title: string;
  result: string;
  summary: string;
}

export interface PriorAttempt {
  run_id: number;
  profile: string | null;
  status: string;
  outcome: string | null;
  summary: string;
  error: string;
  started_at: number;
  ended_at: number | null;
}

export interface RoleHistoryEntry {
  at: number;
  event: string;
  actor: string;
  note: string | null;
}

export interface ContextComment {
  id: number;
  author: string;
  text: string;
  created_at: number;
}

export interface ContextAttachment {
  filename: string;
  absolute_path: string;
}

export interface TaskContext {
  task_id: number;
  title: string;
  assignee?: string;
  status: string;
  priority: number;
  tenant?: string;
  created_by?: string;
  body: string;
  parents: ParentResult[];
  older_parents_omitted: number;
  prior_attempts: PriorAttempt[];
  older_attempts_omitted: number;
  role_history: RoleHistoryEntry[];
  older_role_history_omitted: number;
  comments: ContextComment[];
  older_comments_omitted: number;
  attachments: ContextAttachment[];
}

export function capText(text: string | null, max: number): string {
  const normalized = (text ?? "").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return normalized.slice(0, max) + "\n[truncated]";
}

function loadTaskHeader(task: Task): Pick<TaskContext, "task_id" | "title" | "assignee" | "status" | "priority" | "tenant" | "created_by"> {
  const header: Pick<TaskContext, "task_id" | "title" | "assignee" | "status" | "priority" | "tenant" | "created_by"> = {
    task_id: task.id,
    title: capText(task.title, TITLE_CAP),
    status: task.status,
    priority: task.priority,
  };

  if (task.assignee !== null) {
    header.assignee = task.assignee;
  }
  if (task.tenant !== null) {
    header.tenant = task.tenant;
  }
  if (isEnabled(FF_CREATED_BY)) {
    header.created_by = task.created_by;
  }

  return header;
}

function loadTaskBody(task: Task): string {
  return capText(task.body, BODY_CAP);
}

function loadParentResults(taskId: number): { parents: ParentResult[]; older_parents_omitted: number } {
  const db = getDb();
  const rows = db.query(
    `SELECT t.id, t.title, t.result, t.summary
     FROM dependencies d
     JOIN tasks t ON t.id = d.parent_id
     WHERE d.child_id = ? AND t.status = 'done' AND t.archived_at IS NULL
     ORDER BY d.parent_id ASC`
  ).all(taskId) as { id: number; title: string | null; result: string | null; summary: string | null }[];

  const capped = rows.slice(0, PARENTS_CAP).map((row) => ({
    task_id: row.id,
    title: capText(row.title, PARENT_RESULT_CAP),
    result: capText(row.result, PARENT_RESULT_CAP),
    summary: capText(row.summary, PARENT_RESULT_CAP),
  }));

  return {
    parents: capped,
    older_parents_omitted: Math.max(0, rows.length - PARENTS_CAP),
  };
}

function loadPriorAttempts(taskId: number): { prior_attempts: PriorAttempt[]; older_attempts_omitted: number } {
  const db = getDb();
  const rows = db.query(
    `SELECT id, profile, status, outcome, summary, error, started_at, ended_at
     FROM task_runs
     WHERE task_id = ?
     ORDER BY started_at DESC`
  ).all(taskId) as {
    id: number;
    profile: string | null;
    status: string;
    outcome: string | null;
    summary: string | null;
    error: string | null;
    started_at: number;
    ended_at: number | null;
  }[];

  const capped = rows.slice(0, ATTEMPTS_CAP).map((row) => ({
    run_id: row.id,
    profile: row.profile,
    status: row.status,
    outcome: row.outcome,
    summary: capText(row.summary, PRIOR_ATTEMPT_SUMMARY_CAP),
    error: capText(row.error, PRIOR_ATTEMPT_ERROR_CAP),
    started_at: row.started_at,
    ended_at: row.ended_at,
  }));

  return {
    prior_attempts: capped,
    older_attempts_omitted: Math.max(0, rows.length - ATTEMPTS_CAP),
  };
}

function parsePayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function getRunProfile(runId: number): string | null {
  const db = getDb();
  const row = db.query(
    "SELECT profile FROM task_runs WHERE id = ?"
  ).get(runId) as { profile: string | null } | undefined;
  return row?.profile ?? null;
}

function deriveActor(kind: string, task: Task, runId: number | null, payload: Record<string, unknown>): string {
  if (kind === "created") {
    return task.created_by;
  }
  if (kind === "assigned") {
    return (payload.assignee ?? "unknown") as string;
  }
  if (kind === "claimed" || kind === "reclaimed") {
    if (runId !== null) {
      const profile = getRunProfile(runId);
      if (profile) return profile;
    }
    return (payload.profile ?? "unknown") as string;
  }
  return (payload.actor ?? payload.by ?? payload.profile ?? payload.assignee ?? "unknown") as string;
}

function extractNote(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === "blocked" || kind === "reclaimed" || kind === "reviewed") {
    return (payload.reason ?? null) as string | null;
  }
  if (kind === "heartbeat") {
    return (payload.note ?? null) as string | null;
  }
  return null;
}

function loadRoleHistory(taskId: number, task: Task): { role_history: RoleHistoryEntry[]; older_role_history_omitted: number } {
  const db = getDb();
  const rows = db.query(
    `SELECT id, run_id, kind, payload, created_at
     FROM task_events
     WHERE task_id = ?
     ORDER BY created_at ASC`
  ).all(taskId) as {
    id: number;
    run_id: number | null;
    kind: string;
    payload: string | null;
    created_at: number;
  }[];

  const relevant = rows.filter((row) => ROLE_HISTORY_KINDS.has(row.kind));
  const capped = relevant.slice(0, ROLE_HISTORY_CAP).map((row) => {
    const payload = parsePayload(row.payload);
    const actor = deriveActor(row.kind, task, row.run_id, payload);
    const note = extractNote(row.kind, payload);
    return {
      at: row.created_at,
      event: row.kind,
      actor,
      note: note === null ? null : capText(note, ROLE_HISTORY_NOTE_CAP),
    };
  });

  return {
    role_history: capped,
    older_role_history_omitted: Math.max(0, relevant.length - ROLE_HISTORY_CAP),
  };
}

function detectCommentsAuthorColumn(): boolean {
  const db = getDb();
  try {
    const cols = db.query("PRAGMA table_info(comments)").all() as { name: string }[];
    return cols.some((c) => c.name === "author");
  } catch {
    return false;
  }
}

function loadComments(taskId: number): { comments: ContextComment[]; older_comments_omitted: number } {
  const db = getDb();
  const hasAuthor = detectCommentsAuthorColumn();
  const rows = db.query(
    hasAuthor
      ? `SELECT id, author, text, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC`
      : `SELECT id, text, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC`
  ).all(taskId) as { id: number; author?: string; text: string; created_at: number }[];

  const capped = rows.slice(0, COMMENTS_CAP).map((row) => ({
    id: row.id,
    author: row.author ?? "user",
    text: capText(row.text, COMMENT_CAP),
    created_at: row.created_at,
  }));

  return {
    comments: capped,
    older_comments_omitted: Math.max(0, rows.length - COMMENTS_CAP),
  };
}

function resolveAttachmentPath(storedPath: string, boardSlug: string, taskId: number): string {
  if (isAbsolute(storedPath)) {
    return storedPath;
  }
  return resolve(getBoardDataDir(boardSlug), "attachments", String(taskId), storedPath);
}

function loadAttachments(taskId: number, boardSlug: string): { attachments: ContextAttachment[] } {
  const db = getDb();
  let rows: { filename: string; stored_path: string }[] = [];
  try {
    rows = db.query(
      `SELECT filename, stored_path FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`
    ).all(taskId) as { filename: string; stored_path: string }[];
  } catch {
    // Tolerate missing task_attachments table (KDI-022 not yet merged).
    rows = [];
  }

  const capped = rows.slice(0, ATTACHMENTS_CAP).map((row) => ({
    filename: row.filename,
    absolute_path: resolveAttachmentPath(row.stored_path, boardSlug, taskId),
  }));

  return { attachments: capped };
}

export function buildTaskContext(taskId: number, boardSlug: string): TaskContext {
  const board = showBoard(boardSlug, false);
  if (!board) {
    throw new Error(`Board "${boardSlug}" not found or is archived.`);
  }

  const task = showTask(taskId);
  if (!task || task.board_id !== board.id) {
    throw new Error(`Task ${taskId} not found or is archived.`);
  }

  const header = loadTaskHeader(task);
  const body = loadTaskBody(task);
  const { parents, older_parents_omitted } = loadParentResults(taskId);
  const { prior_attempts, older_attempts_omitted } = loadPriorAttempts(taskId);
  const { role_history, older_role_history_omitted } = loadRoleHistory(taskId, task);
  const { comments, older_comments_omitted } = loadComments(taskId);
  const { attachments } = loadAttachments(taskId, boardSlug);

  return {
    ...header,
    body,
    parents,
    older_parents_omitted,
    prior_attempts,
    older_attempts_omitted,
    role_history,
    older_role_history_omitted,
    comments,
    older_comments_omitted,
    attachments,
  };
}
