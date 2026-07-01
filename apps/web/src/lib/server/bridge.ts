// KDI-UI-001: server-side data bridge. Single choke point that imports the CLI
// model layer and returns UI-shaped JSON. All SvelteKit /api/+server.ts routes
// import from here so SQLite (and every model import) stays server-side.
//
// Routing adapters translate Request <-> bridge; tests call bridge functions
// directly so no HTTP process is needed.
//
// ponytail: one bridge module, one toCamel helper, one error mapper — avoids
// per-route drift (spec: "one helper to avoid drift").

// dev flag: include stack traces in error responses only when not in production.
// ponytail: read NODE_ENV directly instead of $app/environment so the bridge is
// unit-testable under `bun test` without SvelteKit's virtual-module resolution.
const dev = process.env.NODE_ENV !== "production";

// TYPE-only imports are erased at runtime, so they never pull `bun:sqlite` into
// the build-time Node module graph (they only feed svelte-check, which resolves
// `bun:sqlite` types from the hoisted bun-types at the repo root).
// Spec FR-1: models are imported via the `~/*` alias the CLI already uses.
import type { Board, BoardMetadata, BoardWithTaskCounts, BoardStats } from "~/models/board";
import type { Task, Task as TaskModel, CreateTaskInput } from "~/models/task";
import type { TaskEvent } from "~/models/taskEvent";
import type { TaskRun } from "~/models/taskRun";
import type { Comment } from "~/models/comment";
import type { TaskAttachment } from "~/models/taskAttachment";
import type { TaskContext } from "~/models/context";
import type { WorkflowTemplate } from "~/models/workflowTemplate";
import type { NotifySub } from "~/models/notifySub";
import type { DiagnosticFinding, DiagnosticSeverity } from "~/models/diagnostic";

// Runtime model import is DYNAMIC (string-literal) and cached. This keeps
// `bun:sqlite` (pulled transitively by the CLI models via ../db) out of the
// build-time Node module graph so the adapter-node SvelteKit build (which
// targets Node) does not choke on the `bun:` URL scheme during SSR chunk
// analysis. The bridge is only ever executed under Bun, where bun:sqlite
// resolves natively at runtime; vite.ssr.external emits it as external.
// Mirrors the proven KDI-UI-000 / KDI-UI-014 pattern.
type Modules = {
  initDb: typeof import("~/db")["initDb"];
  listBoards: typeof import("~/models/board")["listBoards"];
  showBoard: typeof import("~/models/board")["showBoard"];
  createBoard: typeof import("~/models/board")["createBoard"];
  getBoardStats: typeof import("~/models/board")["getBoardStats"];
  listTasks: typeof import("~/models/task")["listTasks"];
  showTask: typeof import("~/models/task")["showTask"];
  createTask: typeof import("~/models/task")["createTask"];
  getAssigneeCounts: typeof import("~/models/task")["getAssigneeCounts"];
  getEvents: typeof import("~/models/taskEvent")["getEvents"];
  tailEvents: typeof import("~/models/taskEvent")["tailEvents"];
  getRecentEvents: typeof import("~/models/taskEvent")["getRecentEvents"];
  getEventsAfter: typeof import("~/models/taskEvent")["getEventsAfter"];
  getRuns: typeof import("~/models/taskRun")["getRuns"];
  getRunsFiltered: typeof import("~/models/taskRun")["getRunsFiltered"];
  getRun: typeof import("~/models/taskRun")["getRun"];
  getComments: typeof import("~/models/comment")["getComments"];
  listAttachments: typeof import("~/models/taskAttachment")["listAttachments"];
  buildTaskContext: typeof import("~/models/context")["buildTaskContext"];
  runDiagnostics: typeof import("~/models/diagnostic")["runDiagnostics"];
  listWorkflowTemplates: typeof import("~/models/workflowTemplate")["listWorkflowTemplates"];
  listSubscriptions: typeof import("~/models/notifySub")["listSubscriptions"];
};
let _models: Promise<Modules> | null = null;
async function models(): Promise<Modules> {
  if (!_models) {
    _models = (async () => {
      // Dynamic string-literal imports via the `~/*` alias (spec FR-1). Kept
      // dynamic so bun:sqlite (pulled transitively via ~/db) stays out of the
      // build-time Node module graph; vite resolves the alias at build time.
      const [db, board, task, taskEvent, taskRun, comment, taskAttachment, context, diagnostic, workflowTemplate, notifySub] =
        await Promise.all([
          import("~/db"),
          import("~/models/board"),
          import("~/models/task"),
          import("~/models/taskEvent"),
          import("~/models/taskRun"),
          import("~/models/comment"),
          import("~/models/taskAttachment"),
          import("~/models/context"),
          import("~/models/diagnostic"),
          import("~/models/workflowTemplate"),
          import("~/models/notifySub"),
        ]);
      return {
        ...db,
        ...board,
        ...task,
        ...taskEvent,
        ...taskRun,
        ...comment,
        ...taskAttachment,
        ...context,
        ...diagnostic,
        ...workflowTemplate,
        ...notifySub,
      } as Modules;
    })();
  }
  return _models;
}

// ---------------------------------------------------------------------------
// Feature-flag gate
// ---------------------------------------------------------------------------

// FF_SVELTEKIT_FRONTEND is read straight from process.env to match the existing
// apps/web/src/hooks.server.ts master gate. It is intentionally NOT routed
// through src/flags.ts isEnabled (pre-existing: that flag is unregistered
// there). ponytail: one inline env read here (single caller, gate()); no wrapper.
//
// Routes call gate() first; when the flag is off it returns the spec-defined
// 503 { enabled:false } so feature-detect works without a redirect.
export function gate(): Response | null {
  if (process.env.FF_SVELTEKIT_FRONTEND !== "true") {
    return new Response(JSON.stringify({ enabled: false }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

// initDb() is called inside the bridge functions themselves (createBoardJson,
// resolveBoard, subscriptionsJson) — idempotent and per-path cached in
// src/db.ts, so KDI_DB / KDI_DB_PATH / default resolution is honored without a
// separate bootstrap helper. ponytail: no ensureDb() wrapper; callers initDb().

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export class BridgeError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

// Map CLI model errors (plain Error with known messages) to BridgeError. One
// place so the route tree never drifts. ponytail: string matching is the
// stable contract the models already provide; they validate and throw.
function wrap(err: unknown): BridgeError {
  const message = err instanceof Error ? err.message : String(err);
  if (/Invalid .*slug.*Slugs may only contain/.test(message)) return new BridgeError("invalid_slug", 400, message);
  if (/already exists/.test(message)) return new BridgeError("board_exists", 409, message);
  if (/not found or is archived/.test(message)) return new BridgeError("board_not_found", 404, message);
  if (/cannot be empty|must be 255|requires scheduled_at|A board id is required|title is required/.test(message))
    return new BridgeError("invalid_input", 400, message);
  if (/Database not initialized/.test(message)) return new BridgeError("db_not_initialized", 500, message);
  return new BridgeError("internal", 500, message);
}

// Build a JSON error Response. Dev keeps the stack for local debugging; prod
// shows only the human message.
export function errorResponse(err: unknown): Response {
  const be = err instanceof BridgeError ? err : wrap(err);
  const message = dev && err instanceof Error && err.stack ? `${be.message}\n${err.stack}` : be.message;
  return new Response(JSON.stringify({ error: be.code, message }), {
    status: be.status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// camelCase normalization
// ---------------------------------------------------------------------------

// Converts snake_case keys to camelCase recursively over plain objects and
// arrays. Primitive values (incl. JSON-string payloads) are left untouched.
// Already-camelCase keys (no underscore) are a no-op. One helper for the whole
// bridge so the browser always sees one convention ( ponytail: not eleven).
// CamelCase<T> is the static mirror so responses are genuinely typed, not
// fake-cast onto snake_case model interfaces.
type Camel<S extends string> = S extends `${infer A}_${infer B}`
  ? `${A}${Camel<Capitalize<B>>}`
  : S;
type CamelCase<T> = [T] extends [Array<infer U>]
  ? Array<CamelCase<U>>
  : [T] extends [object]
    ? { [K in keyof T as Camel<string & K>]: CamelCase<T[K]> }
    : T;

function toCamel<T>(input: T): CamelCase<T> {
  if (Array.isArray(input)) return (input as unknown[]).map(toCamel) as CamelCase<T>;
  if (input === null || typeof input !== "object") return input as CamelCase<T>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // ponytail: one regex replaces the split/map/join; no _ means a no-op match.
    const camelKey = key.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    out[camelKey] = toCamel(value);
  }
  return out as CamelCase<T>;
}

// ---------------------------------------------------------------------------
// Resolved board helper
// ---------------------------------------------------------------------------

async function resolveBoard(slug: string): Promise<BoardWithTaskCounts> {
  const m = await models();
  m.initDb();
  const board = m.showBoard(slug, false);
  if (!board) throw new BridgeError("board_not_found", 404, `Board "${slug}" not found.`);
  return board;
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

export interface BoardSummary {
  id: number;
  slug: string;
  name: string;
  workdir: string;
  baseRef: string;
  archived: boolean;
  taskCounts: Record<string, number>;
}

async function withCounts(b: Board): Promise<BoardSummary> {
  // listBoards returns Board[] without counts; showBoard returns BoardWithTaskCounts.
  // ponytail: N+1 (one showBoard per board); upgrade to a grouped COUNT if the
  // board count ever makes this noticeable.
  const m = await models();
  const full = m.showBoard(b.slug, false);
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    workdir: b.workdir,
    baseRef: b.base_ref,
    archived: b.archived_at !== null,
    taskCounts: full ? full.taskCounts : {},
  };
}

export async function listBoardsJson(params: URLSearchParams): Promise<{ boards: BoardSummary[] }> {
  const m = await models();
  m.initDb();
  const includeArchived = params.get("includeArchived") === "true";
  const boards = await Promise.all(m.listBoards(includeArchived).map(withCounts));
  return { boards };
}

export interface CreateBoardInput {
  slug: string;
  workdir: string;
  baseRef?: string;
  metadata?: BoardMetadata;
}

export async function createBoardJson(input: CreateBoardInput): Promise<{ board: BoardSummary }> {
  if (typeof input.slug !== "string" || input.slug.trim() === "")
    throw new BridgeError("invalid_input", 400, "slug is required");
  if (typeof input.workdir !== "string" || input.workdir.trim() === "")
    throw new BridgeError("invalid_input", 400, "workdir is required");
  const m = await models();
  m.initDb();
  try {
    m.createBoard(input.slug, input.workdir, input.baseRef ?? "origin/main", input.metadata ?? {});
  } catch (err) {
    throw wrap(err);
  }
  const full = m.showBoard(input.slug, false)!;
  return { board: await withCounts(full) };
}

export async function showBoardJson(slug: string): Promise<{ board: CamelCase<BoardWithTaskCounts> }> {
  const board = await resolveBoard(slug);
  return { board: toCamel(board) };
}

export async function boardStatsJson(slug: string): Promise<{ stats: CamelCase<BoardStats> }> {
  await resolveBoard(slug);
  const m = await models();
  return { stats: toCamel(m.getBoardStats(slug)) };
}

export async function assigneesJson(slug: string): Promise<{ assignees: Record<string, number> }> {
  const board = await resolveBoard(slug);
  const m = await models();
  return { assignees: m.getAssigneeCounts(board.id) };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskSummary {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  priority: number;
  tenant: string | null;
  updatedAt: number;
  archivedAt: number | null;
}

function toTaskSummary(t: TaskModel): TaskSummary {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    tenant: t.tenant,
    updatedAt: t.updated_at,
    archivedAt: t.archived_at,
  };
}

export async function listTasksJson(
  slug: string,
  params: URLSearchParams,
): Promise<{ tasks: TaskSummary[] }> {
  const board = await resolveBoard(slug);
  const m = await models();
  const tasks = m.listTasks(
    {
      board_id: board.id,
      status: (params.get("status") as Task["status"] | null) ?? undefined,
      assignee: params.get("assignee") ?? undefined,
      tenant: params.get("tenant") ?? undefined,
      includeArchived: params.get("includeArchived") === "true",
      session_id: params.get("sessionId") ?? undefined,
      workflow_template_id: params.get("workflowTemplateId") ?? undefined,
      current_step_key: params.get("currentStepKey") ?? undefined,
    },
    params.get("sort") ?? undefined,
  );
  return { tasks: tasks.map(toTaskSummary) };
}

// The bridge create-task body is the model's own CreateTaskInput minus board_id
// (the slug in the URL supplies the board). ponytail: reuse the model type so a
// new model field flows through the API without a manual bridge edit; this now
// also exposes workspace_kind / branch / swarm_parent_id, which are valid
// createTask inputs the manual list had silently dropped.
export type CreateTaskBody = Omit<CreateTaskInput, "board_id">;

export async function createTaskJson(slug: string, body: CreateTaskBody): Promise<{ task: TaskSummary }> {
  // Trust-boundary guards run before the model call: required title, and reject
  // `archived` (not a legal initial status). ponytail: never simplify away
  // input validation at trust boundaries.
  if (typeof body.title !== "string" || body.title.trim() === "")
    throw new BridgeError("invalid_input", 400, "title is required");
  if ((body.initialStatus as string) === "archived")
    throw new BridgeError("invalid_input", 400, "initialStatus 'archived' is not allowed.");
  // createTask returns the full Task and already emits the "created" event,
  // mirroring the CLI side effects. Spread the body and set board_id — ponytail:
  // one spread instead of re-listing 23 fields (drift-proof).
  const board = await resolveBoard(slug);
  const m = await models();
  try {
    const task = m.createTask({ ...body, board_id: board.id });
    return { task: toTaskSummary(task) };
  } catch (err) {
    throw wrap(err);
  }
}

export async function showTaskJson(slug: string, id: number): Promise<{ task: CamelCase<TaskModel> }> {
  const board = await resolveBoard(slug);
  const m = await models();
  const task = m.showTask(id);
  if (!task || task.board_id !== board.id)
    throw new BridgeError("task_not_found", 404, `Task ${id} not found on board "${slug}".`);
  return { task: toCamel(task) };
}

// ---------------------------------------------------------------------------
// Task events / runs / context / comments / attachments
// ---------------------------------------------------------------------------

export async function taskEventsJson(
  slug: string,
  id: number,
  params: URLSearchParams,
): Promise<{ events: CamelCase<TaskEvent>[] }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  const since = params.get("since");
  const events = since !== null ? m.tailEvents(id, Number(since)) : m.getEvents(id);
  return { events: toCamel(events) };
}

export async function taskRunsJson(
  slug: string,
  id: number,
  params: URLSearchParams,
): Promise<{ runs: CamelCase<TaskRun>[] }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  const stateType = params.get("stateType");
  const stateName = params.get("stateName");
  if (stateType !== null && stateName !== null) {
    try {
      return { runs: toCamel(m.getRunsFiltered(id, { stateType, stateName })) };
    } catch (err) {
      throw wrap(err);
    }
  }
  return { runs: toCamel(m.getRuns(id)) };
}

export async function showRunJson(
  slug: string,
  id: number,
  runId: number,
): Promise<{ run: CamelCase<TaskRun> | null }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  const run = m.getRun(runId);
  return { run: run ? toCamel(run) : null };
}

export async function taskContextJson(slug: string, id: number): Promise<{ context: CamelCase<TaskContext> }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  return { context: toCamel(m.buildTaskContext(id, slug)) };
}

export async function taskCommentsJson(slug: string, id: number): Promise<{ comments: CamelCase<Comment>[] }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  return { comments: toCamel(m.getComments(id)) };
}

export async function taskAttachmentsJson(
  slug: string,
  id: number,
): Promise<{ attachments: CamelCase<TaskAttachment>[] }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  return { attachments: toCamel(m.listAttachments(id)) };
}

export async function assertTaskOnBoard(slug: string, id: number): Promise<void> {
  const board = await resolveBoard(slug);
  const m = await models();
  const task = m.showTask(id);
  if (!task || task.board_id !== board.id)
    throw new BridgeError("task_not_found", 404, `Task ${id} not found on board "${slug}".`);
}

// ---------------------------------------------------------------------------
// Board-level events / diagnostics / workflows
// ---------------------------------------------------------------------------

export async function boardEventsJson(
  slug: string,
  params: URLSearchParams,
): Promise<{ events: CamelCase<TaskEvent>[] }> {
  await resolveBoard(slug);
  const m = await models();
  const assignee = params.get("assignee") ?? undefined;
  const tenant = params.get("tenant") ?? undefined;
  const kinds = params.get("kinds") ? params.get("kinds")!.split(",") : undefined;
  const filters = { assignee, tenant, kinds };
  const since = params.get("since");
  const limit = params.get("limit") ? Number(params.get("limit")) : 50;
  const events = since !== null ? m.getEventsAfter(Number(since), filters) : m.getRecentEvents(limit, filters);
  return { events: toCamel(events) };
}

export async function diagnosticsJson(
  slug: string,
  params: URLSearchParams,
): Promise<{ diagnostics: CamelCase<DiagnosticFinding>[] }> {
  await resolveBoard(slug);
  const m = await models();
  const taskId = params.get("taskId") ? Number(params.get("taskId")) : undefined;
  const severity = (params.get("severity") as DiagnosticSeverity | null) ?? undefined;
  try {
    return { diagnostics: toCamel(m.runDiagnostics(slug, { taskId, severity })) };
  } catch (err) {
    throw wrap(err);
  }
}

export async function workflowsJson(slug: string): Promise<{ templates: CamelCase<WorkflowTemplate>[] }> {
  const board = await resolveBoard(slug);
  const m = await models();
  return { templates: toCamel(m.listWorkflowTemplates(board.id)) };
}

// ---------------------------------------------------------------------------
// Subscriptions (board-scoped)
// ---------------------------------------------------------------------------

export async function subscriptionsJson(
  params: URLSearchParams,
): Promise<{ subscriptions: CamelCase<NotifySub>[] }> {
  const m = await models();
  m.initDb();
  const includeArchived = params.get("includeArchived") === "true";
  const taskId = params.get("taskId") ? Number(params.get("taskId")) : undefined;
  const boardSlug = params.get("board") ?? "";
  let boardId: number | undefined;
  if (taskId === undefined) {
    if (boardSlug === "") throw new BridgeError("invalid_input", 400, "board or taskId is required");
    const board = m.showBoard(boardSlug, false);
    if (!board) throw new BridgeError("board_not_found", 404, `Board "${boardSlug}" not found.`);
    boardId = board.id;
  }
  try {
    return { subscriptions: toCamel(m.listSubscriptions(taskId, includeArchived, boardId)) };
  } catch (err) {
    throw wrap(err);
  }
}