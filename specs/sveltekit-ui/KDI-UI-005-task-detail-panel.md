# BRD-KDI-UI-005: Task Detail Panel

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give the SvelteKit operator UI a focused task inspection screen that surfaces
everything an operator needs to understand a single task: body, metadata,
result, history, comments, attachments, dependencies, worker context, runs,
events, worker log, and preserved worktree handoff artifacts. The panel reuses
the server-side data bridge from KDI-UI-001 and adds only the missing read-only
routes and UI components required to display task state.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
KDI stores rich per-task state across the `tasks`, `task_runs`, `task_events`,
`comments`, `task_attachments`, and `dependencies` tables, plus worker logs on
disk and worktree handoff events in the event stream. Today this information is
only available through `kdi show`, `kdi runs`, `kdi tail`, `kdi log`, `kdi
context`, and `kdi attach`. There is no UI screen that brings these streams
together into one inspectable view. Operators must switch between CLI commands
to understand a task's full state.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Task inspection | CLI `kdi show` + `kdi runs` + `kdi tail` + `kdi log` | One UI panel with all sections |
| Task body editing | CLI `kdi edit` | Read-only display in detail panel (edits are KDI-UI-006) |
| Comments | CLI `kdi show` only lists them | Section in detail panel with author + timestamp |
| Attachments | CLI `kdi show` only lists names | Section with filename, size, content type, uploader |
| Dependencies | CLI `kdi show` does not display them | Section with parent/child task summaries |
| Worker log | CLI `kdi log` | Section with tail view and refresh |
| Events/tail | CLI `kdi tail` | Section polling newest events |
| Runs | CLI `kdi runs` | Section with status/outcome filters |
| Handoff | Only visible in `worktree_handed_off` event or filesystem | Section shows preserved branch and worktree path |

-------------------------------------------------------------------------------
Scope
-------------------------------------------------------------------------------
In scope:
- A task detail page/panel in `apps/web/` reachable from the board view and from
  a direct route.
- Read-only server routes for the missing pieces the data bridge did not already
  cover: worker log, dependencies, and worktree handoff metadata.
- A single aggregate endpoint that returns the full task detail snapshot for
  initial page load.
- Sections for body, metadata, result/summary, comments, attachments,
  dependencies, context, runs, events, worker log, and worktree handoff.
- Run filtering by status/outcome and event/log tail views with pause/resume.

Out of scope (owned by other backlog items):
- KDI-UI-003: the kanban board view that opens the detail panel.
- KDI-UI-004: task creation and editing forms.
- KDI-UI-006: lifecycle actions (comment, attach, promote, block, complete, etc.).
- KDI-UI-008: live activity stream at board level.
- KDI-UI-009: stats and diagnostics screens.
- Real-time push (SSE/WebSockets). Polling is enough for v1.
- Multi-user auth or permissions.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- KDI-UI-000 (SvelteKit app shell) must exist and `FF_SVELTEKIT_FRONTEND` must
  be wired in `apps/web/src/hooks.server.ts`.
- KDI-UI-001 (server-side data bridge) must expose the read routes for task,
  runs, events, comments, attachments, and context. KDI-UI-005 adds the
  remaining read-only endpoints and consumes those existing ones.
- All model functions: `showTask`, `getRuns`, `getRunsFiltered`, `getEvents`,
  `tailEvents`, `getComments`, `listAttachments`, `buildTaskContext`,
  `getChildTasks`, `getBoardById`, `getTaskLogPath`, and event helpers.
- Feature flag `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (already
  registered in `specs/feature-flags.md`).

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Mutating task state. Add comment, attach, promote, block, complete, and all
  other actions belong to KDI-UI-006.
- Editing the task body inline. Display only; edits go to KDI-UI-004/006.
- A separate service or proxy. The panel calls SvelteKit server routes that
  import existing models in-process, same as KDI-UI-001.
- Browser-side SQLite or direct model access.
- WebSocket/SSE real-time updates.
- Auth, sessions, or multi-tenant permissions.
- Inline code/syntax highlighting for logs or results (plain text is enough).

-------------------------------------------------------------------------------
Architecture Decisions
-------------------------------------------------------------------------------
1. **Display-only panel.** KDI-UI-005 is the read side. The panel can render
   action affordances (buttons, reason inputs) as disabled placeholders until
   KDI-UI-006 wires them, but it must not mutate state.
2. **Aggregate endpoint for initial load.** A single `/api/boards/[slug]/tasks/[id]/detail`
   route returns the full snapshot so the panel renders in one round trip. The
   endpoint calls the same model functions KDI-UI-001 exposes individually.
3. **Specialized refresh endpoints.** Worker log and event streams use their own
   routes (`/log`, `/events?since=...`) so polling/refreshes do not re-fetch the
   whole aggregate.
4. **Dependencies as a detail route.** Parent and child tasks are fetched via a
   dedicated `/api/boards/[slug]/tasks/[id]/dependencies` route. The aggregate
   endpoint may also include a minimal summary of them.
5. **Handoff derived from events.** The dispatcher records a `worktree_handed_off`
   event with `{ branch, worktree_path }`. The detail route reads the latest such
   event for the task; no new table or column is added.
6. **Log content is read server-side.** The route reads the file from
   `getTaskLogPath(boardSlug, taskId)` and returns plain text. When the log is
   missing, the response explicitly says `{ present: false }` so the UI can show
   "No log captured yet."
7. **Feature flag gates the whole panel.** When `FF_SVELTEKIT_FRONTEND=false`,
   the server routes return `503 { enabled: false }` just like the KDI-UI-001
   bridge.

-------------------------------------------------------------------------------
Resource Map
-------------------------------------------------------------------------------
Routes live under `apps/web/src/routes/api/` and mirror the KDI-UI-001 bridge
conventions. Each row lists the model function or file-system call and the JSON
shape it returns. All response keys are camelCase.

### Aggregate detail snapshot

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/detail` | GET | `showTask`, `getChildTasks`, `listAttachments`, `getComments`, `getEvents`, `getRuns`, `buildTaskContext`, event scan for `worktree_handed_off`, `getTaskLogPath` | `TaskDetail` (see shape below) |

### Specialized read routes

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/log` | GET | `readFileSync(getTaskLogPath(...))` | `{ present: true, content: string, path: string }` or `{ present: false }` |
| `/api/boards/[slug]/tasks/[id]/log?tail=<bytes>` | GET | `readFileSync(...)` + tail slice | `{ present: true, content: string, path: string }` |
| `/api/boards/[slug]/tasks/[id]/dependencies` | GET | `loadParentResults` helper from `buildTaskContext` + `getChildTasks` | `{ parents: TaskSummary[], children: TaskSummary[] }` |
| `/api/boards/[slug]/tasks/[id]/handoff` | GET | latest `worktree_handed_off` event for task | `{ present: false }` or `{ present: true, branch: string, worktreePath: string, eventAt: number }` |

### TaskDetail shape

```typescript
interface TaskDetail {
  task: Task;                 // camelCase version of src/models/task.ts Task
  parents: TaskSummary[];    // done parents from context (limited to 10)
  children: TaskSummary[];   // non-archived child tasks
  handoff: { branch: string; worktreePath: string; eventAt: number } | null;
  log: { present: boolean; path: string };
  runs: TaskRun[];            // newest first
  events: TaskEvent[];        // newest first, capped (e.g. 50)
  comments: Comment[];
  attachments: TaskAttachment[];
  context: TaskContext;       // camelCase version of buildTaskContext result
}
```

`TaskSummary` is the same shape used by KDI-UI-001 for list views: `id`,
`title`, `status`, `assignee`, `priority`, `tenant`, `updatedAt`, `archivedAt`.

`TaskRun`, `TaskEvent`, `Comment`, `TaskAttachment`, and `TaskContext` are the
camelCase normalizations of the corresponding model interfaces.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- **FR-01:** A task detail page exists at `/tasks/[id]` (with `?board=<slug>`
  fallback for the active board). The page receives the aggregate detail shape
  from a server `load` function or the aggregate route.
- **FR-02:** The detail page is reachable from the board view (KDI-UI-003) by
  clicking a task card, and the browser URL updates to `/tasks/[id]`.
- **FR-03:** The panel displays a header with: title, status badge, priority,
  assignee, tenant, created by, and age (`created_at`).
- **FR-04:** The panel displays status reasons and timestamps when present:
  `block_reason`, `schedule_reason`, `review_reason`, `scheduled_at`, and
  `rate_limited_until`.
- **FR-05:** The panel displays the task body in a scrollable/readable area.
- **FR-06:** The panel displays metadata fields: `workspace_kind`, `workspace`,
  `branch`, `max_runtime_seconds`, `max_retries`, `consecutive_failures`,
  `skills`, `model_override`, `session_id`, `workflow_template_id`,
  `current_step_key`, `claim_lock`, `claim_expires`, `last_heartbeat_at`, and
  goal-mode fields (`goal_max_turns`, `goal_remaining_turns`,
  `goal_judge_profile`). Empty/null fields are omitted to reduce noise.
- **FR-07:** The panel displays `result` and `summary` in their own sections,
  rendered as plain text.
- **FR-08:** The panel displays a comments section with author, timestamp, and
  text. When `FF_COMMENT_ENHANCEMENTS` is off the author falls back to `"user"`.
- **FR-09:** The panel displays an attachments section with filename, size,
  content type, uploader, and uploaded-at timestamp. When `FF_TASK_ATTACHMENTS`
  is off the section is hidden or shows a "not enabled" message.
- **FR-10:** The panel displays a dependencies section with parent tasks and
  child tasks as links to their own detail pages. Blocked-by-dependency state is
  indicated visually.
- **FR-11:** The panel displays a context section using the bounded context
  from `buildTaskContext`. The section is omitted when `FF_CONTEXT_BUILDER` is
  off.
- **FR-12:** The panel displays a runs section with all runs newest first.
  Each run shows: id, profile, status, outcome, step key, started/ended times,
  worker PID, spawned time, summary, and error. When `FF_SHOW_RUN_FILTERING`
  is on, the UI offers a status/outcome filter that calls `getRunsFiltered`.
- **FR-13:** The panel displays an events section with newest events first,
  showing kind, payload preview, run id, and timestamp. It supports two modes:
  **follow** (poll every 2 seconds for new events) and **non-follow** (fetch
  once and stop). The section offers a pause/resume toggle that switches between
  the two modes. Non-follow mode is equivalent to `kdi tail --no-follow`; a
  `?lines=N` cap on the aggregate or events route is optional.
- **FR-14:** The panel displays a worker log section. If the log file is absent
  it shows "No log captured yet." If present it supports **non-follow** (fetch
  the full log or last N bytes once) and **follow** (poll `?tail=<bytes>` every
  2s) modes, with a manual refresh button and a bytes input for tail size.
  Non-follow mode is equivalent to `kdi log --tail <bytes>`.
- **FR-15:** The panel displays a worktree handoff section when a
  `worktree_handed_off` event exists, showing the preserved branch and worktree
  path.
- **FR-16:** Server routes return camelCase JSON and return `503 { enabled: false }`
  when `FF_SVELTEKIT_FRONTEND=false`.
- **FR-17:** All sections handle empty/null states gracefully with clear
  messages: "No comments yet", "No attachments", "No runs recorded", etc.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- The aggregate detail endpoint returns in under 100ms for a task with 50
  events, 20 runs, and 10 attachments on a local board.
- Poll intervals for events and log tail are 2 seconds and do not fetch the full
  aggregate.
- No new runtime dependencies beyond the SvelteKit stack and existing KDI models.
- The detail page uses SvelteKit server-side rendering for the initial load; the
  browser receives rendered HTML, not a client-only spinner.
- `bun run check:web` (svelte-check) and `bun run build:web` pass with no new
  type errors.
- The detail panel is keyboard navigable: focusable headings, tabs/sections,
  and links between parent/child tasks.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Task id does not exist | `404 { error: "task_not_found" }` |
| Task is archived | `404 { error: "task_not_found" }` (archived tasks excluded from detail view) |
| Board slug does not exist | `404 { error: "board_not_found" }` |
| Task id belongs to a different board | `404 { error: "task_not_found" }` |
| Worker log file is missing | `{ present: false }`; UI shows "No log captured yet." |
| Worker log file is larger than 10MB | Route returns up to `tail` bytes or a capped full view (e.g. first 500KB); UI shows a truncation notice. |
| No `worktree_handed_off` event | Handoff section is hidden. |
| `FF_CONTEXT_BUILDER=false` | Context section is hidden. |
| `FF_TASK_ATTACHMENTS=false` | Attachments section is hidden or disabled. |
| `FF_SHOW_RUN_FILTERING=false` | Run filter controls are hidden. |
| `FF_WORKER_LOG_CAPTURE=false` | Log section is hidden or disabled. |
| Context builder throws (e.g. missing table) | Aggregate endpoint returns `context: null` with `contextError: "not_available"`; other sections still render. |
| Events exceed 50 | Aggregate returns newest 50; UI can poll `/events?since=<id>` for more. |

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
Gated by the same `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` flag
(registered in `specs/feature-flags.md`, default `false`). Browser detection of
enabled state uses `VITE_FF_SVELTEKIT_FRONTEND` once client code exists.

Sub-sections also respect their existing backend feature flags when deciding
what to render:
- `FF_CONTEXT_BUILDER` — context section.
- `FF_TASK_ATTACHMENTS` — attachments section.
- `FF_SHOW_RUN_FILTERING` — run filter controls.
- `FF_WORKER_LOG_CAPTURE` — worker log section.
- `FF_COMMENT_ENHANCEMENTS` — comment author display.
- `FF_GOAL_MODE` — goal mode metadata fields.
- `FF_WORKFLOW_TEMPLATES` — workflow template/step fields.
- `FF_HEARTBEAT` — heartbeat/claim metadata fields.
- `FF_MAX_RUNTIME`, `FF_MAX_RETRIES`, `FF_RATE_LIMIT_EXIT_CODE`, etc. — their
  corresponding metadata fields.

No new feature flag is introduced by this BRD.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] AC-01: A `/tasks/[id]` page exists and renders the task detail panel.
- [x] AC-02: The board view (KDI-UI-003) links each task card to its detail page.
- [x] AC-03: `GET /api/boards/[slug]/tasks/[id]/detail` returns a `TaskDetail`
      JSON shape covering the data exposed by `kdi show`, `kdi runs`, `kdi tail`,
      `kdi log`, `kdi context`, and `kdi attach`: task, parents, children, handoff,
      log presence, runs, events, comments, attachments, and context.
- [x] AC-04: The detail panel displays the task header (title, status, priority,
      assignee, tenant, created by, age) without page errors.
- [x] AC-05: The detail panel displays the body, result, and summary sections.
- [x] AC-06: The detail panel displays metadata fields conditionally based on
      their existing backend feature flags.
- [x] AC-07: The detail panel displays comments with author and timestamp.
- [x] AC-08: The detail panel displays attachments with filename, size, content
      type, uploader, and timestamp when the feature is enabled.
- [x] AC-09: The detail panel displays parent and child task links.
- [x] AC-10: The detail panel displays the bounded context when `FF_CONTEXT_BUILDER` is on.
- [x] AC-11: The detail panel displays the runs section and supports run
      filtering by status/outcome when `FF_SHOW_RUN_FILTERING` is on.
- [x] AC-12: The detail panel displays events with follow and non-follow modes
      and a pause/resume toggle.
- [x] AC-13: The detail panel displays the worker log section, supports follow
      and non-follow tail modes, and refreshes manually.
- [x] AC-14: The detail panel displays the worktree handoff section when a
      handoff event exists.
- [x] AC-15: Missing or empty sections show clear empty-state messages instead
      of blank areas.
- [x] AC-16: When `FF_SVELTEKIT_FRONTEND=false`, the routes return `503` and
      the UI shows the disabled screen (already implemented by KDI-UI-000).
- [x] AC-17: A smoke test with temp `HOME` and temp `KDI_DB` creates a task via
      the CLI, opens the detail page, and asserts the panel displays the title,
      status, and body.
- [x] AC-18: `bun run lint`, `bun run build` (CLI), `bun run check:web`, and
      `bun run build:web` all pass with an isolated `KDI_DB`.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Implementation should prove:
- Smoke test uses temp `HOME` + temp `KDI_DB` (same pattern as
  `kdi-new-feature-loop` and `AGENTS.md` worktree isolation). Create a board and
  task via the CLI, then visit the SvelteKit detail page and assert the title,
  status, and body are rendered.
- Run the Playwright or manual smoke test against the same DB to confirm the
  UI reads the same data the CLI wrote.
- Verify that no client module imports `~/models/*` or `bun:sqlite` by running
  `bun run build:web` and grepping `apps/web/.svelte-kit/output` or equivalent.
- Run `bun run lint`, `bun run build`, `bun run check:web`, and `bun run build:web`
  in the smoke environment.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk: large logs or bodies slow down the page.** The aggregate endpoint caps
  the log view to presence only and returns a bounded event count. The UI fetches
  full log content via the dedicated `/log` route only when requested. **Mitigation:**
  keep the aggregate payload small and defer heavy content to specialized routes.
- **Risk: feature-flag coupling.** The detail panel must hide sections that depend
  on backend flags. A section that ignores a flag will crash when the underlying
  table/column is missing on older databases. **Mitigation:** check the flag server-side
  before querying the optional model, and return empty/null for disabled sections.
- **Open question:** Should the detail panel open as a full page or a side drawer?
  This BRD recommends a full page at `/tasks/[id]` because it is simpler and
  bookmarkable. The implementer may choose a slide-over if the design demands it,
  but the URL must still reflect the selected task.
- **Open question:** Should the aggregate endpoint include the bounded context or
  fetch it separately? This BRD includes it in the aggregate for initial load
  simplicity, but the implementer may split it if `buildTaskContext` becomes slow.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration. The panel uses existing schema, models, and event stream.
- No change to `src/db.ts`. `getDb()` resolution from `KDI_DB`/`KDI_DB_PATH` is
  inherited from the server process.

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-005: Task Detail Panel — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-005-task-detail-panel.md`
- [ ] Task detail page at `/tasks/[id]` renders body, metadata, result, summary,
      comments, attachments, dependencies, context, runs, events, worker log,
      and worktree handoff
- [ ] Aggregate endpoint `GET /api/boards/[slug]/tasks/[id]/detail` returns full
      snapshot; specialized routes for log, dependencies, and handoff
- [ ] Polling for events and log tail; run filtering when `FF_SHOW_RUN_FILTERING` is on
- [ ] Smoke test with temp HOME/KDI_DB opens a CLI-created task and asserts the
      panel renders title, status, and body
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
```

-------------------------------------------------------------------------------
Spec Location
-------------------------------------------------------------------------------
`specs/sveltekit-ui/KDI-UI-005-task-detail-panel.md`

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-ui-005-task-detail-panel`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD is non-editing and runs in the shared checkout.)
