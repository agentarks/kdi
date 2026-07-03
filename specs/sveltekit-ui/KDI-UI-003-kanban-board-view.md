# Specification: KDI-UI-003 — Kanban Board View

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-003: Kanban board view`.
> Scope of this document: the **Kanban board view** slice — a browser-based,
> columnar view of the tasks on a board. This is a **spec-writing task**, not an
> implementation. Behavior contracts are validated against the live model source
> (`src/models/task.ts`, `src/models/board.ts`, `src/commands/tasks.ts`,
> `src/profiles.ts`, `specs/feature-flags.md`).

---

## 1. Business Goal

Give operators a browser-based Kanban view that mirrors the information density
of `kdi list` while matching the spatial layout of a physical board: tasks in
nine status columns, with per-column counts, assignee ownership, priority, tenant,
age, status reasons, and visual markers for stale and rate-limited work. The UI
must be able to reproduce any `kdi list` filtered/sorted view by adjusting the
same filters the CLI exposes, gated by the same feature flags.

## 2. Problem Statement

`kdi list` is the operator's primary view of a board, but it is a sequential
text stream. It is hard to see at a glance how much work is in each status, what
is blocked, what is stale, or which assignee is overloaded. There is no browser
UI for this yet. The SvelteKit UI backlog gates the Kanban view at P1
(KDI-UI-003), but its prerequisites are not built: the SvelteKit app shell
(KDI-UI-000), a server-side data bridge (KDI-UI-001), and a board management
screen (KDI-UI-002) must land first.

This document specifies the contract KDI-UI-003 must meet once the
prerequisites exist, so implementation can proceed without re-deriving the CLI
semantics and reviewers can verify that the UI reproduces `kdi list` behavior.

## 3. Prerequisites (Hard Blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web` exists, feature flags are
  wired, and the CLI + SvelteKit builds still pass with an isolated `KDI_DB`.
- **KDI-UI-001 — Server-side data bridge.** SvelteKit server routes can call
  existing KDI model code and return UI-shaped JSON. In particular, the
  following routes are assumed available and stable:
  - `GET /api/boards/[slug]` → `showBoard(slug, true)` returning
    `BoardWithTaskCounts` (all nine status buckets).
  - `GET /api/boards/[slug]/tasks` → `listTasks(filter, sort)` returning an
    array of task summaries.
  - `GET /api/boards/[slug]/assignees` → `getAssigneeCounts(boardId)`
    returning `{ assignees: Record<string, number> }`.
- **KDI-UI-002 — Board management UI.** The board detail route `/boards/[slug]`
  exists and provides a board header/shell (slug, name, metadata, current badge,
  archived tag, switch/delete affordances). The Kanban view is mounted inside
  that shell.

KDI-UI-003 adds the Kanban task grid, filter bar, and supporting components. To
render cards correctly it also extends the KDI-UI-001 bridge task list shape to
the richer `KanbanTask` and exposes a profile list endpoint for the assignee
dropdown. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`,
`src/flags.ts`, or `src/resolveBoard.ts`. If a required JSON shape is missing
from the bridge, the gap is raised against KDI-UI-001, not patched here.

## 4. Scope

In scope:
- The Kanban board view as the main content of the `/boards/[slug]` route.
- Nine status columns: `triage`, `todo`, `scheduled`, `ready`, `running`,
  `blocked`, `review`, `done`, `archived`.
- Per-column header counts and task cards showing: title, assignee, priority,
  tenant, age, status reasons (`block_reason`, `schedule_reason`,
  `review_reason`), and stale / rate-limited markers.
- A filter bar mapping to `kdi list` filters: status, assignee, tenant,
  created-by, mine, session, archived, workflow template, step key, sort.
- Server-side query-parameter wiring that calls `listTasks` with the same
  filter/sort values the CLI would use.
- Feature-flag gating consistent with the CLI: `FF_SVELTEKIT_FRONTEND` plus the
  per-feature flags reused from `kdi list`.

Out of scope (explicitly):
- Task create/edit (KDI-UI-004), task detail panel (KDI-UI-005), and task
  lifecycle actions (KDI-UI-006). The Kanban view may link to them but does not
  implement them.
- Drag-and-drop, swimlanes, WebSockets/SSE, and real-time collaboration
  (non-goals per backlog).
- Auth, multi-user permissions, and board-level ACL.
- Any new backend model/SQL, CLI command, or feature flag.

## 5. Current vs Desired Behavior

| Aspect | Current (`kdi list`) | Desired (UI) |
|---|---|---|
| Layout | Vertical text list | Nine-column Kanban board |
| Counts | Not shown inline | Per-column header counts |
| Assignee | Shown as `@profile` | Avatar chip / text on each card |
| Priority | Not shown in list | Visible badge/number on each card |
| Tenant | Not shown in list | Badge when present |
| Age | Not shown in list | Relative age (e.g. "2h", "1d") |
| Status reasons | Not shown in list | Icon/label for block/schedule/review reasons |
| Stale marker | Not shown | Highlight when stale |
| Rate-limited marker | Not shown | Highlight + countdown when `rate_limited_until` is in the future |
| Filters | CLI flags | Form controls in a filter bar |
| Sort | `--sort` flag | Sort select; tasks sorted within each column by chosen key |
| Archived | `--archived` flag | Toggle; archived tasks appear in the `archived` column only when on |

## 6. Functional Requirements

### 6.1 Board view layout

- **FR-1** The Kanban view renders as the main content of the `/boards/[slug]`
  route, inside the board shell provided by KDI-UI-002. A missing or archived
  board renders the same error/label as KDI-UI-002; the Kanban grid is not shown.
- **FR-2** The view renders exactly nine columns, in order:
  `triage`, `todo`, `scheduled`, `ready`, `running`, `blocked`, `review`,
  `done`, `archived`.
- **FR-3** Each column header displays the human-readable status name and the
  count of tasks currently in that status. The counts are derived from the board's
  `taskCounts` (all nine buckets) returned by `GET /api/boards/[slug]`.
- **FR-4** Tasks are placed in the column matching `task.status`. Tasks whose
  status is `archived` appear only when the archived toggle is enabled; when it
  is disabled, the archived column is empty and its header count is `0`.
- **FR-5** Within a column, tasks are sorted by the selected sort key. The sort
  keys and their SQL equivalents are identical to `VALID_SORT_KEYS` in
  `src/models/task.ts`: `assignee`, `created`, `created-desc`, `priority`,
  `priority-desc`, `status`, `title`, `updated`. The default sort is `created-desc`,
  matching the unqualified `kdi list` order.
- **FR-6** The board view is horizontally scrollable on narrow viewports; on
  wide viewports the columns share the available width evenly. No drag-and-drop
  is required for v1.

### 6.2 Task cards

- **FR-7** Each card renders at minimum: `id`, `title`, `assignee` (or
  "unassigned"), `priority`, `tenant` (when present), and age relative to
  `created_at`.
- **FR-8** The card shows a status reason when present and relevant to the
  status:
  - `blocked` → `block_reason`
  - `scheduled` → `schedule_reason` and scheduled time
  - `review` → `review_reason`
- **FR-9** The card shows a **stale** marker when any of the following holds:
  - The task is `running` and `last_heartbeat_at` is older than 60 minutes
    (matches the dispatcher reclaim threshold), gated by `FF_HEARTBEAT`.
  - The task's `updated_at` is older than 24 hours for any non-terminal status.
- **FR-10** The card shows a **rate-limited** marker and a countdown to
  `rate_limited_until` when that value is in the future, gated by
  `FF_RATE_LIMIT_EXIT_CODE`.
- **FR-11** The card is a link to the task detail panel (KDI-UI-005 route,
  e.g. `/boards/[slug]/tasks/[id]`) and does not implement lifecycle actions
  itself. The link remains usable even when KDI-UI-005 is not yet built.

### 6.3 Filter bar

- **FR-12** The filter bar exposes controls that map to `ListTasksFilter` and
  `sort`:
  - **Status** — single-select; values are the nine statuses plus an "All"
    option. Selecting `archived` automatically enables the archived toggle.
  - **Assignee** — select/dropdown populated with the union of known profiles
    (`loadProfiles`) and assignees present on the board (`getAssigneeCounts`).
  - **Tenant** — text input, trimmed.
  - **Created by** — text input, trimmed.
  - **Mine** — toggle that sets the assignee filter to the current profile.
  - **Session** — text input.
  - **Archived** — toggle that maps to `includeArchived`.
  - **Workflow template** — select of templates defined for the board.
  - **Step key** — select of steps belonging to the chosen template.
  - **Sort** — select of the eight valid sort keys; default `created-desc`.
- **FR-13** `--mine` and `--assignee` are mutually exclusive, matching the CLI:
  enabling `Mine` clears the assignee select; selecting an assignee clears `Mine`.
- **FR-14** The filter bar applies filters server-side by converting the form
  state to query parameters and reloading the page. The server load passes the
  query parameters to `listTasks(filter, sort)`.
- **FR-15** The current filter state is reflected in the URL so a filtered view
  is shareable and matches the equivalent `kdi list` invocation.
- **FR-16** The current profile for the **Mine** filter is resolved server-side
  with the same fallback chain as the CLI: `KDI_PROFILE` → `HERMES_PROFILE` →
  `"user"`. The resolved value is surfaced in the UI label (e.g. "Mine
  (user)").

### 6.4 Flag gating

- **FR-17** The entire Kanban view is gated by `FF_SVELTEKIT_FRONTEND`. When
  disabled, the `/boards/[slug]` route shows the same disabled state as the rest
  of the UI.
- **FR-18** The advanced filter controls are gated by the same flags that gate
  the equivalent CLI options:
  - `FF_LIST_FILTERS_SORT` — enables the `Mine`, `Session`, `Archived`, `Sort`,
    `Workflow template`, and `Step key` controls. When disabled, those controls
    are hidden.
  - `FF_TENANT_NAMESPACE` — enables the `Tenant` filter and tenant display on
    cards.
  - `FF_CREATED_BY` — enables the `Created by` filter and creator display on
    cards.
  - `FF_ASSIGNEES_LISTING` — enables the assignee dropdown and the assignee
    count data used to populate it.
  - `FF_WORKFLOW_TEMPLATES` — enables the `Workflow template` and `Step key`
    filters.
  - `FF_RATE_LIMIT_EXIT_CODE` — enables the rate-limited marker on cards.
  - `FF_HEARTBEAT` — enables heartbeat-based stale detection for running tasks.
- **FR-19** Server-side gating is defense in depth: the load function rejects
  query parameters for disabled filters with the same error text the CLI uses
  (e.g. `"List filters and sort feature is not enabled."`,
  `"Tenant namespace feature is not enabled."`). Client-side hiding is UX only.

## 7. UI Routes / Components

This slice consumes the following routes from prerequisites and adds the
components listed below. Because KDI-UI-002 had not landed when this slice was
implemented, a minimal board shell (header, archived tag, and meta) is included
here; once KDI-UI-002 merges, the shell should be replaced by the shared
`/boards/[slug]` route.

### Routes consumed from KDI-UI-002
- `/boards/[slug]` — the board detail route. KDI-UI-003 mounts the Kanban view
  as the main content of this route. The board header, metadata, archived tag,
  and current badge are reused unchanged.
- `readCurrentBoard()` resolution used by KDI-UI-002 is also used if the root
  `/` route is redirected to the current board's Kanban view.

### Routes consumed from KDI-UI-001 (server-side data bridge)
- `GET /api/boards/[slug]` → returns `BoardWithTaskCounts` (all nine status
  buckets). Used for column header counts.
- `GET /api/boards/[slug]/tasks?...` → returns `{ tasks: KanbanTask[] }`.
  Used for the card grid. Query parameters are the same filters used by
  `kdi list`.
- `GET /api/boards/[slug]/assignees` → returns
  `{ assignees: Record<string, number> }`. Used to populate the assignee filter.

### New components introduced by this slice
- `BoardKanbanView` — the page-level container rendered inside `/boards/[slug]`.
  Receives `board`, `tasks`, `filters`, `assignees`, `capabilities`, and
  `currentProfile` from the server load.
- `KanbanFilterBar` — the filter bar form. Renders only the controls enabled by
  the capability map and emits query-parameter navigation on change.
- `KanbanBoard` — the nine-column grid. Receives sorted tasks and distributes
  them into `KanbanColumn` components.
- `KanbanColumn` — a single status column with a header count and a list of
  `TaskCard` components.
- `TaskCard` — a single task card with all required fields and markers.
- `StaleBadge` / `RateLimitedBadge` — small presentational markers.

No new server route is required beyond the KDI-UI-001 bridge endpoints if they
already support the needed query parameters and task shape. If they do not, the
gap is raised against KDI-UI-001.

## 8. Data Contract

### Board shape (consumed from KDI-UI-001)

```ts
interface BoardWithTaskCounts {
  id: number;
  slug: string;
  name: string | null;
  workdir: string;
  base_ref: string;
  archived_at: number | null;
  taskCounts: {
    triage: number;
    todo: number;
    scheduled: number;
    ready: number;
    running: number;
    blocked: number;
    review: number;
    done: number;
    archived: number;
  };
}
```

### Kanban task shape (returned by the task list bridge endpoint)

The endpoint must return enough fields from `Task` for the card and marker logic.

```ts
interface KanbanTask {
  id: number;
  title: string;
  status: Task["status"]; // one of the nine statuses
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
```

If the KDI-UI-001 `TaskSummary` shape is smaller, the Kanban view requires the
endpoint to be extended or a dedicated Kanban task endpoint to be added; the
extension is a KDI-UI-001 concern, not a KDI-UI-003 concern.

### Filter / sort query parameters

| Query param | Maps to `ListTasksFilter` | CLI equivalent | Flag gate |
|---|---|---|---|
| `status` | `status` | `--status` | none (status is always available) |
| `assignee` | `assignee` | `--assignee` | `FF_ASSIGNEES_LISTING` for dropdown |
| `mine` | `assignee = currentProfile` | `--mine` | `FF_LIST_FILTERS_SORT` |
| `tenant` | `tenant` | `--tenant` | `FF_TENANT_NAMESPACE` |
| `createdBy` | `created_by` | `--created-by` | `FF_CREATED_BY` |
| `session` | `session_id` | `--session` | `FF_LIST_FILTERS_SORT` |
| `archived` | `includeArchived = true` | `--archived` | `FF_LIST_FILTERS_SORT` |
| `workflowTemplateId` | `workflow_template_id` | `--workflow-template-id` | `FF_WORKFLOW_TEMPLATES` |
| `stepKey` | `current_step_key` | `--step-key` | `FF_WORKFLOW_TEMPLATES` |
| `sort` | `sort` | `--sort` | `FF_LIST_FILTERS_SORT` |

If both `mine` and `assignee` are submitted, the bridge rejects the request
with the same error the CLI uses.

## 9. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser:
  `VITE_FF_SVELTEKIT_FRONTEND`), default `false`. Gates the entire UI and
  therefore the Kanban view. Inherited from KDI-UI-000; no new flag is added.
- Per-feature flags **reused from the CLI** (no new flags introduced):
  - `FF_LIST_FILTERS_SORT` — `Mine`, `Session`, `Archived`, `Sort`, `Workflow
    template`, `Step key` controls.
  - `FF_TENANT_NAMESPACE` — `Tenant` filter and tenant badge.
  - `FF_CREATED_BY` — `Created by` filter and creator display.
  - `FF_ASSIGNEES_LISTING` — assignee dropdown and assignee counts.
  - `FF_WORKFLOW_TEMPLATES` — workflow template and step key filters.
  - `FF_RATE_LIMIT_EXIT_CODE` — rate-limited marker.
  - `FF_HEARTBEAT` — heartbeat-based stale detection for running tasks.

## 10. Acceptance Criteria

- **AC-01 (columns)** The `/boards/[slug]` route renders nine columns in the
  fixed order: `triage`, `todo`, `scheduled`, `ready`, `running`, `blocked`,
  `review`, `done`, `archived`.
- **AC-02 (counts)** Each column header shows the count from the board's
  `taskCounts` for that status; the counts match the output of
  `showBoard(slug, true)` for the same board.
- **AC-03 (task placement)** Each task card appears in the column matching its
  `status`. Archived cards appear only when the `Archived` toggle is enabled.
- **AC-04 (card fields)** Every task card displays `id`, `title`, `assignee`,
  `priority`, `tenant` (when set), age relative to `created_at`, and status
  reasons when the task is `blocked`, `scheduled`, or `review`.
- **AC-05 (sort)** Selecting a sort key reorders tasks within each column using
  the same ordering as `resolveSortOrder` in `src/models/task.ts`. The default
  sort matches the default `kdi list` order (`created-desc`).
- **AC-06 (status filter)** Selecting a status filters the cards to that status
  and updates the URL; the server load calls `listTasks({ board_id, status })`.
- **AC-07 (assignee filter)** The assignee dropdown is populated from the union
  of `loadProfiles()` and `getAssigneeCounts(boardId)`. Selecting an assignee
  filters cards to tasks with that `assignee`.
- **AC-08 (mine filter)** Enabling `Mine` filters cards to tasks assigned to the
  current profile (resolved via `KDI_PROFILE` → `HERMES_PROFILE` → `"user"`).
  `Mine` and assignee are mutually exclusive.
- **AC-09 (tenant / created-by)** When their flags are enabled, the `Tenant`
  and `Created by` inputs filter by `tenant` and `created_by` respectively and
  display the values on matching cards.
- **AC-10 (session / archived)** When `FF_LIST_FILTERS_SORT` is enabled, the
  `Session` input filters by `session_id`, and the `Archived` toggle includes
  archived tasks.
- **AC-11 (workflow / step-key)** When `FF_WORKFLOW_TEMPLATES` is enabled, the
  workflow template and step key filters are visible and filter by the
  corresponding task columns.
- **AC-12 (stale / rate-limited markers)** Cards show a stale marker when the
  task is old or a running task's heartbeat is stale; cards show a rate-limited
  marker when `rate_limited_until` is in the future (when the relevant flags are
  on).
- **AC-13 (CLI parity)** A smoke test using temp `HOME` and temp `KDI_DB` can
  create tasks through the CLI (or KDI-UI-001 bridge), open the Kanban view with
  query parameters, and assert that the rendered task IDs match the IDs
  returned by `kdi list` with the equivalent flags against the same DB.
- **AC-14 (flag gating)** With `FF_SVELTEKIT_FRONTEND=false`, the Kanban view is
  unavailable. With `FF_LIST_FILTERS_SORT=false`, the advanced filter controls
  are absent. With `FF_TENANT_NAMESPACE=false`, the tenant filter and badge are
  absent. Server-side load rejects disabled filters with the same error text the
  CLI uses.
- **AC-15 (no backend churn)** No file under `src/models`, `src/commands`,
  `src/db.ts`, `src/flags.ts`, or `src/resolveBoard.ts` is modified by this
  slice; SvelteKit components, a `/boards/[slug]` page-load wrapper, and the
  minimal bridge extensions required for the Kanban task shape and profile list
  are added in `apps/web/src/lib/server/bridge.ts`.
- **AC-16 (build)** `bun run lint`, CLI `bun run build`, and the SvelteKit build
  pass with an isolated `KDI_DB`.

## 11. Risks / Open Questions

- **Risk: Task list endpoint shape.** KDI-UI-001 currently defines a minimal
  `TaskSummary`. The Kanban view needs richer fields (reasons, timestamps,
  workflow/session fields). This PR extends the bridge task list endpoint to
  return `KanbanTask` and adds a profile list endpoint for the assignee dropdown.
  No CLI model, command, or flag is modified.
- **Risk: Large boards.** Rendering hundreds of cards per column could be slow
  in the browser. **Mitigation:** v1 renders all tasks returned by the bridge;
  virtualization or pagination is a follow-up if profiling shows it is needed.
- **Risk: Current profile resolution for `Mine`.** The browser has no direct
  access to `KDI_PROFILE`. The server load resolves it from the process
  environment, which may not match the operator's intent. **Mitigation:** the UI
  labels the resolved value and the assignee dropdown allows manual selection;
  a future slice may add a user preference for the operator profile.
- **Risk: Stale threshold subjectivity.** The 24-hour / 60-minute thresholds are
  reasonable defaults but may need tuning. **Mitigation:** thresholds are
  documented in the spec; making them configurable is a follow-up if requested.
- **Open question:** Should the root `/` route redirect to the current board's
  Kanban view? This is desirable but not strictly required for KDI-UI-003; it can
  be handled by KDI-UI-002 or a small follow-up.
- **Open question:** Should the `archived` column be hidden entirely when the
  archived toggle is off, or shown as an empty column? This spec shows it as an
  empty column so the status set is always complete; the implementer may choose
  to hide it if the backlog's v1 preference differs.

## 12. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog - Drafted area:

```markdown
## KDI-UI-003: Kanban Board View — Spec
- [ ] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-003-kanban-board-view.md`
- [ ] Kanban board view renders nine status columns with counts, assignee,
      priority, tenant, age, status reasons, and stale/rate-limited markers
- [ ] Filter bar reproduces `kdi list` filters: status, assignee, tenant,
      created-by, mine, session, archived, workflow template, step key, sort
- [ ] Consumes board shell from KDI-UI-002 and data bridge endpoints from
      KDI-UI-001 (`/api/boards/[slug]`, `/api/boards/[slug]/tasks`,
      `/api/boards/[slug]/assignees`)
- [ ] Gated by `FF_SVELTEKIT_FRONTEND`; reuses CLI flags
      `FF_LIST_FILTERS_SORT`, `FF_TENANT_NAMESPACE`, `FF_CREATED_BY`,
      `FF_ASSIGNEES_LISTING`, `FF_WORKFLOW_TEMPLATES`, `FF_RATE_LIMIT_EXIT_CODE`,
      `FF_HEARTBEAT`
- [ ] Acceptance: UI reproduces `kdi list` filtered/sorted views against a temp
      `HOME`/`KDI_DB`; all builds pass
```

---

## Spec Location

`specs/sveltekit-ui/KDI-UI-003-kanban-board-view.md`

## Worktree Branch Name

`feat/kdi-ui-003-kanban-board-view`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD was non-editing and ran in the shared checkout.)
