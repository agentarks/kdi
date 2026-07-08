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
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Board, BoardMetadata, BoardWithTaskCounts, BoardStats } from "~/models/board";
import type { TaskSummary, TaskDetail, DetailFlags } from "$lib/types";
import type { BoardListRow, BoardFlags } from "$lib/types";

import type { Task, Task as TaskModel, CreateTaskInput } from "~/models/task";
import type { TaskEvent } from "~/models/taskEvent";
import type { TaskRun } from "~/models/taskRun";
import type { Comment } from "~/models/comment";
import type { TaskAttachment } from "~/models/taskAttachment";
import type { TaskContext } from "~/models/context";
import type { WorkflowTemplate } from "~/models/workflowTemplate";
import type { NotifySub } from "~/models/notifySub";
import type { DiagnosticFinding, DiagnosticSeverity } from "~/models/diagnostic";
import type { Profile } from "~/profiles";

// Runtime model import is DYNAMIC (string-literal) and cached. This keeps
// `bun:sqlite` (pulled transitively by the CLI models via ../db) out of the
// build-time Node module graph so the adapter-node SvelteKit build (which
// targets Node) does not choke on the `bun:` URL scheme during SSR chunk
// analysis. The bridge is only ever executed under Bun, where bun:sqlite
// resolves natively at runtime; vite.ssr.external emits it as external.
// Mirrors the proven KDI-UI-000 / KDI-UI-014 pattern.
type Modules = {
  initDb: typeof import("~/db")["initDb"];
  getDb: typeof import("~/db")["getDb"];
  listBoards: typeof import("~/models/board")["listBoards"];
  showBoard: typeof import("~/models/board")["showBoard"];
  createBoard: typeof import("~/models/board")["createBoard"];
  getBoardStats: typeof import("~/models/board")["getBoardStats"];
  updateBoardMetadata: typeof import("~/models/board")["updateBoardMetadata"];
  setDefaultWorkdir: typeof import("~/models/board")["setDefaultWorkdir"];
  renameBoardSlug: typeof import("~/models/board")["renameBoardSlug"];
  archiveBoard: typeof import("~/models/board")["archiveBoard"];
  removeBoard: typeof import("~/models/board")["removeBoard"];
  listTasks: typeof import("~/models/task")["listTasks"];
  showTask: typeof import("~/models/task")["showTask"];
  createTask: typeof import("~/models/task")["createTask"];
  getAssigneeCounts: typeof import("~/models/task")["getAssigneeCounts"];
  getEvents: typeof import("~/models/taskEvent")["getEvents"];
  tailEvents: typeof import("~/models/taskEvent")["tailEvents"];
  getRecentEvents: typeof import("~/models/taskEvent")["getRecentEvents"];
  getRecentTaskEvents: typeof import("~/models/taskEvent")["getRecentTaskEvents"];
  getEventsAfter: typeof import("~/models/taskEvent")["getEventsAfter"];
  getRuns: typeof import("~/models/taskRun")["getRuns"];
  getRunsFiltered: typeof import("~/models/taskRun")["getRunsFiltered"];
  getRun: typeof import("~/models/taskRun")["getRun"];
  getComments: typeof import("~/models/comment")["getComments"];
  listAttachments: typeof import("~/models/taskAttachment")["listAttachments"];
  buildTaskContext: typeof import("~/models/context")["buildTaskContext"];
  runDiagnostics: typeof import("~/models/diagnostic")["runDiagnostics"];
  listWorkflowTemplates: typeof import("~/models/workflowTemplate")["listWorkflowTemplates"];
  getWorkflowTemplate: typeof import("~/models/workflowTemplate")["getWorkflowTemplate"];
  validateStepKey: typeof import("~/models/workflowTemplate")["validateStepKey"];
  listSubscriptions: typeof import("~/models/notifySub")["listSubscriptions"];
  addDependency: typeof import("~/models/dependency")["addDependency"];
  getChildTasks: typeof import("~/models/dependency")["getChildTasks"];
  loadProfiles: typeof import("~/profiles")["loadProfiles"];
  getProfile: typeof import("~/profiles")["getProfile"];
  editTask: typeof import("~/models/task")["editTask"];
  parseDuration: typeof import("~/models/task")["parseDuration"];
  getTaskLogPath: typeof import("~/observability")["getTaskLogPath"];
};
let _models: Promise<Modules> | null = null;
async function models(): Promise<Modules> {
  if (!_models) {
    _models = (async () => {
      // Dynamic string-literal imports via the `~/*` alias (spec FR-1). Kept
      // dynamic so bun:sqlite (pulled transitively via ~/db) stays out of the
      // build-time Node module graph; vite resolves the alias at build time.
      const [db, board, task, taskEvent, taskRun, comment, taskAttachment, context, diagnostic, workflowTemplate, notifySub, dependency, profiles, observability] =
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
          import("~/models/dependency"),
          import("~/profiles"),
          import("~/observability"),
        ]);
      // Eagerly initialize the DB singleton as soon as the server-side model
      // modules are loaded. Bridge functions also call initDb(), but this guards
      // against any model code path that may run before an explicit initDb() in
      // a server process (e.g., during Vite SSR preloading).
      db.initDb();
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
        ...dependency,
        ...profiles,
        ...observability,
      } as Modules;
    })();
  }
  return _models;
}

// ---------------------------------------------------------------------------
// Feature-flag gate
// ---------------------------------------------------------------------------

// Spec FR: gate the whole bridge behind FF_SVELTEKIT_FRONTEND. Using the
// shared flag registry so the UI honors the same env/registry overrides as
// every other KDI feature.
import { isEnabled, FF_SVELTEKIT_FRONTEND, FF_LIST_FILTERS_SORT, FF_TENANT_NAMESPACE, FF_CREATED_BY, FF_WORKFLOW_TEMPLATES, FF_RATE_LIMIT_EXIT_CODE, FF_HEARTBEAT, FF_BOARD_METADATA, FF_BOARD_CREATE_SWITCH, FF_DEFAULT_WORKDIR, FF_BOARD_SWITCH, FF_BOARD_RENAME_HERMES, FF_BOARD_RENAME, FF_BOARD_RM_DELETE } from "~/flags";
import {
  FF_SCHEDULED_STATUS,
  FF_PRIORITY_INTEGER,
  FF_SKILLS_ARRAY,
  FF_MODEL_OVERRIDE,
  FF_MAX_RUNTIME,
  FF_MAX_RETRIES,
  FF_GOAL_MODE,
  FF_CREATE_PARENT,
  FF_WORKER_LOG_CAPTURE,
  FF_COMMENT_ENHANCEMENTS,
  FF_CONTEXT_BUILDER,
  FF_SHOW_RUN_FILTERING,
  FF_RESULT_SUMMARY,
  FF_WORKTREE_HANDOFF,
  FF_TASK_ATTACHMENTS,
} from "~/flags";
import { loadProfiles } from "~/profiles";

// Routes call gate() first; when the flag is off it returns the spec-defined
// 503 { enabled:false } so feature-detect works without a redirect.
export function gate(): Response | null {
  if (!isEnabled(FF_SVELTEKIT_FRONTEND)) {
    return new Response(JSON.stringify({ enabled: false }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task create/edit UI feature flags
// ---------------------------------------------------------------------------

export interface TaskFlags {
  sveltekitFrontend: boolean;
  scheduledStatus: boolean;
  priorityInteger: boolean;
  tenantNamespace: boolean;
  createdBy: boolean;
  skillsArray: boolean;
  modelOverride: boolean;
  maxRuntime: boolean;
  maxRetries: boolean;
  defaultWorkdir: boolean;
  listFiltersSort: boolean;
  workflowTemplates: boolean;
  goalMode: boolean;
  createParent: boolean;
}

export function taskFlags(): TaskFlags {
  return {
    sveltekitFrontend: isEnabled(FF_SVELTEKIT_FRONTEND),
    scheduledStatus: isEnabled(FF_SCHEDULED_STATUS),
    priorityInteger: isEnabled(FF_PRIORITY_INTEGER),
    tenantNamespace: isEnabled(FF_TENANT_NAMESPACE),
    createdBy: isEnabled(FF_CREATED_BY),
    skillsArray: isEnabled(FF_SKILLS_ARRAY),
    modelOverride: isEnabled(FF_MODEL_OVERRIDE),
    maxRuntime: isEnabled(FF_MAX_RUNTIME),
    maxRetries: isEnabled(FF_MAX_RETRIES),
    defaultWorkdir: isEnabled(FF_DEFAULT_WORKDIR),
    listFiltersSort: isEnabled(FF_LIST_FILTERS_SORT),
    workflowTemplates: isEnabled(FF_WORKFLOW_TEMPLATES),
    goalMode: isEnabled(FF_GOAL_MODE),
    createParent: isEnabled(FF_CREATE_PARENT),
  };
}

export function isSvelteKitEnabled(): boolean {
  return isEnabled(FF_SVELTEKIT_FRONTEND);
}

export function detailFlags(): DetailFlags {
  return {
    sveltekitFrontend: isEnabled(FF_SVELTEKIT_FRONTEND),
    contextBuilder: isEnabled(FF_CONTEXT_BUILDER),
    taskAttachments: isEnabled(FF_TASK_ATTACHMENTS),
    showRunFiltering: isEnabled(FF_SHOW_RUN_FILTERING),
    workerLogCapture: isEnabled(FF_WORKER_LOG_CAPTURE),
    commentEnhancements: isEnabled(FF_COMMENT_ENHANCEMENTS),
    goalMode: isEnabled(FF_GOAL_MODE),
    workflowTemplates: isEnabled(FF_WORKFLOW_TEMPLATES),
    heartbeat: isEnabled(FF_HEARTBEAT),
    maxRuntime: isEnabled(FF_MAX_RUNTIME),
    maxRetries: isEnabled(FF_MAX_RETRIES),
    rateLimitExitCode: isEnabled(FF_RATE_LIMIT_EXIT_CODE),
    scheduledStatus: isEnabled(FF_SCHEDULED_STATUS),
    skillsArray: isEnabled(FF_SKILLS_ARRAY),
    modelOverride: isEnabled(FF_MODEL_OVERRIDE),
    createdBy: isEnabled(FF_CREATED_BY),
    tenantNamespace: isEnabled(FF_TENANT_NAMESPACE),
    resultSummary: isEnabled(FF_RESULT_SUMMARY),
    worktreeHandoff: isEnabled(FF_WORKTREE_HANDOFF),
    priorityInteger: isEnabled(FF_PRIORITY_INTEGER),
  };
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
  if (/cannot be empty|must be 255|requires scheduled_at|A board id is required|Title is required/.test(message))
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

export async function showBoardJson(slug: string, includeArchived = false): Promise<{ board: CamelCase<BoardWithTaskCounts> }> {
  const m = await models();
  m.initDb();
  const board = m.showBoard(slug, includeArchived);
  if (!board) throw new BridgeError("board_not_found", 404, `Board "${slug}" not found.`);
  return { board: toCamel(board) };
}

export async function boardStatsJson(slug: string): Promise<{ stats: CamelCase<BoardStats> }> {
  await resolveBoard(slug);
  const m = await models();
  return { stats: toCamel(m.getBoardStats(slug)) };
}

// ---------------------------------------------------------------------------
export function bridgeError(err: unknown): BridgeError {
  return err instanceof BridgeError ? err : new BridgeError("internal", 500, String(err));
}

// Board-management UI helpers (KDI-UI-002)
// ---------------------------------------------------------------------------

function boardListRowFromBoard(b: Board, m: Awaited<ReturnType<typeof models>>): BoardListRow {
  // Archived boards have no live stats; avoid querying getBoardStats because it
  // resolves only active boards. The archived row still shows zero counts.
  const stats = b.archived_at !== null ? { status_counts: {} } : m.getBoardStats(b.slug);
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    icon: b.icon,
    color: b.color,
    description: b.description,
    workdir: b.workdir,
    defaultWorkdir: b.default_workdir,
    baseRef: b.base_ref,
    archived: b.archived_at !== null,
    createdAt: b.created_at,
    statusCounts: stats.status_counts,
  };
}

export async function listBoardsUiJson(params: URLSearchParams): Promise<{ boards: BoardListRow[] }> {
  const m = await models();
  m.initDb();
  const includeArchived = params.get("includeArchived") === "true";
  const boards = m.listBoards(includeArchived).map((b) => boardListRowFromBoard(b, m));
  return { boards };
}

export async function readCurrentBoardJson(): Promise<string | null> {
  const { readCurrentBoard } = await import("~/resolveBoard");
  return readCurrentBoard();
}

export interface UpdateMetadataInput {
  slug: string;
  name?: string;
  icon?: string;
  color?: string;
  description?: string;
}

export async function updateBoardMetadataJson(input: UpdateMetadataInput): Promise<{ board: BoardListRow }> {
  const m = await models();
  m.initDb();
  const metadata: BoardMetadata = {};
  if (input.name !== undefined) metadata.name = input.name;
  if (input.icon !== undefined) metadata.icon = input.icon;
  if (input.color !== undefined) metadata.color = input.color;
  if (input.description !== undefined) metadata.description = input.description;
  try {
    m.updateBoardMetadata(input.slug, metadata);
  } catch (err) {
    throw wrap(err);
  }
  const full = m.showBoard(input.slug, false)!;
  return { board: boardListRowFromBoard(full, m) };
}

export interface SetDefaultWorkdirInput {
  slug: string;
  workdir: string | null;
}

export async function setDefaultWorkdirJson(input: SetDefaultWorkdirInput): Promise<{ board: BoardListRow }> {
  const m = await models();
  m.initDb();
  try {
    m.setDefaultWorkdir(input.slug, input.workdir);
  } catch (err) {
    throw wrap(err);
  }
  const full = m.showBoard(input.slug, false)!;
  return { board: boardListRowFromBoard(full, m) };
}

export async function switchBoardJson(slug: string): Promise<{ currentSlug: string }> {
  const m = await models();
  m.initDb();
  const board = m.showBoard(slug, true);
  if (!board) throw new BridgeError("board_not_found", 404, `Board "${slug}" not found.`);
  const { writeCurrentBoard } = await import("~/resolveBoard");
  writeCurrentBoard(slug);
  return { currentSlug: slug };
}

export interface RenameBoardInput {
  slug: string;
  name: string;
}

export async function renameBoardJson(input: RenameBoardInput): Promise<{ board: BoardListRow }> {
  const m = await models();
  m.initDb();
  try {
    m.updateBoardMetadata(input.slug, { name: input.name });
  } catch (err) {
    throw wrap(err);
  }
  const full = m.showBoard(input.slug, false)!;
  return { board: boardListRowFromBoard(full, m) };
}

export interface RenameSlugInput {
  oldSlug: string;
  newSlug: string;
}

export async function renameBoardSlugJson(input: RenameSlugInput): Promise<{ board: BoardListRow; currentRewritten: boolean }> {
  const m = await models();
  m.initDb();
  try {
    m.renameBoardSlug(input.oldSlug, input.newSlug);
  } catch (err) {
    throw wrap(err);
  }
  const { readCurrentBoard, writeCurrentBoard } = await import("~/resolveBoard");
  const currentRewritten = readCurrentBoard() === input.oldSlug;
  if (currentRewritten) writeCurrentBoard(input.newSlug);
  const full = m.showBoard(input.newSlug, false)!;
  return { board: boardListRowFromBoard(full, m), currentRewritten };
}

export async function archiveBoardJson(slug: string): Promise<{ board: BoardListRow }> {
  const m = await models();
  m.initDb();
  try {
    m.archiveBoard(slug);
  } catch (err) {
    throw wrap(err);
  }
  const full = m.showBoard(slug, true)!;
  return { board: boardListRowFromBoard(full, m) };
}

export async function removeBoardJson(slug: string): Promise<{ removed: true }> {
  const m = await models();
  m.initDb();
  const board = m.showBoard(slug, true);
  if (!board) throw new BridgeError("board_not_found", 404, `Board "${slug}" not found.`);
  try {
    m.removeBoard(slug, true);
  } catch (err) {
    throw wrap(err);
  }
  return { removed: true };
}

export function boardUiFlags(): BoardFlags {
  return {
    boardMetadata: isEnabled(FF_BOARD_METADATA),
    boardCreateSwitch: isEnabled(FF_BOARD_CREATE_SWITCH),
    defaultWorkdir: isEnabled(FF_DEFAULT_WORKDIR),
    boardSwitch: isEnabled(FF_BOARD_SWITCH),
    boardRenameHermes: isEnabled(FF_BOARD_RENAME_HERMES),
    boardRename: isEnabled(FF_BOARD_RENAME),
    boardRmDelete: isEnabled(FF_BOARD_RM_DELETE),
  };
}

export async function assigneesJson(slug: string): Promise<{ assignees: Record<string, number> }> {
  const board = await resolveBoard(slug);
  const m = await models();
  return { assignees: m.getAssigneeCounts(board.id) };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface KanbanTask {
  id: number;
  title: string;
  status: string;
  assignee: string | null;
  priority: number;
  tenant: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  scheduledAt: number | null;
  lastHeartbeatAt: number | null;
  blockReason: string | null;
  scheduleReason: string | null;
  reviewReason: string | null;
  rateLimitedUntil: number | null;
  workflowTemplateId: string | null;
  currentStepKey: string | null;
  sessionId: string | null;
  archivedAt: number | null;
}

function toKanbanTask(t: TaskModel): KanbanTask {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    tenant: t.tenant,
    createdBy: t.created_by,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    scheduledAt: t.scheduled_at,
    lastHeartbeatAt: t.last_heartbeat_at,
    blockReason: t.block_reason,
    scheduleReason: t.schedule_reason,
    reviewReason: t.review_reason,
    rateLimitedUntil: t.rate_limited_until,
    workflowTemplateId: t.workflow_template_id,
    currentStepKey: t.current_step_key,
    sessionId: t.session_id,
    archivedAt: t.archived_at,
  };
}

export function resolveCurrentProfile(): string {
  return (Bun.env.KDI_PROFILE || Bun.env.HERMES_PROFILE || "user").trim() || "user";
}

export async function listProfilesJson(): Promise<{ profiles: string[] }> {
  // loadProfiles reads from ~/.config/kdi/profiles.yaml and merges builtins.
  // ponytail: reuse the CLI helper rather than re-implementing profile discovery.
  const profiles = loadProfiles();
  return { profiles: profiles.map((p) => p.name) };
}
function requireListFiltersSort(): void {
  if (!isEnabled(FF_LIST_FILTERS_SORT)) {
    throw new BridgeError("feature_disabled", 400, "List filters and sort feature is not enabled.");
  }
}

function requireTenantNamespace(): void {
  if (!isEnabled(FF_TENANT_NAMESPACE)) {
    throw new BridgeError("feature_disabled", 400, "Tenant namespace feature is not enabled.");
  }
}

function requireCreatedBy(): void {
  if (!isEnabled(FF_CREATED_BY)) {
    throw new BridgeError("feature_disabled", 400, "Created-by tracking is not enabled.");
  }
}

function requireWorkflowTemplates(): void {
  if (!isEnabled(FF_WORKFLOW_TEMPLATES)) {
    throw new BridgeError("feature_disabled", 400, "Workflow templates feature is not enabled.");
  }
}

export async function listTasksJson(
  slug: string,
  params: URLSearchParams,
): Promise<{ tasks: KanbanTask[] }> {
  const board = await resolveBoard(slug);
  const m = await models();

  const status = params.get("status") as Task["status"] | null;
  const archived = params.get("archived") === "true";
  const mine = params.get("mine") === "true";
  const assignee = params.get("assignee");
  const tenant = params.get("tenant");
  const createdBy = params.get("createdBy");
  const sessionId = params.get("session");
  const workflowTemplateId = params.get("workflowTemplateId");
  const stepKey = params.get("stepKey");
  const sort = params.get("sort") ?? undefined;

  if (sort !== undefined || archived || mine || sessionId || workflowTemplateId || stepKey) {
    requireListFiltersSort();
  }
  if (tenant !== null) {
    if (tenant.trim() === "") {
      throw new BridgeError("invalid_input", 400, "Tenant cannot be empty.");
    }
    requireTenantNamespace();
  }
  if (createdBy !== null) requireCreatedBy();
  if (workflowTemplateId !== null || stepKey !== null) requireWorkflowTemplates();
  if (status === "archived" && !archived) {
    throw new BridgeError("invalid_input", 400, "Use archived=true to filter archived tasks.");
  }
  if (sort !== undefined) {
    const VALID_SORT_KEYS = ["assignee", "created", "created-desc", "priority", "priority-desc", "status", "title", "updated"];
    if (!VALID_SORT_KEYS.includes(sort)) {
      throw new BridgeError("invalid_input", 400, `Invalid sort key "${sort}". Valid: ${VALID_SORT_KEYS.join(", ")}.`);
    }
  }
  if (mine && assignee) {
    throw new BridgeError("invalid_input", 400, "Mine and assignee cannot be used together.");
  }

  const effectiveAssignee = mine ? resolveCurrentProfile() : (assignee ?? undefined);

  const tasks = m.listTasks(
    {
      board_id: board.id,
      status: status ?? undefined,
      assignee: effectiveAssignee,
      tenant: tenant ?? undefined,
      created_by: createdBy ?? undefined,
      includeArchived: archived,
      session_id: sessionId ?? undefined,
      workflow_template_id: workflowTemplateId ?? undefined,
      current_step_key: stepKey ?? undefined,
    },
    sort,
  );
  return { tasks: tasks.map(toKanbanTask) };
}

// The bridge create-task body is camelCase for the UI. It is mapped to the
// model's mixed-case CreateTaskInput so the same model function can be reused.
// ponytail: one explicit mapping table; no silent field loss for snake_case keys.
export interface CreateTaskBody {
  title: string;
  body?: string;
  assignee?: string;
  priority?: number;
  triage?: boolean;
  initialStatus?: CreateTaskInput["initialStatus"];
  idempotencyKey?: string;
  scheduledAt?: number;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  tenant?: string;
  skills?: string[];
  createdBy?: string;
  modelOverride?: string;
  workspace?: string;
  workspaceKind?: CreateTaskInput["workspace_kind"];
  branch?: string;
  sessionId?: string;
  workflowTemplateId?: string;
  stepKey?: string;
  swarmParentId?: number;
  goalMode?: boolean;
  goalMaxTurns?: number;
  goalJudgeProfile?: string;
}

function mapCreateTaskBody(body: CreateTaskBody): Omit<CreateTaskInput, "board_id"> {
  return {
    title: body.title,
    body: body.body,
    assignee: body.assignee,
    priority: body.priority,
    triage: body.triage,
    initialStatus: body.initialStatus,
    idempotency_key: body.idempotencyKey,
    scheduled_at: body.scheduledAt,
    max_runtime_seconds: body.maxRuntimeSeconds,
    max_retries: body.maxRetries,
    tenant: body.tenant,
    skills: body.skills,
    created_by: body.createdBy,
    model_override: body.modelOverride,
    workspace: body.workspace,
    workspace_kind: body.workspaceKind,
    branch: body.branch,
    session_id: body.sessionId,
    workflow_template_id: body.workflowTemplateId,
    current_step_key: body.stepKey,
    swarm_parent_id: body.swarmParentId,
    goal_mode: body.goalMode,
    goal_max_turns: body.goalMaxTurns,
    goal_judge_profile: body.goalJudgeProfile,
  };
}

export async function createTaskJson(slug: string, body: CreateTaskBody, parentIds?: number[]): Promise<{ task: KanbanTask }> {
  // Trust-boundary guards run before the model call: required title, and reject
  // `archived` (not a legal initial status). ponytail: never simplify away
  // input validation at trust boundaries.
  if (typeof body.title !== "string" || body.title.trim() === "")
    throw new BridgeError("invalid_input", 400, "Title is required.");
  if ((body.initialStatus as string) === "archived")
    throw new BridgeError("invalid_input", 400, "initialStatus 'archived' is not allowed.");
  const board = await resolveBoard(slug);
  const m = await models();
  try {
    const task = m.createTask({ ...mapCreateTaskBody(body), board_id: board.id });
    if (parentIds && parentIds.length > 0) {
      for (const parentId of parentIds) {
        try {
          m.addDependency(parentId, task.id);
        } catch (err: any) {
          // Idempotent: ignore duplicate parent→child links.
          if (!/UNIQUE constraint failed: dependencies\.parent_id, dependencies\.child_id/.test(err?.message ?? "")) {
            throw err;
          }
        }
      }
    }
    return { task: toKanbanTask(task) };
  } catch (err) {
    throw wrap(err);
  }
}

export async function editTaskJson(slug: string, id: number, body: string): Promise<{ task: KanbanTask }> {
  if (typeof body !== "string" || body.trim() === "")
    throw new BridgeError("invalid_input", 400, "Body is required.");
  await assertTaskOnBoard(slug, id);
  const m = await models();
  try {
    const task = m.editTask(id, body);
    return { task: toKanbanTask(task) };
  } catch (err) {
    throw wrap(err);
  }
}

export async function getWorkflowTemplateJson(
  slug: string,
  templateId: string,
): Promise<{ template: CamelCase<WorkflowTemplate> | null }> {
  const board = await resolveBoard(slug);
  const m = await models();
  const template = m.getWorkflowTemplate(board.id, templateId);
  return { template: template ? (toCamel(template) as CamelCase<WorkflowTemplate>) : null };
}

export async function validateStepKeyBridge(
  slug: string,
  templateId: string,
  key: string,
): Promise<void> {
  const board = await resolveBoard(slug);
  const m = await models();
  const template = m.getWorkflowTemplate(board.id, templateId);
  if (!template) {
    throw new BridgeError(
      "invalid_input",
      400,
      `Workflow template "${templateId}" not found for board "${slug}".`,
    );
  }
  try {
    m.validateStepKey(template, key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BridgeError("invalid_input", 400, message);
  }
}

export async function profilesJson(): Promise<{ profiles: Profile[] }> {
  const m = await models();
  return { profiles: m.loadProfiles() };
}

// Re-export the model's parseDuration so the UI action can surface the same
// errors without importing the model directly.
export async function parseDurationBridge(value: string): Promise<number> {
  const m = await models();
  try {
    return m.parseDuration(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BridgeError("invalid_input", 400, message);
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

// ---------------------------------------------------------------------------
// Task detail panel (KDI-UI-005)
// ---------------------------------------------------------------------------

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

function loadParentSummaries(m: Awaited<ReturnType<typeof models>>, childId: number): TaskSummary[] {
  const rows = m.getDb().query(
    `SELECT t.id, t.title, t.status, t.assignee, t.priority, t.tenant, t.updated_at, t.archived_at
     FROM tasks t
     JOIN dependencies d ON d.parent_id = t.id
     WHERE d.child_id = ? AND t.archived_at IS NULL
     ORDER BY t.updated_at DESC
     LIMIT 10`
  ).all(childId) as Array<{
    id: number;
    title: string;
    status: string;
    assignee: string | null;
    priority: number;
    tenant: string | null;
    updated_at: number;
    archived_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    assignee: r.assignee,
    priority: r.priority,
    tenant: r.tenant,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  }));
}

function loadChildrenSummaries(m: Awaited<ReturnType<typeof models>>, parentId: number): TaskSummary[] {
  return m.getChildTasks(parentId).map(toTaskSummary);
}

function findHandoffEvent(
  m: Awaited<ReturnType<typeof models>>,
  taskId: number,
): { branch: string; worktreePath: string; eventAt: number } | null {
  const row = m.getDb().query(
    `SELECT payload, created_at FROM task_events
     WHERE task_id = ? AND kind = 'worktree_handed_off'
     ORDER BY created_at DESC LIMIT 1`
  ).get(taskId) as { payload: string | null; created_at: number } | undefined;
  if (!row) return null;
  try {
    const payload = row.payload ? JSON.parse(row.payload) : {};
    if (typeof payload.branch === "string" && typeof payload.worktree_path === "string") {
      return { branch: payload.branch, worktreePath: payload.worktree_path, eventAt: row.created_at };
    }
  } catch {
    // ignore malformed payload
  }
  return null;
}

export async function taskDetailJson(slug: string, id: number): Promise<TaskDetail> {
  await assertTaskOnBoard(slug, id);
  const m = await models();

  const contextEnabled = isEnabled(FF_CONTEXT_BUILDER);
  const attachmentsEnabled = isEnabled(FF_TASK_ATTACHMENTS);
  const commentEnhancements = isEnabled(FF_COMMENT_ENHANCEMENTS);

  const [task, parents, children, attachments, comments, events, runs, contextResult] = await Promise.all([
    Promise.resolve(m.showTask(id) as TaskModel),
    Promise.resolve(loadParentSummaries(m, id)),
    Promise.resolve(loadChildrenSummaries(m, id)),
    attachmentsEnabled ? Promise.resolve(m.listAttachments(id)) : Promise.resolve([] as TaskAttachment[]),
    Promise.resolve(m.getComments(id)),
    Promise.resolve(m.getRecentTaskEvents(id, 50)),
    Promise.resolve(m.getRuns(id)),
    contextEnabled
      ? (async () => {
          try {
            return { ok: true as const, value: m.buildTaskContext(id, slug) };
          } catch {
            return { ok: false as const };
          }
        })()
      : Promise.resolve({ ok: false as const }),
  ]);

  if (!task) {
    throw new BridgeError("task_not_found", 404, `Task ${id} not found on board "${slug}".`);
  }

  const normalizedComments = commentEnhancements
    ? comments
    : comments.map((c) => ({ ...c, author: "user" }));

  const handoff = findHandoffEvent(m, id);
  const logPath = m.getTaskLogPath(slug, id);

  return {
    task: toCamel(task) as TaskDetail["task"],
    parents,
    children,
    handoff: handoff ? { branch: handoff.branch, worktreePath: handoff.worktreePath, eventAt: handoff.eventAt } : null,
    log: { present: existsSync(logPath), path: logPath },
    runs: toCamel(runs) as TaskDetail["runs"],
    events: toCamel(events) as TaskDetail["events"],
    comments: toCamel(normalizedComments) as TaskDetail["comments"],
    attachments: toCamel(attachments) as TaskDetail["attachments"],
    context: contextResult.ok ? (toCamel(contextResult.value) as TaskDetail["context"]) : null,
    contextError: contextResult.ok ? undefined : "not_available",
  };
}

export async function taskLogJson(
  slug: string,
  id: number,
  params: URLSearchParams,
): Promise<{ present: boolean; content?: string; path?: string; truncated?: boolean; size?: number; disabled?: boolean }> {
  await assertTaskOnBoard(slug, id);
  if (!isEnabled(FF_WORKER_LOG_CAPTURE)) {
    return { present: false, disabled: true };
  }
  const m = await models();
  const path = m.getTaskLogPath(slug, id);
  if (!existsSync(path)) {
    return { present: false };
  }
  const stats = statSync(path);
  const tail = params.get("tail");
  if (tail !== null) {
    const tailBytes = Number(tail);
    const content = readFileSync(path, "utf-8");
    const slice = tailBytes > 0 ? content.slice(-tailBytes) : content;
    return { present: true, content: slice, path };
  }
  const MAX_FULL = 500 * 1024;
  const content = readFileSync(path, "utf-8");
  if (stats.size > 10 * 1024 * 1024) {
    return { present: true, content: content.slice(0, MAX_FULL), path, truncated: true, size: stats.size };
  }
  return { present: true, content, path };
}

export async function taskDependenciesJson(
  slug: string,
  id: number,
): Promise<{ parents: TaskSummary[]; children: TaskSummary[] }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  return { parents: loadParentSummaries(m, id), children: loadChildrenSummaries(m, id) };
}

export async function taskHandoffJson(
  slug: string,
  id: number,
): Promise<{ present: boolean; branch?: string; worktreePath?: string; eventAt?: number }> {
  await assertTaskOnBoard(slug, id);
  const m = await models();
  const handoff = findHandoffEvent(m, id);
  return handoff ? { present: true, ...handoff } : { present: false };
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