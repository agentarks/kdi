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
import { existsSync, readFileSync, statSync, openSync, closeSync, readSync } from "node:fs";
import type { Board, BoardMetadata, BoardWithTaskCounts, BoardStats } from "~/models/board";
import type { BoardListRow, BoardFlags, TaskSummary, TaskDetail, DetailFlags, DispatchStatus, DispatchOnceResult, DispatchFlags, ProfileHealth, SpawnFailure, TaskCounts, ActivityFlags, LifecycleAction, LifecycleFields, LifecycleResult, BulkLifecycleResult, LifecycleFlags, StatsFlags } from "$lib/types";

import type { Task, Task as TaskModel, CreateTaskInput } from "~/models/task";
import type { TaskEvent, WatchFilters } from "~/models/taskEvent";
import type { TaskRun } from "~/models/taskRun";
import type { Comment } from "~/models/comment";
import type { TaskAttachment } from "~/models/taskAttachment";
import type { TaskContext } from "~/models/context";
import type { WorkflowTemplate } from "~/models/workflowTemplate";
import type { NotifySub } from "~/models/notifySub";
import type { DiagnosticFinding, DiagnosticSeverity } from "~/models/diagnostic";
// Runtime profile imports stay server-side and do not pull `bun:sqlite`.
import { loadProfiles, doctorProfiles, bootstrapRealProfiles, defaultProfilesPath, type Profile } from "~/profiles";

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
  getRecentBoardRunFailures: typeof import("~/models/taskRun")["getRecentBoardRunFailures"];
  getComments: typeof import("~/models/comment")["getComments"];
  addComment: typeof import("~/models/comment")["addComment"];
  listAttachments: typeof import("~/models/taskAttachment")["listAttachments"];
  buildTaskContext: typeof import("~/models/context")["buildTaskContext"];
  runDiagnostics: typeof import("~/models/diagnostic")["runDiagnostics"];
  listWorkflowTemplates: typeof import("~/models/workflowTemplate")["listWorkflowTemplates"];
  getWorkflowTemplate: typeof import("~/models/workflowTemplate")["getWorkflowTemplate"];
  validateStepKey: typeof import("~/models/workflowTemplate")["validateStepKey"];
  advanceTaskStep: typeof import("~/models/workflowTemplate")["advanceTaskStep"];
  setTaskStep: typeof import("~/models/workflowTemplate")["setTaskStep"];
  listSubscriptions: typeof import("~/models/notifySub")["listSubscriptions"];
  subscribe: typeof import("~/models/notifySub")["subscribe"];
  unsubscribe: typeof import("~/models/notifySub")["unsubscribe"];
  addDependency: typeof import("~/models/dependency")["addDependency"];
  getChildTasks: typeof import("~/models/dependency")["getChildTasks"];
  loadProfiles: typeof import("~/profiles")["loadProfiles"];
  getProfile: typeof import("~/profiles")["getProfile"];
  editTask: typeof import("~/models/task")["editTask"];
  parseDuration: typeof import("~/models/task")["parseDuration"];
  promoteTaskAdvanced: typeof import("~/models/task")["promoteTaskAdvanced"];
  blockTask: typeof import("~/models/task")["blockTask"];
  unblockTask: typeof import("~/models/task")["unblockTask"];
  scheduleTask: typeof import("~/models/task")["scheduleTask"];
  reviewTask: typeof import("~/models/task")["reviewTask"];
  archiveTask: typeof import("~/models/task")["archiveTask"];
  completeTask: typeof import("~/models/task")["completeTask"];
  assignTask: typeof import("~/models/task")["assignTask"];
  unassignTask: typeof import("~/models/task")["unassignTask"];
  reassignTask: typeof import("~/models/task")["reassignTask"];
  atomicClaim: typeof import("~/models/claim")["atomicClaim"];
  reclaimTask: typeof import("~/models/claim")["reclaimTask"];
  heartbeat: typeof import("~/models/claim")["heartbeat"];
  getTaskLogPath: typeof import("~/observability")["getTaskLogPath"];
};
let _models: Promise<Modules> | null = null;

// Reset the cached model module promise. Exported for tests that need to
// re-populate the cache after swapping a model implementation (e.g., spies).
export function resetModels(): void {
  _models = null;
}

async function models(): Promise<Modules> {
  if (!_models) {
    _models = (async () => {
      // Dynamic string-literal imports via the `~/*` alias (spec FR-1). Kept
      // dynamic so bun:sqlite (pulled transitively via ~/db) stays out of the
      // build-time Node module graph; vite resolves the alias at build time.
      const [db, board, task, taskEvent, taskRun, comment, taskAttachment, context, diagnostic, workflowTemplate, notifySub, dependency, profiles, observability, claim] =
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
          import("~/models/claim"),
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
        ...claim,
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
import { isEnabled, FF_SVELTEKIT_FRONTEND, FF_LIST_FILTERS_SORT, FF_TENANT_NAMESPACE, FF_CREATED_BY, FF_WORKFLOW_TEMPLATES, FF_RATE_LIMIT_EXIT_CODE, FF_HEARTBEAT, FF_BOARD_METADATA, FF_BOARD_CREATE_SWITCH, FF_DEFAULT_WORKDIR, FF_BOARD_SWITCH, FF_BOARD_RENAME_HERMES, FF_BOARD_RENAME, FF_BOARD_RM_DELETE, FF_ENABLE_KANBAN_DISPATCH, FF_DISPATCH_ONCE, FF_DISPATCH_CONTROLS, FF_REAL_HARNESS_PROFILES, FF_WATCH_FILTERS, FF_TAIL_NO_FOLLOW, FF_NOTIFY_SUBS, FF_STATS, FF_DIAGNOSTICS } from "~/flags";
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
  FF_BULK_OPERATIONS,
  FF_REVIEW_STATUS,
  FF_COMPLETE_METADATA,
  FF_ASSIGN_REASSIGN,
} from "~/flags";

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
  if (/^Task \d+ not found on board/.test(message)) return new BridgeError("task_not_found", 404, message);
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

export function activityFlags(): ActivityFlags {
  return {
    watchFilters: isEnabled(FF_WATCH_FILTERS),
    tailNoFollow: isEnabled(FF_TAIL_NO_FOLLOW),
    workerLogCapture: isEnabled(FF_WORKER_LOG_CAPTURE),
    tenantNamespace: isEnabled(FF_TENANT_NAMESPACE),
  };
}

// --- KDI-UI-009: Stats & Diagnostics UI sub-flag gate (Slice 1: FF_STATS) ---
// The bridge itself does NOT gate boardStatsJson on FF_STATS (Slice 2's
// diagnosticsJson mirrors that); each page loader gates its own sub-flag so an
// off flag yields a disabled payload instead of an error (FR-2 / AC-11).
export function statsFlags(): StatsFlags {
  return {
    stats: isEnabled(FF_STATS),
  };
}

// KDI-UI-009 Slice 2: diagnostics page sub-flag gate. The bridge's
// diagnosticsJson() does NOT enforce FF_DIAGNOSTICS (Gap 1) — the /diagnostics
// loader gates on this before calling the bridge.
export interface DiagnosticsFlags {
  sveltekitFrontend: boolean;
  diagnostics: boolean;
}

export function diagnosticsFlags(): DiagnosticsFlags {
  return {
    sveltekitFrontend: isEnabled(FF_SVELTEKIT_FRONTEND),
    diagnostics: isEnabled(FF_DIAGNOSTICS),
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
  claimLock: string | null;
  claimExpires: number | null;
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
    claimLock: t.claim_lock,
    claimExpires: t.claim_expires,
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

// KDI-UI-013 Slice 3: workflow step actions (advance / jump). Thin JSON
// wrappers over the same model fns the CLI `kdi step` command calls, returning
// the updated camelCase task + a CLI-mirroring success message (FR-23).
// Validation/precondition errors map to "invalid_input" 400 with the exact CLI
// string (FR-19..FR-21); a missing task → "task_not_found" 404. Reuses the
// KDI-UI-006 reason byte cap (BRD §11) so the recorded `stepped` event reason
// never exceeds a true 4 KiB UTF-8 budget.
function stepReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  const s = typeof reason === "string" ? reason : String(reason);
  const trimmed = s.trim();
  return trimmed === "" ? undefined : clampUtf8Bytes(trimmed, MAX_HEARTBEAT_NOTE_BYTES);
}

function stepMessage(action: "advance" | "jump", task: KanbanTask): string {
  if (action === "advance" && task.status === "done") {
    return `Completed task ${task.id} at terminal workflow step.`;
  }
  if (action === "jump") {
    return `Set task ${task.id} to step ${task.currentStepKey}.`;
  }
  return `Advanced task ${task.id} to step ${task.currentStepKey}.`;
}

// Wrap a model-layer step error as a client BridgeError, surfacing the exact
// CLI message. A not-found/archived task is 404; everything else the model
// throws for steps is a validation/precondition error → 400.
function wrapStepError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/not found or already archived/.test(message))
    return new BridgeError("task_not_found", 404, message);
  return new BridgeError("invalid_input", 400, message);
}

// FR-25 server-side mirror: the UI disables the step cluster for a done task,
// but a direct POST must not reach the model. A done task has a null
// `current_step_key`; `advanceTaskStep` would set it to `steps[0]` WITHOUT
// clearing `status='done'` ("done with a step" data corruption), and `setTaskStep`
// would likewise re-add a step to a terminal task. Guard here so the bridge
// returns a clean 400 and never mutates a terminal task. Archived tasks are
// already rejected upstream by `assertTaskOnBoard` (showTask filters
// `archived_at IS NULL` → 404), so only the done case needs this guard.
// AC-14-clean: only the bridge moves, no `src/models` churn.
function rejectTerminalStepTask(task: TaskModel): void {
  if (task.status === "done")
    throw new BridgeError("invalid_input", 400, `Task ${task.id} is already done; step actions are not available.`);
}

export async function advanceTaskStepJson(
  slug: string,
  id: number,
  reason?: string,
): Promise<{ task: KanbanTask; message: string }> {
  requireWorkflowTemplates();
  rejectTerminalStepTask(await assertTaskOnBoard(slug, id));
  const m = await models();
  let task: TaskModel;
  try {
    task = m.advanceTaskStep(id, stepReason(reason));
  } catch (err) {
    throw wrapStepError(err);
  }
  const kanban = toKanbanTask(task);
  return { task: kanban, message: stepMessage("advance", kanban) };
}

export async function setTaskStepJson(
  slug: string,
  id: number,
  targetKey: string,
  reason?: string,
): Promise<{ task: KanbanTask; message: string }> {
  requireWorkflowTemplates();
  if (typeof targetKey !== "string" || targetKey.trim() === "")
    throw new BridgeError("invalid_input", 400, "Step key cannot be empty.");
  rejectTerminalStepTask(await assertTaskOnBoard(slug, id));
  const m = await models();
  let task: TaskModel;
  try {
    task = m.setTaskStep(id, targetKey.trim(), stepReason(reason));
  } catch (err) {
    throw wrapStepError(err);
  }
  const kanban = toKanbanTask(task);
  return { task: kanban, message: stepMessage("jump", kanban) };
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

export async function addCommentJson(
  slug: string,
  id: number,
  input: { text: string; author?: string },
): Promise<{ comment: CamelCase<Comment> }> {
  if (typeof input?.text !== "string" || input.text.trim() === "")
    throw new BridgeError("invalid_input", 400, "Comment text is required.");
  if (input.author !== undefined && typeof input.author !== "string")
    throw new BridgeError("invalid_input", 400, "Author must be a string.");
  await assertTaskOnBoard(slug, id);
  const m = await models();
  try {
    return { comment: toCamel(m.addComment({ task_id: id, text: input.text, author: input.author ?? resolveCurrentProfile() })) };
  } catch (err) {
    throw wrap(err);
  }
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
     ORDER BY created_at DESC, id DESC LIMIT 1`
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
    m.showTask(id) as TaskModel,
    loadParentSummaries(m, id),
    loadChildrenSummaries(m, id),
    attachmentsEnabled ? m.listAttachments(id) : ([] as TaskAttachment[]),
    m.getComments(id),
    m.getRecentTaskEvents(id, 50),
    m.getRuns(id),
    contextEnabled
      ? (async () => {
          try {
            return { ok: true as const, value: m.buildTaskContext(id, slug) };
          } catch {
            return { ok: false as const };
          }
        })()
      : { ok: false as const },
  ]);

  if (!task) {
    throw new BridgeError("task_not_found", 404, `Task ${id} not found on board "${slug}".`);
  }

  const normalizedComments = commentEnhancements
    ? comments
    : comments.map((c) => ({ ...c, author: "user" }));

  const handoff = findHandoffEvent(m, id);
  const logPath = m.getTaskLogPath(slug, id);

  // KDI-UI-013 Slice 3: hydrate the template step list for the Jump-to-step
  // control. null when the task has no template (or the template was deleted);
  // the panel hides the step controls in that case.
  const workflowTemplateSteps = task.workflow_template_id
    ? (m.getWorkflowTemplate(task.board_id, task.workflow_template_id)?.steps ?? null)
    : null;

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
    workflowTemplateSteps,
  };
}

// Read only the last `tailBytes` bytes from a text file, aligning to a valid
// UTF-8 start byte so we never return a partial leading character.
function readTailText(path: string, tailBytes: number, size?: number): string {
  const fileSize = size ?? statSync(path).size;
  if (tailBytes <= 0 || fileSize <= tailBytes) {
    return readFileSync(path, "utf-8");
  }
  const buffer = Buffer.alloc(tailBytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, tailBytes, fileSize - tailBytes);
  } finally {
    closeSync(fd);
  }
  // Skip leading continuation bytes (10xxxxxx) to reach a valid UTF-8 boundary.
  let i = 0;
  while (i < buffer.length && (buffer[i] & 0xc0) === 0x80) {
    i++;
  }
  return new TextDecoder().decode(buffer.subarray(i));
}

function readHeadText(path: string, headBytes: number, size?: number): string {
  const fileSize = size ?? statSync(path).size;
  const bytesToRead = Math.min(headBytes, fileSize);
  if (bytesToRead <= 0) return "";
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    closeSync(fd);
  }
  return new TextDecoder().decode(buffer);
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
    const content = readTailText(path, tailBytes, stats.size);
    return { present: true, content, path };
  }
  const MAX_FULL = 500 * 1024;
  if (stats.size > 10 * 1024 * 1024) {
    const content = readHeadText(path, MAX_FULL, stats.size);
    return { present: true, content, path, truncated: true, size: stats.size };
  }
  return { present: true, content: readFileSync(path, "utf-8"), path };
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

export async function assertTaskOnBoard(slug: string, id: number): Promise<TaskModel> {
  const board = await resolveBoard(slug);
  const m = await models();
  const task = m.showTask(id);
  if (!task || task.board_id !== board.id)
    throw new BridgeError("task_not_found", 404, `Task ${id} not found on board "${slug}".`);
  return task;
}

// ---------------------------------------------------------------------------
// Board-level events / diagnostics / workflows
// ---------------------------------------------------------------------------

export async function boardEventsJson(
  slug: string,
  params: URLSearchParams,
): Promise<{ events: CamelCase<TaskEvent>[]; since: number | null; board: string }> {
  const board = await resolveBoard(slug);
  const m = await models();

  const watchFilters = isEnabled(FF_WATCH_FILTERS);
  const tenantNamespace = isEnabled(FF_TENANT_NAMESPACE);
  const hasAssignee = params.get("assignee") !== null;
  const hasKinds = params.get("kinds") !== null;
  const hasTenant = params.get("tenant") !== null;

  // AC-16: reject filter params the backend cannot honor with 400 feature_disabled,
  // matching the CLI. Silently dropping them would let the UI believe a filter is
  // active while the server returns unfiltered (and here, board-scoped-only) rows.
  if ((hasAssignee || hasKinds) && !watchFilters) {
    throw new BridgeError("feature_disabled", 400, "Watch filters feature is not enabled");
  }
  if (hasTenant && !(watchFilters && tenantNamespace)) {
    throw new BridgeError("feature_disabled", 400, "Tenant namespace feature is not enabled");
  }

  // Board scoping is mandatory so /api/boards/a/events never discloses board B.
  const filters: WatchFilters = { boardId: board.id };
  if (watchFilters) {
    if (hasAssignee) filters.assignee = params.get("assignee") ?? undefined;
    if (hasTenant) filters.tenant = params.get("tenant") ?? undefined;
    if (hasKinds) filters.kinds = params.get("kinds")!.split(",");
  }

  const since = params.get("since");
  const sinceId = since !== null ? Number(since) : null;
  // Bound the result set so a resumed tab cannot pull an unbounded backlog.
  let limit = params.get("limit") !== null ? Number(params.get("limit")) : 50;
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const events = sinceId !== null
    ? m.getEventsAfter(sinceId, filters, limit)
    : m.getRecentEvents(limit, filters);
  return { events: toCamel(events), since: sinceId, board: slug };
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

// KDI-UI-010: notification subscription mutations. The model's subscribe() already
// validates the notifier profile via getNotifier() and rejects duplicates /
// unsupported platforms / missing tasks with the same messages as the CLI, so the
// bridge only adds the FF_NOTIFY_SUBS gate and error normalization. ponytail: no
// re-validation; surface the model contract verbatim.
export interface NotifySubsFlags {
  sveltekitFrontend: boolean;
  notifySubs: boolean;
}

export function notifySubsFlags(): NotifySubsFlags {
  return {
    sveltekitFrontend: isEnabled(FF_SVELTEKIT_FRONTEND),
    notifySubs: isEnabled(FF_NOTIFY_SUBS),
  };
}

function requireNotifySubs(): void {
  if (!isEnabled(FF_NOTIFY_SUBS)) {
    throw new BridgeError("feature_disabled", 403, "Notification subscriptions feature is not enabled.");
  }
}

export interface SubscribeInput {
  threadId?: string;
  userId?: string;
  // undefined (not "") lets the model default to the platform name.
  notifierProfile?: string;
}

// Shape mirrors editTaskJson(slug, id, ...): the bridge verifies board membership
// so mutations stay consistent with the resolved board, matching every other
// task-scoped write helper. The model's subscribe()/unsubscribe() are not
// board-scoped, so this is where the UI's board context is enforced (FR-18).
//
// FR-13 requires the model's verbatim `Task <id> not found.` for a missing task,
// so we do NOT use assertTaskOnBoard() here (its message names the board). We
// check membership ourselves: a missing task falls through to the model, which
// throws the FR-13 message; a task that exists but belongs to another board is
// blocked with the same task_not_found code the rest of the bridge uses.
async function guardTaskOnBoard(m: Awaited<ReturnType<typeof models>>, slug: string, taskId: number): Promise<void> {
  const task = m.showTask(taskId);
  if (task && task.board_id !== (await resolveBoard(slug)).id) {
    throw new BridgeError("task_not_found", 404, `Task ${taskId} not found on board "${slug}".`);
  }
  // task missing -> fall through; the model throws `Task <id> not found.`
}

export async function subscribeJson(
  slug: string,
  taskId: number,
  platform: string,
  chatId: string,
  options: SubscribeInput = {},
): Promise<{ subscription: CamelCase<NotifySub> }> {
  requireNotifySubs();
  const m = await models();
  m.initDb();
  await guardTaskOnBoard(m, slug, taskId);
  try {
    const sub = m.subscribe(taskId, platform, chatId, {
      threadId: options.threadId,
      userId: options.userId,
      notifierProfile: options.notifierProfile,
    });
    return { subscription: toCamel(sub) };
  } catch (err) {
    throw wrap(err);
  }
}

export async function unsubscribeJson(
  slug: string,
  taskId: number,
  platform: string,
  chatId: string,
  threadId?: string,
): Promise<{ unsubscribed: number }> {
  requireNotifySubs();
  const m = await models();
  m.initDb();
  await guardTaskOnBoard(m, slug, taskId);
  try {
    const count = m.unsubscribe(taskId, platform, chatId, threadId);
    return { unsubscribed: count };
  } catch (err) {
    throw wrap(err);
  }
}

export function dispatchFlags(): DispatchFlags {
  return {
    canDispatch: isEnabled(FF_ENABLE_KANBAN_DISPATCH) && isEnabled(FF_DISPATCH_ONCE),
    canUseFailureLimit: isEnabled(FF_DISPATCH_CONTROLS),
    canUseRateLimitCooldown: isEnabled(FF_RATE_LIMIT_EXIT_CODE),
    canShowProfiles: isEnabled(FF_REAL_HARNESS_PROFILES),
  };
}

export interface DispatchTrigger {
  max: number;
  failureLimit?: number;
  rateLimitCooldown?: string;
}

export async function dispatchStatusJson(slug: string): Promise<DispatchStatus> {
  const board = await resolveBoard(slug);
  const dp = await import("~/dispatcherPresence");
  const present = dp.isDispatcherPresent(slug);
  const pid = present ? dp.getDispatcherPid(slug) : null;
  const checkedAt = Math.floor(Date.now() / 1000);
  const m = await models();
  const profilesEnabled = isEnabled(FF_REAL_HARNESS_PROFILES);
  const profilesPath = defaultProfilesPath();
  const profileEntries: ProfileHealth[] = profilesEnabled
    ? (toCamel(doctorProfiles(profilesPath)) as ProfileHealth[])
    : [];
  const failures = toCamel(m.getRecentBoardRunFailures(board.id)) as SpawnFailure[];
  return {
    board: slug,
    presence: { present, pid, checkedAt },
    taskCounts: board.taskCounts as TaskCounts,
    profiles: { enabled: profilesEnabled, path: profilesPath, entries: profileEntries },
    recentFailures: { enabled: true, failures },
    flags: dispatchFlags(),
  };
}

export async function dispatchOnceJson(slug: string, body: DispatchTrigger): Promise<DispatchOnceResult> {
  if (!isEnabled(FF_ENABLE_KANBAN_DISPATCH) || !isEnabled(FF_DISPATCH_ONCE)) {
    throw new BridgeError("feature_disabled", 403, "One-shot dispatch is not enabled.");
  }
  const board = await resolveBoard(slug);
  if (typeof body.max !== "number" || !Number.isInteger(body.max) || body.max < 0) {
    throw new BridgeError("invalid_max", 400, "max must be a non-negative integer");
  }
  let failureLimit: number | undefined;
  if (body.failureLimit !== undefined) {
    if (!isEnabled(FF_DISPATCH_CONTROLS)) {
      throw new BridgeError("feature_disabled", 403, "failure-limit is not enabled");
    }
    if (typeof body.failureLimit !== "number" || !Number.isInteger(body.failureLimit) || body.failureLimit <= 0) {
      throw new BridgeError("invalid_failure_limit", 400, "failureLimit must be a positive integer");
    }
    failureLimit = body.failureLimit;
  }
  let rateLimitCooldownSeconds: number | undefined;
  if (body.rateLimitCooldown !== undefined) {
    if (!isEnabled(FF_RATE_LIMIT_EXIT_CODE)) {
      throw new BridgeError("feature_disabled", 403, "rate-limit-cooldown is not enabled");
    }
    const m = await models();
    try {
      rateLimitCooldownSeconds = m.parseDuration(body.rateLimitCooldown);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BridgeError("invalid_duration", 400, message);
    }
  }
  const { tick } = await import("~/dispatcher");
  try {
    const result = await tick({
      boardId: board.id,
      boardSlug: slug,
      maxSpawnsPerTick: body.max === 0 ? Infinity : body.max,
      rateLimitCooldownSeconds,
      failureLimit,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BridgeError("dispatch_failed", 500, message);
  }
}

export async function bootstrapProfilesJson(slug: string, force = false): Promise<{ profiles: ProfileHealth[] }> {
  await resolveBoard(slug);
  const path = defaultProfilesPath();
  bootstrapRealProfiles(path, force);
  const entries = doctorProfiles(path);
  return { profiles: toCamel(entries) as ProfileHealth[] };
}

// ---------------------------------------------------------------------------
// Task lifecycle actions (KDI-UI-006)
// ---------------------------------------------------------------------------
//
// Single choke point for every task mutation the UI surfaces: promote, block,
// unblock, schedule, review, archive, complete, assign, reassign, claim,
// reclaim, heartbeat. Each calls the SAME model function the CLI uses, re-checks
// the SAME feature flag server-side (rejecting with the CLI error text), and
// returns a per-task { taskId, status, message, currentStatus? } so the UI can
// render success/skip/error uniformly. Bulk loops the single-task core.
// ponytail: one core applier shared by single + bulk; flag/field validation
// factored so neither path drifts from CLI semantics.

// UTF-8 byte budget for heartbeat notes. The model constant
// (MAX_HEARTBEAT_NOTE_BYTES in src/models/claim.ts) is NOT exported and is
// enforced via JS `.length` / `.slice()` (UTF-16 code units), which under-counts
// multibyte input — CJK (3 bytes/char) or emoji (4 bytes) blow past 4 KiB.
// We clamp by true UTF-8 bytes at this server boundary; the model's looser
// char cap becomes a harmless no-op. The deeper model/CLI char-based bug is
// tracked as tech debt (out of scope here per AC-27: no src/models churn).
export const MAX_HEARTBEAT_NOTE_BYTES = 4096;

// Longest prefix of `str` whose UTF-8 byte length is <= maxBytes, never
// splitting a code point. Binary-search on UTF-16 indices for the byte budget,
// then back up one if we landed mid-surrogate-pair (a trailing high surrogate
// would corrupt the persisted note). ponytail: O(log n) + one O(1) guard.
export function clampUtf8Bytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // Binary search lands on a UTF-16 index. If `lo` sits inside a surrogate
  // pair (trailing char is a high surrogate), back up one so we end on a
  // complete code point. e.g. "a".repeat(4093)+"🎯" (4097 bytes) → 4094,
  // which is mid-pair; back up to 4093 (the last "a").
  if (lo > 0 && (str.charCodeAt(lo - 1) & 0xfc00) === 0xd800) lo--;
  return str.slice(0, lo);
}

export const SINGLE_LIFECYCLE_ACTIONS: ReadonlySet<LifecycleAction> = new Set([
  "promote", "block", "unblock", "schedule", "review", "archive",
  "complete", "assign", "reassign", "claim", "reclaim", "heartbeat",
]);

export const BULK_LIFECYCLE_ACTIONS: ReadonlySet<LifecycleAction> = new Set([
  "promote", "block", "unblock", "schedule", "archive", "complete",
]);

export function lifecycleFlags(): LifecycleFlags {
  return {
    bulkOperations: isEnabled(FF_BULK_OPERATIONS),
    scheduledStatus: isEnabled(FF_SCHEDULED_STATUS),
    reviewStatus: isEnabled(FF_REVIEW_STATUS),
    completeMetadata: isEnabled(FF_COMPLETE_METADATA),
    assignReassign: isEnabled(FF_ASSIGN_REASSIGN),
    heartbeat: isEnabled(FF_HEARTBEAT),
  };
}

// Server-side flag re-check mirroring the CLI command gates. A flag off → hard
// reject of the whole request (403) with the CLI error text, never a fake per-
// task success. Client gating is UX only; this is the trust boundary.
function validateActionFlags(action: LifecycleAction, fields: LifecycleFields): void {
  switch (action) {
    case "promote":
      // force/dry-run are bulk-operations features even on a single task.
      if ((fields.force || fields.dryRun) && !isEnabled(FF_BULK_OPERATIONS))
        throw new BridgeError("feature_disabled", 403, "Bulk operations feature is not enabled.");
      break;
    case "schedule":
      if (!isEnabled(FF_SCHEDULED_STATUS))
        throw new BridgeError("feature_disabled", 403, "Scheduled status feature is not enabled.");
      break;
    case "review":
      if (!isEnabled(FF_REVIEW_STATUS))
        throw new BridgeError("feature_disabled", 403, "Review status feature is not enabled.");
      break;
    case "assign":
    case "reassign":
      if (!isEnabled(FF_ASSIGN_REASSIGN))
        throw new BridgeError("feature_disabled", 403, "Assign/reassign feature is not enabled.");
      break;
    case "reclaim":
      // Base reclaim is ungated; only --reason needs FF_ASSIGN_REASSIGN.
      if (fields.reason !== undefined && !isEnabled(FF_ASSIGN_REASSIGN))
        throw new BridgeError("feature_disabled", 403, "The --reason option requires the assign/reassign feature.");
      break;
    case "heartbeat":
      if (!isEnabled(FF_HEARTBEAT))
        throw new BridgeError("feature_disabled", 403, "Heartbeat feature is not enabled.");
      break;
    case "complete":
      if (fields.metadata !== undefined && !isEnabled(FF_COMPLETE_METADATA))
        throw new BridgeError("feature_disabled", 403, "Complete --metadata is not enabled.");
      break;
    // block, unblock, archive, claim: no per-action flag (mirror CLI).
  }
}

// Required-field / value validation at the trust boundary.

// Runtime type-check every provided field. A malformed POST (e.g.
// {"reason": 123}) must get a clean 400, never a TypeError 500.
function validateFieldTypes(fields: LifecycleFields): void {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields))
    throw new BridgeError("invalid_input", 400, "Fields must be an object.");
  if (fields.reason !== undefined && typeof fields.reason !== "string")
    throw new BridgeError("invalid_input", 400, "reason must be a string.");
  if (fields.at !== undefined && typeof fields.at !== "number")
    throw new BridgeError("invalid_input", 400, "at must be a number (unix seconds).");
  if (fields.force !== undefined && typeof fields.force !== "boolean")
    throw new BridgeError("invalid_input", 400, "force must be a boolean.");
  if (fields.dryRun !== undefined && typeof fields.dryRun !== "boolean")
    throw new BridgeError("invalid_input", 400, "dryRun must be a boolean.");
  if (fields.profile !== undefined && typeof fields.profile !== "string")
    throw new BridgeError("invalid_input", 400, "profile must be a string.");
  if (fields.reclaim !== undefined && typeof fields.reclaim !== "boolean")
    throw new BridgeError("invalid_input", 400, "reclaim must be a boolean.");
  if (fields.ttl !== undefined && typeof fields.ttl !== "number")
    throw new BridgeError("invalid_input", 400, "ttl must be a number.");
  if (fields.note !== undefined && typeof fields.note !== "string")
    throw new BridgeError("invalid_input", 400, "note must be a string.");
  if (fields.result !== undefined && typeof fields.result !== "string")
    throw new BridgeError("invalid_input", 400, "result must be a string.");
  if (fields.summary !== undefined && typeof fields.summary !== "string")
    throw new BridgeError("invalid_input", 400, "summary must be a string.");
  if (fields.metadata !== undefined && typeof fields.metadata !== "string")
    throw new BridgeError("invalid_input", 400, "metadata must be a string.");
}

function validateActionFields(action: LifecycleAction, fields: LifecycleFields): void {
  switch (action) {
    case "block":
      if (!fields.reason || fields.reason.trim() === "")
        throw new BridgeError("invalid_input", 400, "Block reason is required.");
      break;
    case "schedule": {
      if (typeof fields.at !== "number" || !Number.isFinite(fields.at))
        throw new BridgeError("invalid_input", 400, "Scheduled time is required.");
      if (fields.at <= Math.floor(Date.now() / 1000))
        throw new BridgeError("invalid_input", 400, "Scheduled time must be in the future");
      break;
    }
    case "assign":
    case "reassign":
      if (typeof fields.profile !== "string" || fields.profile.trim() === "")
        throw new BridgeError("invalid_input", 400, "Profile is required.");
      break;
    case "complete":
      if (fields.metadata !== undefined) {
        try {
          JSON.parse(fields.metadata);
        } catch {
          throw new BridgeError("invalid_input", 400, "Metadata must be valid JSON.");
        }
      }
      break;
    case "claim":
      if (fields.ttl !== undefined) {
        if (typeof fields.ttl !== "number" || isNaN(fields.ttl) || fields.ttl <= 0 || !Number.isInteger(fields.ttl))
          throw new BridgeError("invalid_input", 400, "TTL must be a positive integer");
      }
      break;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function success(taskId: number, message: string, currentStatus?: string): LifecycleResult {
  return { taskId, status: "success", message, currentStatus };
}
function skipped(taskId: number, message: string, currentStatus?: string): LifecycleResult {
  return { taskId, status: "skipped", message, currentStatus };
}
function errored(taskId: number, message: string, currentStatus?: string): LifecycleResult {
  return { taskId, status: "error", message, currentStatus };
}

// Core per-task applier. No flag checks (done once per request), no board
// membership check (caller does it) — just precondition + model call + result
// mapping. Shared by single and bulk so semantics never drift.
function applyTaskAction(
  m: Awaited<ReturnType<typeof models>>,
  id: number,
  action: LifecycleAction,
  fields: LifecycleFields,
): LifecycleResult {
  switch (action) {
    case "promote": {
      const r = m.promoteTaskAdvanced(id, { force: fields.force, dryRun: fields.dryRun });
      switch (r.status) {
        case "promoted": return success(id, `Promoted task ${id} to ready.`, "ready");
        case "would_promote": return success(id, `Dry run: would promote task ${id} to ready.`, "todo");
        case "not_found": return skipped(id, "not_found");
        case "archived": return skipped(id, "archived");
        case "wrong_status": return skipped(id, `wrong_status (current: ${r.current})`, r.current);
        case "blocked_by_dependencies": return skipped(id, "blocked_by_dependencies");
      }
      return errored(id, "unknown promote verdict");
    }
    case "block": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      if (t.status === "blocked") return skipped(id, "already blocked", "blocked");
      try {
        const x = m.blockTask(id, fields.reason!);
        return success(id, `Blocked task ${id}.`, x.status);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "unblock": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      if (t.status !== "blocked" && t.status !== "scheduled")
        return skipped(id, `wrong_status (current: ${t.status})`, t.status);
      // scheduled→ready needs the scheduled-status feature (mirror CLI per-task guard).
      if (t.status === "scheduled" && !isEnabled(FF_SCHEDULED_STATUS))
        return skipped(id, "scheduled status feature is not enabled", t.status);
      try {
        const x = m.unblockTask(id, fields.reason);
        return success(id, x.status === "ready" ? `Task ${id} is now ready.` : `Unblocked task ${id}.`, x.status);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "schedule": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      try {
        const x = m.scheduleTask(id, fields.at!, fields.reason);
        return success(id, `Scheduled task ${id} for ${new Date(fields.at! * 1000).toISOString()}.`, x.status);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "review": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      if (t.status === "review") return skipped(id, "already in review", "review");
      try {
        const x = m.reviewTask(id, fields.reason);
        return success(id, `Marked task ${id} as under review.`, x.status);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "archive": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      try {
        m.archiveTask(id);
        return success(id, `Archived task ${id}.`, "archived");
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "complete": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      try {
        const x = m.completeTask(id, {
          result: fields.result,
          summary: fields.summary,
          metadata: fields.metadata,
        });
        return success(id, `Completed task ${id}.`, x.status);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "assign": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      const profile = fields.profile!;
      try {
        if (profile.toLowerCase() === "none") {
          m.unassignTask(id);
          return success(id, `Unassigned task ${id}.`);
        }
        m.assignTask(id, profile);
        return success(id, `Assigned task ${id} to ${profile}.`);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "reassign": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      const profile = fields.profile!;
      const target = profile.toLowerCase() === "none" ? null : profile;
      try {
        m.reassignTask(id, target, { reclaim: fields.reclaim, reason: fields.reason });
        return success(id, target === null ? `Unassigned task ${id}.` : `Reassigned task ${id} to ${target}.`);
      } catch (e) {
        return errored(id, errMsg(e));
      }
    }
    case "claim": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      if (t.status !== "ready") return skipped(id, `wrong_status (current: ${t.status})`, t.status);
      const profile = fields.profile?.trim() || resolveCurrentProfile();
      const r = m.atomicClaim(id, profile, fields.ttl);
      if (!r.success) return skipped(id, "not ready or already claimed", t.status);
      return success(id, `Claimed task ${id}.`, "running");
    }
    case "reclaim": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      if (t.status !== "running") return skipped(id, `wrong_status (current: ${t.status})`, t.status);
      if (t.claim_lock === null) return skipped(id, "no active claim", t.status);
      const ok = m.reclaimTask(id, fields.reason);
      if (!ok) return skipped(id, "not running or no active claim", t.status);
      return success(id, `Reclaimed task ${id}.`, "ready");
    }
    case "heartbeat": {
      const t = m.showTask(id);
      if (!t) return skipped(id, "not_found");
      if (t.archived_at !== null) return skipped(id, "already archived", "archived");
      if (t.status !== "running") return skipped(id, `wrong_status (current: ${t.status})`, t.status);
      // Enforce the 4 KiB byte budget (not char count) at the boundary so
      // multibyte input cannot exceed it.
      const note = fields.note !== undefined ? clampUtf8Bytes(fields.note, MAX_HEARTBEAT_NOTE_BYTES) : undefined;
      const ok = m.heartbeat(id, note);
      if (!ok) return skipped(id, "not running", t.status);
      return success(id, `Heartbeat recorded for task ${id}.`);
    }
  }
}

export async function performTaskAction(
  slug: string,
  id: number,
  action: LifecycleAction,
  fields: LifecycleFields = {},
): Promise<{ result: LifecycleResult }> {
  if (!SINGLE_LIFECYCLE_ACTIONS.has(action))
    throw new BridgeError("invalid_action", 400, `Action "${action}" is not a single-task lifecycle action.`);
  validateActionFlags(action, fields);
  validateFieldTypes(fields);
  validateActionFields(action, fields);
  await assertTaskOnBoard(slug, id);
  const m = await models();
  return { result: applyTaskAction(m, id, action, fields) };
}

export async function performBulkAction(
  slug: string,
  action: LifecycleAction,
  taskIds: number[],
  fields: LifecycleFields = {},
): Promise<BulkLifecycleResult> {
  if (!BULK_LIFECYCLE_ACTIONS.has(action))
    throw new BridgeError("invalid_action", 400, `Action "${action}" is not bulk-capable.`);
  if (!isEnabled(FF_BULK_OPERATIONS))
    throw new BridgeError("feature_disabled", 403, "Bulk operations feature is not enabled.");
  if (!Array.isArray(taskIds) || taskIds.length === 0)
    throw new BridgeError("invalid_input", 400, "taskIds must be a non-empty array.");
  for (const id of taskIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0)
      throw new BridgeError("invalid_input", 400, "taskIds must be positive integers.");
  }
  // Bulk complete supports only result (mirror CLI).
  if (action === "complete" && (fields.summary !== undefined || fields.metadata !== undefined))
    throw new BridgeError("invalid_input", 400, "Bulk complete only supports result.");
  validateActionFlags(action, fields);
  validateFieldTypes(fields);
  validateActionFields(action, fields);
  const board = await resolveBoard(slug);
  const m = await models();
  const results: LifecycleResult[] = [];
  for (const id of taskIds) {
    // Board membership per task: missing/off-board tasks skip, not abort.
    const t = m.showTask(id);
    if (!t || t.board_id !== board.id) {
      results.push(skipped(id, "not_found"));
      continue;
    }
    results.push(applyTaskAction(m, id, action, fields));
  }
  const summary = {
    attempted: results.length,
    succeeded: results.filter((r) => r.status === "success").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "error").length,
  };
  return { results, summary };
}
