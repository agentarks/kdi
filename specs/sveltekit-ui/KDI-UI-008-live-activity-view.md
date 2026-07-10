# BRD-KDI-UI-008: Live Activity View

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give the SvelteKit operator UI a single screen that shows what the board is doing
right now: a board-wide event stream with the same filters as `kdi watch`, plus
a quick way to inspect per-task events and worker logs without leaving the page.
The view is polling-based, pausable, and manual-refreshable, and it does not need
a WebSocket or SSE server.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
Operators today use `kdi watch` to see board-wide activity and `kdi tail` /
`kdi log` to drill into a single task. These are three separate CLI commands with
different flags and output formats. There is no UI screen that combines a live
activity feed with per-task event/log inspection, so operators keep switching
between terminals to understand current board state.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Board activity | `kdi watch` in terminal | `/activity` page with live stream |
| Activity filters | `--assignee`, `--tenant`, `--kinds`, `--interval` flags | Same controls in the UI |
| Per-task events | `kdi tail <id>` | Task row in the activity stream expands to its event tail |
| Worker log | `kdi log <id> --tail <bytes>` | Same task row shows log tail/follow |
| Pause/resume | `Ctrl-C` | In-page pause/resume toggle |
| Real-time transport | N/A | Polling only; no WebSocket server |

-------------------------------------------------------------------------------
Scope
-------------------------------------------------------------------------------
In scope:
- A `/activity` page in `apps/web/` that renders a board-wide live event stream.
- Filter controls: assignee, tenant, event kinds, and poll interval.
- A per-task event/log panel inside the activity view for a selected task.
- Pause/resume and manual refresh controls.
- Server routes that wrap existing `src/models/taskEvent.ts` helpers and the
  worker-log route from KDI-UI-005.

Out of scope (owned by other backlog items):
- KDI-UI-003: the kanban board view (the activity page links to it).
- KDI-UI-005: the full task detail panel (the activity view reuses its log and
  per-task events routes, but does not replace the detail page).
- KDI-UI-006: lifecycle actions on events (e.g. clicking "claim" from an event).
- KDI-UI-007: dispatch control center (spawning runs is separate from viewing
  events).
- KDI-UI-009: stats and diagnostics screens.
- Real-time push via WebSocket/SSE.
- Multi-user auth or permissions.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- KDI-UI-000 (SvelteKit app shell) must exist and `FF_SVELTEKIT_FRONTEND` must
  be wired in `apps/web/src/hooks.server.ts`.
- KDI-UI-001 (server-side data bridge) must expose the board-level event route
  `/api/boards/[slug]/events` and per-task event route
  `/api/boards/[slug]/tasks/[id]/events`.
- KDI-UI-005 (task detail panel) must expose the worker-log route
  `/api/boards/[slug]/tasks/[id]/log`.
- Model functions: `getRecentEvents`, `getEventsAfter`, `getEvents`,
  `tailEvents`, `getRecentTaskEvents`, `getTaskLogPath`, `showTask`, `getBoardById`.
- Feature flags: `ff_sveltekit_frontend`, `ff_watch_filters`, `ff_tail_no_follow`,
  `ff_worker_log_capture` (all already registered in `specs/feature-flags.md`).

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Mutating task state from the activity view (actions belong to KDI-UI-006).
- A full task detail panel inside the activity page (links to KDI-UI-005).
- A separate service or proxy.
- WebSocket/SSE real-time updates.
- Auth, sessions, or multi-tenant permissions.
- Inline syntax highlighting or rich log parsing (plain text is enough).

-------------------------------------------------------------------------------
Architecture Decisions
-------------------------------------------------------------------------------
1. **One activity page, two panes.** The left/main pane shows the board-wide
   stream; the right/lower pane shows the selected task's events and log. This
   keeps the UI compact and avoids duplicating the full KDI-UI-005 detail page.
2. **Poll-first, no SSE.** The activity view polls board events every 2 seconds
   by default. Polling is sufficient for v1; WebSocket/SSE is deferred until
   polling proves too slow or wasteful.
3. **Anchor on event id.** Poll requests use `?since=<last_event_id>` and call
   `getEventsAfter(since, filters)` so responses are small and monotonic.
4. **Reuse existing routes.** The per-task event and log endpoints are already
   owned by KDI-UI-001 and KDI-UI-005. KDI-UI-008 only adds the `/activity` page
   and the board-level query-string contract; it does not add new model queries.
5. **Filters match the CLI contract.** `?assignee=...`, `?tenant=...`, and
   `?kinds=...` map directly to the `WatchFilters` shape. The `?interval=...`
   query controls only the UI poll interval; it does not affect the server.
6. **Task selection is client-side state.** Clicking a task in the stream sets
   the selected task id; the per-task events and log panels fetch their own data.
   The URL may optionally reflect `?task=<id>` for shareability.
7. **Feature flags gate sub-features.** When `FF_WATCH_FILTERS=false`, the
   assignee/tenant/kind filters are hidden. When `FF_TAIL_NO_FOLLOW=false`, the
   per-task event panel still follows by default but cannot switch to a one-shot
   "lines/no-follow" mode. When `FF_WORKER_LOG_CAPTURE=false`, the log pane is
   hidden or disabled.

-------------------------------------------------------------------------------
Resource Map
-------------------------------------------------------------------------------
Routes live under `apps/web/src/routes/api/` and reuse KDI-UI-001 / KDI-UI-005
contracts. All response keys are camelCase.

### Board-level event stream

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/events?since=<id>&limit=50&assignee=...&tenant=...&kinds=...` | GET | `getRecentEvents(limit, filters)` or `getEventsAfter(since, filters)` | `{ events: TaskEvent[], since: number \| null, board: string }` |

`TaskEvent` is the camelCase normalization of `src/models/taskEvent.ts`:
`id`, `taskId`, `runId`, `kind`, `payload`, `createdAt`.

`payload` is the raw JSON string; the UI may parse it to render a preview.

### Per-task event tail (reused from KDI-UI-001)

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/events?since=<id>` | GET | `getEvents(taskId)` or `tailEvents(taskId, since)` | `{ events: TaskEvent[] }` |

### Worker log (reused from KDI-UI-005)

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/log?tail=<bytes>` | GET | `readFileSync(getTaskLogPath(...))` | `{ present: true, content: string, path: string }` or `{ present: false }` |

### Selected task header (optional, to populate the per-task pane)

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]` | GET | `showTask(id)` | `Task` (camelCase) or 404 |

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- **FR-01:** A `/activity` page exists in the SvelteKit UI. It is reachable from
  the left navigation and the board view (KDI-UI-003).
- **FR-02:** The page header shows the current board slug, a live/ paused
  indicator, and a manual refresh button.
- **FR-03:** The board-wide stream shows events newest-first, with each row
  displaying: task id (link), event kind, timestamp, and a payload preview
  capped to 120 characters.
- **FR-04:** The board-wide stream polls for new events when live. Default poll
  interval is 2 seconds. Polls use `?since=<last_event_id>` and prepend new
  events to the top of the list.
- **FR-05:** A pause/resume toggle stops and restarts polling. When paused, the
  manual refresh button still fetches the latest events.
- **FR-06:** Filter controls are available when `FF_WATCH_FILTERS=true`:
  - Assignee text input.
  - Tenant text input (also gated by `FF_TENANT_NAMESPACE`).
  - Event kinds multi-select/free-text (comma-separated kinds).
  - Poll interval input (seconds, min 0.5).
- **FR-07:** Applying filters resets the stream and re-fetches the most recent
  matching events. The URL query string reflects the active filters so the view
  is shareable/reloadable.
- **FR-08:** Clicking a task id in the stream selects that task and opens the
  per-task pane. The URL may update to `?task=<id>`.
- **FR-09:** The per-task pane shows:
  - Task header (title, status, assignee).
  - Event tail with follow/non-follow modes and a pause/resume toggle.
  - Worker log with follow/non-follow modes and a tail-bytes input when
    `FF_WORKER_LOG_CAPTURE=true`.
- **FR-10:** Per-task event follow mode polls `?since=<last_event_id>` every 2
  seconds and appends new events. Non-follow mode fetches once and stops;
  this requires `FF_TAIL_NO_FOLLOW=true`.
- **FR-11:** Worker log follow mode polls `?tail=<bytes>` every 2 seconds and
  shows the last N bytes. Non-follow mode fetches once. This requires
  `FF_WORKER_LOG_CAPTURE=true`.
- **FR-12:** When the selected task has no worker log, the log pane shows
  "No log captured yet." instead of an error.
- **FR-13:** Empty stream states render "No matching events" with a clear
  message when filters exclude everything or the board has no events.
- **FR-14:** Server routes return `503 { enabled: false }` when
  `FF_SVELTEKIT_FRONTEND=false`, consistent with KDI-UI-001 and KDI-UI-005.
- **FR-15:** All client-side polling stops when the page is hidden (e.g.
  `document.visibilityState`) to avoid background CPU/battery waste; it resumes
  on visibility return.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- The board-level event request returns in under 50ms on a local board with
  <10k events and simple filters.
- Poll interval is configurable down to 0.5 seconds; the UI prevents values
  below that to avoid tight-looping the server.
- The board-level stream is capped at 200 events client-side; older events are
  not retained in memory unless the user explicitly loads more.
- No new runtime dependencies beyond the SvelteKit stack and existing KDI models.
- The activity page server-renders the initial empty state and the board header;
  the stream data is fetched client-side after hydration.
- `bun run check:web` and `bun run build:web` pass with no new type errors.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Board slug does not exist | `404 { error: "board_not_found" }`; UI shows board not found |
| Task id in stream does not exist | The link is disabled or the per-task pane shows "Task not found" |
| Task belongs to a different board | `404 { error: "task_not_found" }` from the task route |
| No events on the board | Stream shows "No events yet" and remains empty after polls |
| Last event id becomes stale | The next poll returns any events with `id > since`; duplicates are impossible because ids are monotonic |
| Worker log file is missing | `{ present: false }`; UI shows "No log captured yet." |
| `FF_WATCH_FILTERS=false` | Assignee/tenant/kind/interval controls are hidden; the stream still polls unfiltered |
| `FF_TAIL_NO_FOLLOW=false` | Per-task events are follow-only; a non-follow mode button is hidden |
| `FF_WORKER_LOG_CAPTURE=false` | Log pane is hidden or shows a "not enabled" message |
| `FF_TENANT_NAMESPACE=false` | Tenant filter is hidden even if `FF_WATCH_FILTERS=true` |
| Page is backgrounded | Polling pauses; resumes when visible again |
| Poll interval is invalid | UI clamps to the minimum (0.5s) or disables the input; server ignores the parameter |
| Stream reaches 200 events | Older events are dropped from the client list; a "Load older" action is optional |

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
Gated by the same `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` flag
(registered in `specs/feature-flags.md`, default `false`). Browser detection of
enabled state uses `VITE_FF_SVELTEKIT_FRONTEND` once client code exists.

Sub-features also respect their existing backend flags:
- `FF_WATCH_FILTERS` — board-level assignee/tenant/kind/interval controls.
- `FF_TENANT_NAMESPACE` — tenant filter control (requires `FF_WATCH_FILTERS`).
- `FF_TAIL_NO_FOLLOW` — per-task event non-follow / lines modes.
- `FF_WORKER_LOG_CAPTURE` — worker log pane.

No new feature flag is introduced by this BRD.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] AC-01: A `/activity` page exists and renders the board header, live/paused
      indicator, and event stream area.
- [x] AC-02: The board view (KDI-UI-003) and left navigation link to the
      activity page.
- [x] AC-03: `GET /api/boards/[slug]/events` returns the most recent board events
      and supports `?since=<id>` incremental polling.
- [x] AC-04: When live, the board stream polls every 2 seconds and adds new
      events to the top without a full page reload.
- [x] AC-05: Pause stops polling; resume restarts it; manual refresh fetches
      once while paused.
- [x] AC-06: When `FF_WATCH_FILTERS=true`, the stream supports assignee, tenant,
      kind, and interval filters; the URL reflects the chosen filters.
- [x] AC-07: When `FF_WATCH_FILTERS=false`, the filter controls are hidden and
      the stream polls unfiltered.
- [x] AC-08: Clicking a task in the stream selects it and shows its per-task
      event tail and worker log in a secondary pane.
- [x] AC-09: The per-task event pane supports follow mode and, when
      `FF_TAIL_NO_FOLLOW=true`, non-follow mode.
- [x] AC-10: The worker log pane supports follow tail and non-follow tail with a
      bytes input when `FF_WORKER_LOG_CAPTURE=true`.
- [ ] AC-11: Missing log, empty event tail, and no-matching-events states show
      clear empty-state messages ("No matching events" when filters active).
- [x] AC-12: Polling pauses when the page is hidden and resumes when visible.
- [x] AC-13: When `FF_SVELTEKIT_FRONTEND=false`, the page shows the disabled
      screen and routes return `503 { enabled: false }`.
- [ ] AC-14: A smoke test with temp `HOME` and temp `KDI_DB` creates a task via
      the CLI (not HTTP bridge), generates events (create, promote), visits the
      activity page, and asserts the event stream renders task id and event kind.
- [ ] AC-15: `bun run lint`, `bun run build` (CLI), `bun run check:web`, and
      `bun run build:web` all pass with an isolated `KDI_DB`.
- [ ] AC-16: Server-side filter gating: `boardEventsJson` checks `FF_WATCH_FILTERS`
      before using assignee/kinds filters, and `FF_TENANT_NAMESPACE` before
      using tenant filter; returns `400 feature_disabled` when flag off.
- [ ] AC-17: Poll interval clamped to minimum 0.5s, never NaN, on client and
      server.
- [ ] AC-18: Distinct "No matching events" empty state when filters active and
      no events match; "No events yet" otherwise.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Implementation should prove:
- Smoke test uses temp `HOME` + temp `KDI_DB` (same pattern as
  `kdi-new-feature-loop` and `AGENTS.md` worktree isolation). Create a board
  and task via the CLI, run a dispatch or manually promote the task to generate
  events, then visit the activity page and assert the event stream renders the
  task id and event kind.
- Run the smoke test against the same DB to confirm the UI reads the same events
  the CLI wrote.
- Verify that no client module imports `~/models/*` or `bun:sqlite` by running
  `bun run build:web` and grepping `apps/web/.svelte-kit/output` or equivalent.
- Run `bun run lint`, `bun run build`, `bun run check:web`, and `bun run build:web`
  in the smoke environment.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk: high-frequency polling with large event counts.** Board-wide events
  can grow quickly on busy boards. **Mitigation:** the route honors `?limit=...`
  and uses `?since=<id>` so polls only return new events; the client caps the
  retained list at 200 events.
- **Risk: feature-flag coupling.** The tenant filter must check both
  `FF_WATCH_FILTERS` and `FF_TENANT_NAMESPACE`; ignoring the second flag will crash
  when the `tenant` column is absent on older DBs. **Mitigation:** server routes
  check flags before querying optional fields and return empty/null for disabled
  filters; the UI hides controls when either flag is off.
- **Open question:** Should the activity page be the default landing page for a
  board instead of the kanban view? This BRD recommends keeping the kanban view
  (`/`) as the default and linking `/activity` from the navigation. The
  implementer may choose `/activity` as the default if product design demands it.
- **Open question:** Should the per-task pane live inline or navigate to
  `/tasks/[id]`? Inline keeps the board context visible; navigation is simpler
  and reuses KDI-UI-005. This BRD recommends inline for the activity view, with a
  "Open full detail" link to `/tasks/[id]`.
- **Open question:** Should the board-wide stream also show a compact task title
  next to the task id? The implementer can add a title lookup once the route
  returns a `taskTitle` field, but this BRD keeps the first version minimal
  (task id + kind + timestamp) to avoid extra model joins.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration. The activity view uses existing schema and models.
- No change to `src/db.ts`. `getDb()` resolution from `KDI_DB`/`KDI_DB_PATH` is
  inherited from the server process.

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-008: Live Activity View — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-008-live-activity-view.md`
- [ ] `/activity` page renders a board-wide live event stream with pause/resume
      and manual refresh
- [ ] Filter controls for assignee, tenant, kinds, and poll interval when
      `FF_WATCH_FILTERS=true`
- [ ] Per-task event tail and worker log panel reusing KDI-UI-001/005 routes
- [ ] Smoke test with temp HOME/KDI_DB creates a task, generates events, and
      asserts the stream renders task id and event kind
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
```

-------------------------------------------------------------------------------
Spec Location
-------------------------------------------------------------------------------
`specs/sveltekit-ui/KDI-UI-008-live-activity-view.md`

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-ui-008-live-activity-view`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD is non-editing and runs in the shared checkout.)
