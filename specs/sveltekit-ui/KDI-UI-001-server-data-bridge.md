# BRD-KDI-UI-001: Server-Side Data Bridge

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give the SvelteKit operator UI (see `specs/sveltekit-ui-backlog.md`) a server-side
way to read and write KDI state by calling the existing CLI model layer directly,
without spawning the CLI binary, duplicating SQL, or exposing SQLite to the
browser. The bridge returns small JSON shapes designed for UI screens, not raw
CLI text.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
KDI's data access today lives entirely in the CLI: `src/commands/*.ts` call
`src/models/*.ts`, which call `getDb()` from `src/db.ts` (a single in-process
`bun:sqlite` instance). A SvelteKit UI has no server route to reach that data
yet. If the UI talked to the CLI via shell-out, every screen would pay process
spawn cost and parse brittle text. If it opened its own SQLite connection, it
would race the dispatcher's writes and duplicate the schema knowledge. The clean
path is to import the model layer from SvelteKit server-side code and return
JSON.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| UI access to KDI data | None (no UI exists) | SvelteKit server routes call `src/models/*` |
| SQLite access | CLI process only, via `getDb()` | Server route process only, via the same `getDb()` |
| Browser SQLite access | N/A | Forbidden; browser never touches SQLite |
| Response shape | CLI text / `--json` CLI output | Small JSON shapes per screen |
| DB resolution | `KDI_DB` → `KDI_DB_PATH` → default | Identical env chain, honored server-side |
| Dispatcher/UI isolation | N/A | Same process holds the same singleton DB; no separate writer |

-------------------------------------------------------------------------------
Scope
-------------------------------------------------------------------------------
In scope:
- SvelteKit server routes (`+server.ts`) and/or `load` functions (`+page.server.ts`)
  that call existing `src/models/*` functions for: boards, tasks, events, runs,
  logs, stats, diagnostics, workflows, and notifications.
- A JSON shape contract per resource (read and minimal write).
- One smoke test that creates a temp board/task through the bridge and reads
  it back with isolated `HOME` and `KDI_DB`.

Out of scope (owned by other UI backlog items):
- KDI-UI-000: the SvelteKit app shell, scaffolding, layout, navigation.
- KDI-UI-002..006: board/task UI components, kanban view, lifecycle actions.
- UI auth, multi-user permissions, WebSockets/SSE (polling only for v1).
- Any new model function. If a UI screen needs a query the models do not yet
  expose, the bridge returns a `501`/`not_implemented` shape and the gap is
  filed as a follow-up; the bridge does not write new SQL.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- KDI-UI-000 (SvelteKit app shell) must land first; this BRD assumes the app
  at `apps/web/` exists and `bun run build` (CLI) still passes.
- All `src/models/*` functions listed in the Resource Map.
- `src/db.ts`: `getDb()`, `defaultDbPath()`, `getBoardDataDir()`, `initDb()`.
- Feature flag `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND`
  (and browser form `VITE_FF_SVELTEKIT_FRONTEND`), already registered in
  `specs/feature-flags.md`.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- New model functions or SQL queries; the bridge wraps existing models only.
- A separate HTTP API service or microservice. The backlog decision is a single
  SvelteKit app calling models in-process until deployment forces otherwise.
- Browser-side SQLite (WASM or otherwise).
- Auth, sessions, or multi-tenant permissions.
- Real-time push (SSE/WebSockets). Polling is enough for v1.
- Rendering any HTML; this BRD is data only. Components are KDI-UI-002+.
- Dispatching tasks from the UI. Dispatch control center is KDI-UI-007.

-------------------------------------------------------------------------------
Architecture Decisions
-------------------------------------------------------------------------------
1. **In-process model import.** Server routes import from `~/models/*` the same
   way CLI commands do. No second DB connection class, no HTTP client to self.
2. **One process, one DB singleton.** `getDb()` in `src/db.ts` caches a single
   `Database`. The SvelteKit dev/prod server process owns that singleton for the
   lifetime of the process. The CLI dispatcher runs as a *separate* process with
   its own DB file; the bridge must never share a DB file with a running
   dispatcher. Isolation is by `KDI_DB`, same as worktree/test isolation.
3. **Server-only SQLite.** All `import` of models and `bun:sqlite` stays in
   `+server.ts` / `+page.server.ts`. SvelteKit's `$env/static/public` and client
   modules must never import a model.
4. **JSON, not CLI text.** Each route defines a typed response shape. No route
   shells out to `./kdi ... --json` and re-parses.
5. **Gate the surface, not the data.** When `FF_SVELTEKIT_FRONTEND=false`, the
   bridge routes still exist (so feature-detect works) but return
   `{ "enabled": false }` with HTTP `503` (or a `404` for the whole route tree,
   chosen by the implementer). No UI mutation succeeds while the flag is off.
6. **Read-heavy, write-minimal.** v1 bridges expose read endpoints broadly and
   only the writes needed for the smoke test (create board, create task). Other
   writes (promote, complete, assign, lifecycle) land with KDI-UI-006.

-------------------------------------------------------------------------------
Resource Map
-------------------------------------------------------------------------------
Routes live under `apps/web/src/routes/api/` (concrete paths are a suggestion;
the implementer may restructure as long as the contract holds). Each row lists
the model function the route calls and the JSON shape it returns.

Boards (`src/models/board.ts`)
| Route | Method | Model call | JSON shape |
|---|---|---|---|
| `/api/boards` | GET | `listBoards(includeArchived)` | `{ boards: BoardSummary[] }` where `BoardSummary = { id, slug, name, workdir, base_ref, archived: boolean, taskCounts }` |
| `/api/boards/[slug]` | GET | `showBoard(slug)` | `BoardWithTaskCounts` (snake_case → camelCase) or 404 |
| `/api/boards` | POST | `createBoard(slug, workdir, baseRef, metadata)` | `{ board: BoardSummary }` (smoke-test required) |

Tasks (`src/models/task.ts`)
| Route | Method | Model call | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks` | GET | `listTasks(filter, sort)` | `{ tasks: TaskSummary[] }` (`TaskSummary` = id, title, status, assignee, priority, tenant, updated_at, archived_at) |
| `/api/boards/[slug]/tasks/[id]` | GET | `showTask(id)` | `Task` (camelCase) or 404 |
| `/api/boards/[slug]/tasks` | POST | `createTask(input)` | `{ task: TaskSummary }` (smoke-test required) |
| `/api/boards/[slug]/assignees` | GET | `getAssigneeCounts(boardId)` | `{ assignees: Record<string, number> }` |
| `/api/boards/[slug]/stats` | GET | `getBoardStats(slug)` | `BoardStats` (camelCase) |

Events / runs / logs (`src/models/taskEvent.ts`, `src/models/taskRun.ts`)
| Route | Method | Model call | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/events` | GET | `getEvents(taskId)` or `tailEvents(taskId, since)` | `{ events: TaskEvent[] }` |
| `/api/boards/[slug]/events` | GET | `getRecentEvents(limit, filters)` / `getEventsAfter(since, filters)` | `{ events: TaskEvent[] }` (poll anchor) |
| `/api/boards/[slug]/tasks/[id]/runs` | GET | `getRuns(taskId)` / `getRunsFiltered(taskId, filter)` | `{ runs: TaskRun[] }` |
| `/api/boards/[slug]/tasks/[id]/runs/[runId]` | GET | `getRun(id)` | `TaskRun` or 404 |

Context, comments, attachments (`src/models/context.ts`, `comment.ts`, `taskAttachment.ts`)
| Route | Method | Model call | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/context` | GET | `buildTaskContext(taskId, boardSlug)` | `TaskContext` (camelCase) |
| `/api/boards/[slug]/tasks/[id]/comments` | GET | `getComments(taskId)` | `{ comments: Comment[] }` |
| `/api/boards/[slug]/tasks/[id]/attachments` | GET | `listAttachments(taskId)` | `{ attachments: TaskAttachment[] }` |

Diagnostics / workflows / notifications (`src/models/diagnostic.ts`, `workflowTemplate.ts`, `notifySub.ts`)
| Route | Method | Model call | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/diagnostics` | GET | `runDiagnostics(...)` | `{ diagnostics: Diagnostic[] }` |
| `/api/boards/[slug]/workflows` | GET | `listWorkflowTemplates(boardId)` | `{ templates: WorkflowTemplate[] }` |
| `/api/subscriptions` | GET | `listSubscriptions(filters)` | `{ subscriptions: Subscription[] }` |

If a listed model signature is not yet enough for a clean UI shape, the route
returns `501 { "error": "not_implemented", "reason": "model gap" }` and the gap
is filed as a follow-up backlog item. The bridge adds no new SQL.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- Every bridge route lives server-side only (`+server.ts` / `+page.server.ts`)
  and imports models via the `~/*` alias the CLI already uses.
- Every response is JSON with a documented shape; snake_case DB columns are
  normalized to camelCase at the route boundary so the browser sees one
  convention.
- `KDI_DB` / `KDI_DB_PATH` / default path resolution from `src/db.ts` is honored
  server-side with no code change to `db.ts`; the route process inherits the env.
- When `FF_SVELTEKIT_FRONTEND=false`, bridge routes do not mutate state and
  signal disabled (see Architecture Decision 5).
- Board/task creation routes validate input the same way the CLI commands do —
  by calling the model functions, which already validate (e.g.
  `assertValidBoardSlug`, `validateMetadataField`).
- Errors from model functions surface as JSON with HTTP 4xx/5xx and a stable
  `{ "error": "<code>", "message": "<human>" }` shape; never a stack trace in
  production. Keep the dev-mode stack for local debugging.
- No route spawns the CLI binary; no route opens a second SQLite connection
  outside `getDb()`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- A read route round-trip is sub-50ms on a local board with <1k tasks; polling
  a board at 2s intervals must not pin CPU.
- The dev server and a CLI dispatcher must not share a DB file; the smoke test
  and docs state this. (Same isolation rule as worktrees in `AGENTS.md`.)
- No new runtime dependency beyond what SvelteKit + Bun already pull in.
- `bun run build` (CLI compile) and the SvelteKit build both pass with an
  isolated `KDI_DB`.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Board slug does not exist | `404 { "error": "board_not_found" }` |
| Task id not on board | `404 { "error": "task_not_found" }` |
| Create board with invalid slug | `400 { "error": "invalid_slug", "message": ... }` (from `assertValidBoardSlug`) |
| Create task with missing title | `400 { "error": "invalid_input", "message": ... }` (from `createTask`) |
| `FF_SVELTEKIT_FRONTEND=false`, POST | `503 { "enabled": false }`; no write occurs |
| `FF_SVELTEKIT_FRONTEND=false`, GET | `503 { "enabled": false }` (or 404 tree) |
| Model throws unhandled error | `500 { "error": "internal" }`; dev keeps stack |
| DB file missing | Route triggers `initDb()` once on first request OR returns `500 { "error": "db_not_initialized" }` — implementer picks; documented in the route tree |
| Dispatcher holds the same DB file | Unsupported; docs and smoke test require a separate `KDI_DB`. Write routes are still safe (SQLite WAL) but not guaranteed visually consistent until reload |

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
Gated by `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (already registered in
`specs/feature-flags.md`, default `false`). Browser side uses
`VITE_FF_SVELTEKIT_FRONTEND` once client code exists. No new feature flag is
introduced by this BRD; the whole UI backlog lives under the one flag.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] A `GET /api/boards` route returns JSON listing boards via
      `listBoards`, server-side only, no CLI spawn.
- [ ] A `POST /api/boards` route creates a board via `createBoard` and returns
      the new board summary.
- [ ] A `GET /api/boards/[slug]/tasks` route returns tasks via `listTasks`.
- [ ] A `POST /api/boards/[slug]/tasks` route creates a task via `createTask`
      and returns the new task summary.
- [ ] A `GET /api/boards/[slug]/tasks/[id]` route returns the task via
      `showTask`.
- [ ] A `GET /api/boards/[slug]/tasks/[id]/events` route returns events via
      `getEvents`/`tailEvents`.
- [ ] A `GET /api/boards/[slug]/tasks/[id]/runs` route returns runs via
      `getRuns`/`getRunsFiltered`.
- [ ] Read routes exist for context, comments, attachments, diagnostics,
      workflows, and subscriptions per the Resource Map.
- [ ] All responses are JSON with camelCase keys; no raw CLI text is returned.
- [ ] No route imports `bun:sqlite` or a model on the client side; SQLite stays
      server-side only (verified by a build/grep check in the smoke test).
- [ ] `KDI_DB` resolution from `defaultDbPath()` is honored server-side with no
      change to `src/db.ts`.
- [ ] With `FF_SVELTEKIT_FRONTEND=false`, no write route mutates state and GET
      routes signal disabled.
- [ ] One smoke test with temp `HOME` and temp `KDI_DB` creates a board and a
      task through the bridge, then reads both back through the bridge and
      asserts the returned JSON matches what the CLI `show` returns against the
      same DB.
- [ ] `bun run lint`, `bun run build` (CLI), and the SvelteKit build all pass
      with isolated `KDI_DB`.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Implementation should prove:
- Smoke test uses temp `HOME` + temp `KDI_DB` (same pattern as
  `kdi-new-feature-loop` and `AGENTS.md` worktree isolation). Start the
  SvelteKit dev server against that DB, hit the create-board and create-task
  POST routes, then GET them back, then run `kdi show <id>` against the same
  DB and diff the JSON to the CLI output.
- A grep/build check that no client module (`*.ts` not under a `+server` /
  `+page.server` file, or anything importable by `$app/stores`) imports
  `~/models/*` or `bun:sqlite`.
- Run `bun run lint` and both builds (CLI `bun run build` and the SvelteKit
  build) in the smoke environment.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk: DB file contention with a live dispatcher.** The bridge process and a
  running `kdi dispatch --loop` could point at the same DB file. WAL makes
  writes safe but the UI can show stale state between polls. **Mitigation:**
  document that the UI should run against a DB not actively driven by a
  dispatcher, or accept poll lag; do not add locking in the bridge.
- **Open question:** Does the bridge call `initDb()` on first request if the DB
  file is missing, or fail with `db_not_initialized`? This BRD leaves it to the
  implementer; the chosen behavior must be documented at the route tree.
- **Open question:** Should write routes (create board/task) also write a board
  event for audit, mirroring CLI side effects? The models already call
  `addEvent` where the CLI does; the bridge inherits that by calling the model.
  Confirm no extra event is needed.
- **Open question:** camelCase normalization layer — one shared helper or
  per-route `toCamel`? Implementer's call; keep it to one helper to avoid drift
  (ponytail: one place, not eleven).

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration. The bridge uses existing schema and models.
- No change to `src/db.ts`. The same `getDb()` singleton serves the CLI and the
  server process (in their own processes, against their own `KDI_DB`).

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a section under the SvelteKit UI Backlog - Drafted area:

```markdown
## KDI-UI-001: Server-Side Data Bridge — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`
- [ ] SvelteKit server routes call existing `src/models/*` for boards, tasks,
      events, runs, context, comments, attachments, diagnostics, workflows,
      notifications (read) and board/task create (write)
- [ ] All responses JSON + camelCase; SQLite server-side only
- [ ] `KDI_DB` resolution honored server-side; `FF_SVELTEKIT_FRONTEND=false`
      disables writes and signals disabled for reads
- [ ] Smoke test with temp HOME/KDI_DB creates board+task via bridge and reads
      back, matching CLI `show`
- [ ] `bun run lint`, CLI build, SvelteKit build pass
```

-------------------------------------------------------------------------------
Spec Location
-------------------------------------------------------------------------------
`specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-ui-001-server-data-bridge`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD was non-editing and ran in the shared checkout.)