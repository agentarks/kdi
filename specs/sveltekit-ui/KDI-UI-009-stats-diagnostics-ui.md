# Specification: KDI-UI-009 — Stats and Diagnostics UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-009: Stats and diagnostics UI`.
> Scope of this document: the **full** KDI-UI-009 item — a browser operator UI
> for the board health and capacity data that `kdi stats` and `kdi diagnostics`
> already expose on the CLI. This is a **spec-writing task**, not an
> implementation. All behavior contracts are validated against the live
> CLI/model source (`src/commands/stats.ts`, `src/commands/diagnostics.ts`,
> `src/models/board.ts`, `src/models/diagnostic.ts`, `src/flags.ts`,
> `specs/feature-flags.md`).

---

## 1. Business Goal

Give operators a browser-based health and capacity dashboard that surfaces the
same data as `kdi stats` and `kdi diagnostics`: per-status counts, per-assignee
load, oldest-ready age, and actionable diagnostic findings. The UI must not
introduce behavior the CLI does not already support, must gate each section
behind its existing CLI feature flag, and must provide direct shortcuts for
diagnostic actions (reclaim, reassign, unblock, comment, CLI hint, open docs).

## 2. Problem Statement

`kdi stats` and `kdi diagnostics` are feature-complete on the CLI, but the
SvelteKit UI has no screen for board health or capacity. Operators must run
two separate commands and mentally join the output to decide which tasks need
attention. There is no single UI that shows "how loaded is this board?" and
"what is broken right now?" side by side.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web/` SvelteKit app scaffolded;
  `FF_SVELTEKIT_FRONTEND` registered in `src/flags.ts` (InDev, default `false`)
  and `VITE_FF_SVELTEKIT_FRONTEND` available to the browser; AGENTS.md amended
  to permit `apps/web/`; CLI `bun run build` and SvelteKit build/dev work with
  isolated `KDI_DB`.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions
  can call existing KDI model code (`src/models/*`) and return UI-shaped JSON.
  One smoke test can create a temp board/task through the bridge and read it
  back. KDI-UI-009 consumes the bridge for stats and diagnostics reads.
- **KDI-UI-003 — Kanban board view (optional but recommended).** The dashboard
  links to individual tasks and to the board view; it can function with direct
  `/tasks/[id]` links while KDI-UI-003 is pending.

KDI-UI-009 adds **only** SvelteKit routes/components and the narrow server
loaders its screens need. It must not modify `src/models/*`, `src/commands/*`,
`src/db.ts`, or `src/flags.ts` beyond imports. If a needed JSON shape is missing,
the gap is raised against KDI-UI-001, not patched here.

## 4. Decision Options

1. **Prerequisites first; KDI-UI-009 as a pair of consuming screens.** Build the
   shell and bridge first, then add stats and diagnostics views strictly on top
   of `getBoardStats` and `runDiagnostics`. **Chosen.** Cleanest dependency graph;
   every metric and finding maps to one existing model call; no slice bundles the
   shell.
2. **Bundle health actions into the dashboard.** Add inline buttons that call
   `reclaimTask`, `reassignTask`, `unblockTask`, and `addComment` directly. This
   conflates KDI-UI-009 with KDI-UI-006 and violates the slice boundary.
   Rejected.
3. **Stats-only or diagnostics-only dashboard.** Ship one half and defer the
   other. Smaller, but fails the parent acceptance (which requires both stats and
   diagnostics). Rejected.

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| Board capacity | `kdi stats --board <slug>` prints status counts, assignee counts, oldest ready age | `/stats` page with the same three sections and a bar chart or table |
| Health checks | `kdi diagnostics --board <slug>` prints findings with severity, rule, message, actions | `/diagnostics` page listing findings with filters and action shortcuts |
| Severity filter | `--severity {warning,error,critical}` | Severity multi-select or dropdown |
| Per-task diagnostics | `--task <id>` restricts findings | Clicking a task in a finding opens its detail page (KDI-UI-005) |
| Diagnostic actions | Printed as text (`reclaim`, `reassign`, `unblock`, `cli_hint`, `open_docs`, `comment`) | Rendered as clickable action shortcuts that call the equivalent CLI model functions |
| JSON export | `--json` flag | Optional "Copy JSON" / "Download JSON" buttons for both pages |

## 6. Functional Requirements

### 6.1 Stats page (`/stats`)

- **FR-1** A read-only `/stats` route provides a `+page.server.ts` load function
  that reads `?board=<slug>` from the URL, resolves the board via `showBoard(slug,
  false)`, and returns `{ board, stats, flags }` as UI-shaped JSON. If `?board`
  is omitted, the loader falls back to `readCurrentBoard()` → `"default"`. A
  missing or archived board renders an inline `Board "..." not found.` error.
- **FR-2** The load function calls `getBoardStats(slug)` only when `FF_STATS` is
  enabled. When `FF_STATS=false`, the page renders a "Stats feature is not enabled"
  message and returns an empty payload.
- **FR-3** The page header shows the board `name` (fallback to `slug`) and the
  current timestamp of the snapshot.
- **FR-4** A **status counts** section renders the 9 status buckets: `triage`,
  `todo`, `scheduled`, `ready`, `running`, `done`, `blocked`, `review`, `archived`.
  Each bucket shows the count and is clickable as a link to the board view
  (KDI-UI-003) with `?status=<status>` pre-selected. Zero counts are shown
  explicitly as `0`.
- **FR-5** An **assignee counts** section renders the `assignee_counts` map. Each
  row shows the profile name and the number of non-archived `ready` or `running`
  tasks assigned to it. Empty assignee counts render "No assigned ready/running
  tasks" instead of a blank table. Each row links to the board view with
  `?assignee=<profile>`.
- **FR-6** An **oldest ready age** section renders `oldest_ready_age_seconds` as
  a human-readable duration (e.g. "3h 12m"). When the value is `null`, it shows
  "No ready tasks".
- **FR-7** A **refresh** button re-runs the server loader and updates the stats.
  Auto-refresh is optional; if implemented, it polls at 10-second intervals and
  stops when the page is hidden.
- **FR-8** A **JSON export** button returns the raw `getBoardStats` JSON shape
  in a new tab or download, matching `kdi stats --json`.

### 6.2 Diagnostics page (`/diagnostics`)

- **FR-9** A read-only `/diagnostics` route provides a `+page.server.ts` load
  function that reads `?board=<slug>` and `?severity=<level>` from the URL,
  resolves the board, and returns `{ board, findings, flags }`. Board resolution
  matches the stats page (`?board` → `readCurrentBoard()` → `"default"`). A
  missing or archived board renders an inline error.
- **FR-10** The load function calls `runDiagnostics(slug, { severity })` only
  when `FF_DIAGNOSTICS` is enabled. When `FF_DIAGNOSTICS=false`, the page renders
  a "Diagnostics feature is not enabled" message.
- **FR-11** The page header shows the board `name` (fallback to `slug`), the total
  finding count, and the number of findings at each severity level (warning,
  error, critical).
- **FR-12** A **severity filter** allows the operator to choose one of `warning`,
  `error`, or `critical`, or `all`. The URL reflects the active filter with
  `?severity=<level>`. The server passes the chosen severity to `runDiagnostics`
  as the `severity` minimum. Invalid severity values are rejected with the same
  message as the CLI: `Invalid severity "...". Valid: warning, error, critical`.
- **FR-13** Findings are rendered as a sorted list: severity descending (critical
  first), then task id ascending, then rule name ascending. Each row shows:
  - Severity badge (color-coded).
  - Rule name (e.g. `stranded_in_ready`).
  - Task id (link to `/tasks/[id]`).
  - Message text.
  - Actions list (`reclaim`, `reassign`, `unblock`, `comment`, `cli_hint`,
    `open_docs`).
- **FR-14** Diagnostic findings render **action shortcuts** for each listed action: `reclaim`, `reassign`, `unblock`, `comment`, `cli_hint`, and `open_docs`. Each shortcut triggers a server action that maps to the existing CLI/model path:
  - `reclaim` → `reclaimTask(taskId, reason)` (prompts for optional reason).
  - `reassign` → `reassignTask(taskId, profile, { reclaim: true, reason })` (prompts for profile and optional reason).
  - `unblock` → `unblockTask(taskId, reason)` (prompts for optional reason).
  - `comment` → `addComment({ task_id: taskId, text, author })` (prompts for text; author resolves from `KDI_PROFILE` → `HERMES_PROFILE` → `"user"`).
  - `cli_hint` → copies the equivalent CLI command to the clipboard.
  - `open_docs` → opens the relevant documentation URL (e.g. `specs/hermes-kanban-backlog.md` or a future help route).
  After a successful mutation, the page re-runs the diagnostics loader so the finding disappears or updates. Failed mutations render the model error inline without leaving the page.
- **FR-15** A **per-task filter** allows the operator to view findings for a single task. The URL reflects the task id with `?task=<id>` and the server passes the task id to `runDiagnostics(slug, { severity, taskId })`. The severity filter still composes with the task filter. If the task id is invalid, missing, or archived on the board, the server returns `404 { error: "task_not_found" }`. The diagnostics page renders a "Task findings" heading and a link back to the full board diagnostics. The page may provide a
  "Show only this task" link that navigates to `/diagnostics?task=<id>` if the
  KDI-UI-001 bridge supports it, but this is optional. The acceptance criterion is
  that the page displays the same findings as `kdi diagnostics --severity <level>`.
- **FR-16** Empty findings state renders "No diagnostic findings." when the board
  is healthy or when the severity filter excludes all findings.
- **FR-17** A **refresh** button re-runs the server loader. Auto-refresh is
  optional; if implemented, it polls at 10-second intervals and stops when the page
  is hidden.
- **FR-18** A **JSON export** button returns the raw `runDiagnostics` JSON array in
  a new tab or download, matching `kdi diagnostics --json`.

### 6.3 Navigation and cross-links

- **FR-19** The left navigation in the app shell links to `/stats` and
  `/diagnostics` when `FF_SVELTEKIT_FRONTEND=true`.
- **FR-20** The diagnostics page links to the stats page and vice versa.
- **FR-21** Task ids in both pages link to `/tasks/[id]` (KDI-UI-005). The link
  preserves the current board via `?board=<slug>`.
- **FR-22** The board view (KDI-UI-003) links to `/stats` and `/diagnostics` from
  its header or overflow menu.

### 6.4 Cross-cutting

- **FR-23** The whole UI renders only when `FF_SVELTEKIT_FRONTEND` is enabled
  (server-side gate via `hooks.server.ts`). The stats and diagnostics routes
  themselves do not add a new gate.
- **FR-24** KDI-UI-009 adds only SvelteKit components and the `/stats` and
  `/diagnostics` page loaders. It imports existing model functions:
  `getBoardStats`, `runDiagnostics`, `showBoard`, `readCurrentBoard`, and
  `isEnabled`/`FF_*` constants. It must not modify `src/models/*`,
  `src/commands/*`, `src/db.ts`, or `src/flags.ts`.

## 7. Scope

In scope:
- A `/stats` page in `apps/web/` that renders `getBoardStats` data.
- A `/diagnostics` page in `apps/web/` that renders `runDiagnostics` findings.
- Severity filter for diagnostics.
- JSON export for both pages.
- Navigation links from the app shell and board view.
- Action shortcuts for diagnostic findings (reclaim, reassign, unblock, comment, open docs/CLI hint).
- Per-task diagnostics filter (`?task=<id>`).

Out of scope (owned by other backlog items):
- KDI-UI-003: the Kanban board view (the dashboard links to it).
- KDI-UI-005: the task detail panel (task ids in findings link to it).
- KDI-UI-007: dispatch control center (spawning runs is separate from viewing
  health).
- Real-time push via WebSocket/SSE.
- Multi-user auth or permissions.
- Charts or visualizations beyond a simple table/bar.

## 8. Dependencies

- KDI-UI-000 (SvelteKit app shell) must exist and `FF_SVELTEKIT_FRONTEND` must
  be wired in `apps/web/src/hooks.server.ts`.
- KDI-UI-001 (server-side data bridge) must expose board-level read routes that
  can call `getBoardStats` and `runDiagnostics`.
- KDI-UI-003 (Kanban board view) is optional for navigation links but not for
  rendering the dashboard.
- KDI-UI-005 (task detail panel) is optional for task-id links but not for
  rendering the dashboard.
- Model functions: `getBoardStats`, `runDiagnostics`, `showBoard`,
  `readCurrentBoard`, `reclaimTask`, `reassignTask`, `unblockTask`, `addComment`.
- Feature flags: `ff_sveltekit_frontend`, `ff_stats`, `ff_diagnostics` (all
  already registered in `specs/feature-flags.md`).

## 9. Non-Goals

- Mutating task state outside the six diagnostic action shortcuts (reclaim, reassign, unblock, comment, cli_hint, open_docs). All other lifecycle actions belong to KDI-UI-006.
- A full task detail panel inside the stats page (links to KDI-UI-005).
- A separate service or proxy.
- WebSocket/SSE real-time updates.
- Auth, sessions, or multi-tenant permissions.
- Complex charts or historical trend graphs.
- Alerting or notification delivery.

## 10. Architecture Decisions

1. **Two sibling pages, one dashboard.** Stats and diagnostics are exposed as
   two separate routes (`/stats` and `/diagnostics`) that share the same board
   resolution loader. They can later be combined into a single dashboard if
   design demands it, but separate routes keep the v1 implementation simple and
   match the CLI command split.
2. **Action shortcuts are part of this item.** KDI-UI-009 exposes the six diagnostic actions (`reclaim`, `reassign`, `unblock`, `comment`, `cli_hint`, `open_docs`) directly from the findings list. This intentionally overlaps with KDI-UI-006's broader lifecycle-action scope, but only for these narrow, diagnostic-driven paths. The actions call the same model functions as the CLI; no new mutation logic is introduced.
3. **Server-side JSON shapes.** The pages consume `getBoardStats` and
   `runDiagnostics` directly through the KDI-UI-001 bridge. No new model wrapper is
   introduced unless the bridge requires one for camelCase normalization.
4. **URL-filtered views.** Both pages use query parameters for board and severity
   so the views are bookmarkable and shareable. The server loader re-runs on each
   navigation.
5. **No polling required.** Refresh is manual; auto-refresh is optional. The spec
   does not require live updates because stats and diagnostics are point-in-time
   snapshots, not streams.
6. **Preserve CLI parity.** The JSON export returns the exact CLI `--json` output
   so operators can verify UI numbers against the CLI without new API shapes.

## 11. Resource Map

Routes live under `apps/web/src/routes/api/` and mirror the KDI-UI-001 bridge
conventions. Each row lists the model function and the JSON shape it returns.
All response keys are camelCase.

### Stats snapshot

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/stats` | GET | `getBoardStats(slug)` | `{ board: string, statusCounts: Record<string, number>, assigneeCounts: Record<string, number>, oldestReadyAgeSeconds: number \| null }` |

### Diagnostics findings

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/diagnostics?severity=<level>&task=<id>` | GET | `runDiagnostics(slug, { severity, taskId })` | `{ findings: DiagnosticFinding[], board: string }` |

### Diagnostics actions

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/tasks/[id]/reclaim` | POST | `reclaimTask(id, reason)` | `{ success: true, task: Task }` or `{ error: string }` |
| `/api/boards/[slug]/tasks/[id]/reassign` | POST | `reassignTask(id, profile, { reclaim: true, reason })` | `{ success: true, task: Task }` or `{ error: string }` |
| `/api/boards/[slug]/tasks/[id]/unblock` | POST | `unblockTask(id, reason)` | `{ success: true, task: Task }` or `{ error: string }` |
| `/api/boards/[slug]/tasks/[id]/comment` | POST | `addComment({ task_id, text, author })` | `{ success: true, comment: Comment }` or `{ error: string }` |

`Task` and `Comment` are the camelCase normalizations of the corresponding model interfaces. The `open_docs` and `cli_hint` actions do not need server routes; they are client-side affordances (open URL, copy CLI command).

`DiagnosticFinding` is the camelCase normalization of
`src/models/diagnostic.ts`:
`rule`, `severity`, `taskId`, `message`, `actions`.

## 12. Non-Functional Requirements

- The stats endpoint returns in under 50ms for a board with 10k non-archived
  tasks on a local database.
- The diagnostics endpoint returns in under 100ms for a board with 1k
  non-archived tasks on a local database.
- No new runtime dependencies beyond the SvelteKit stack and existing KDI models.
- Both pages use SvelteKit server-side rendering for the initial load.
- `bun run check:web` and `bun run build:web` pass with no new type errors.
- Keyboard navigable: focusable headings, tables, and links.

## 13. Edge Cases

| Scenario | Expected behavior |
|---|---|
| Board slug does not exist | `404 { error: "board_not_found" }`; UI shows board not found |
| Board is archived | `404 { error: "board_not_found" }` from `showBoard(slug, false)`; UI shows board not found |
| `FF_STATS=false` | Stats page shows "Stats feature is not enabled"; no data fetched |
| `FF_DIAGNOSTICS=false` | Diagnostics page shows "Diagnostics feature is not enabled"; no data fetched |
| `FF_SVELTEKIT_FRONTEND=false` | Both routes return `503 { enabled: false }` via the existing hook |
| No tasks on the board | Status counts are all `0`, assignee counts empty, oldest ready age `null` |
| No ready tasks | Oldest ready age section shows "No ready tasks" |
| No diagnostic findings | Page shows "No diagnostic findings." |
| Invalid severity query | Server rejects with `Invalid severity "...". Valid: warning, error, critical`; UI renders inline error |
| Invalid task id | `404 { error: "task_not_found" }`; UI shows task not found on this board |
| Task id is archived | `404 { error: "task_not_found" }` from `runDiagnostics` validation |
| Board has no name | Header falls back to `slug` |
| Assignee is `null` | Excluded from `assignee_counts` (matches CLI) |
| Large finding list | Page renders all findings (no pagination for v1); filters help narrow |
| JSON export fails | Button falls back to showing the JSON in a `<pre>` block or inline error |
| Page is hidden | Optional auto-refresh pauses; resumes when visible again |

## 14. Feature Flag Requirements

Gated by the same `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` flag
(registered in `specs/feature-flags.md`, default `false`). Browser detection of
enabled state uses `VITE_FF_SVELTEKIT_FRONTEND` once client code exists.

Sub-sections also respect their existing backend flags when deciding what to
render:
- `FF_STATS` — enables the `/stats` page and data.
- `FF_DIAGNOSTICS` — enables the `/diagnostics` page and findings.

No new feature flag is introduced by this BRD.

## 15. Acceptance Criteria

- [ ] AC-01: A `/stats` page exists and renders the board header, status counts,
      assignee counts, and oldest ready age.
- [ ] AC-02: A `/diagnostics` page exists and renders diagnostic findings with
      severity, rule, task id, message, and actions.
- [ ] AC-03: The rendered `/stats` UI output matches `kdi stats --json` (status
      counts, assignee counts, oldest ready age).
- [ ] AC-04: The rendered `/diagnostics` UI output matches `kdi diagnostics --json`
      (rule, severity, task id, message, actions) for the selected severity and
      task filters.
- [ ] AC-05: The stats page links each status count to the board view with the
      matching `?status=<status>` filter.
- [ ] AC-06: The diagnostics page links each task id to the task detail page
      `/tasks/[id]`.
- [ ] AC-07: The diagnostics page supports a severity filter (`warning`, `error`,
      `critical`, `all`) via query string.
- [ ] AC-08: The diagnostics page supports a per-task filter (`?task=<id>`) that returns the same findings as `kdi diagnostics --task <id>`.
- [ ] AC-09: Diagnostic findings expose action shortcuts for `reclaim`, `reassign`,
      `unblock`, `comment`, `cli_hint`, and `open_docs`; the four mutation
      shortcuts call the same model functions as the CLI and refresh the page.
- [ ] AC-10: Both pages provide a JSON export that matches the CLI `--json` output.
- [ ] AC-11: When `FF_STATS=false`, the stats page shows a clear disabled message
      instead of an error.
- [ ] AC-12: When `FF_DIAGNOSTICS=false`, the diagnostics page shows a clear
      disabled message instead of an error.
- [ ] AC-13: When `FF_SVELTEKIT_FRONTEND=false`, both routes return `503` and the
      UI shows the disabled screen (already implemented by KDI-UI-000).
- [ ] AC-14: A smoke test with temp `HOME` and temp `KDI_DB` creates a board and
      tasks via the CLI, loads `/stats` and `/diagnostics`, and asserts the
      rendered numbers match `kdi stats --json` and `kdi diagnostics --json`.
- [ ] AC-15: `bun run lint`, CLI `bun run build`, `bun run check:web`, and
      `bun run build:web` all pass with an isolated `KDI_DB`.

## 16. Verification Notes

Implementation should prove:
- Smoke test uses temp `HOME` + temp `KDI_DB` (same pattern as
  `kdi-new-feature-loop` and `AGENTS.md` worktree isolation). Create a board and
  several tasks in different statuses via the CLI, then load `/stats` and
  `/diagnostics` and assert the rendered numbers match the CLI output.
- The diagnostics smoke test creates at least one condition that triggers a
  finding (e.g. a `ready` task older than 24 hours, or a task with repeated
  failures) and asserts the finding appears on the page.
- Verify that no client module imports `~/models/*` or `bun:sqlite` by running
  `bun run build:web` and grepping `apps/web/.svelte-kit/output` or equivalent.
- Run `bun run lint`, `bun run build`, `bun run check:web`, and `bun run build:web`
  in the smoke environment.

## 17. Risks / Open Questions

- **Risk: overlapping action scope with KDI-UI-006.** KDI-UI-009 now exposes reclaim, reassign, unblock, and comment actions. KDI-UI-006 will implement a broader lifecycle-action surface. The two must call the same model functions and not duplicate validation logic. **Mitigation:** the spec routes every action through the existing model functions (`reclaimTask`, `reassignTask`, `unblockTask`, `addComment`); no custom mutation logic is introduced in KDI-UI-009.
- **Risk: action shortcuts mutate state without confirmation.** A mis-click could reclaim or unblock a task. **Mitigation:** destructive actions (`reclaim`, `reassign`, `unblock`) require a confirmation dialog; `comment` requires a text input dialog; `cli_hint` and `open_docs` are harmless client-side affordances.
- **Risk: `cli_hint` and `open_docs` have no canonical target.** The CLI hint string is heuristic; `open_docs` needs a stable help/docs URL that does not yet exist. **Mitigation:** `cli_hint` generates the exact CLI command for the finding; `open_docs` links to `specs/hermes-kanban-backlog.md` (or a future `/docs` route) as a best-effort fallback.
- **Risk: large findings lists slow the page.** The diagnostics page renders all findings with no pagination. **Mitigation:** severity filter and per-rule grouping help narrow the view; pagination is deferred to a future enhancement.
- **Open question:** Should stats and diagnostics be combined into one
  dashboard? This spec keeps them as separate pages to match the CLI; a future
  item can merge them if UX research shows it helps.
- **Open question:** Should the stats page show historical charts? Out of scope
  for v1; the page is a point-in-time snapshot.
- **Open question:** Should the diagnostics page auto-refresh? Optional; the spec
  does not require it because findings are not a stream. Manual refresh is
  sufficient.

## 18. Gaps Discovered

- **KDI-UI-001 bridge shape for action routes.** The server bridge must expose
  POST routes for `reclaim`, `reassign`, `unblock`, and `comment` that validate
  the board/task relationship before calling model functions. This is not a gap
  in the CLI or models, but a required bridge capability for KDI-UI-009.
- **No canonical docs/help URL.** The `open_docs` shortcut currently targets
  `specs/hermes-kanban-backlog.md`. A future `/docs` route or external
  documentation site would provide a cleaner target.
- **No `cli_hint` command registry.** The hint text is generated per rule from
  the model function and CLI conventions. A centralized registry would keep
  hints consistent as new diagnostic rules are added.
- **Comment author resolution repeats CLI logic.** The `comment` action resolves
  author from `KDI_PROFILE` → `HERMES_PROFILE` → `"user"` on the server. If
  KDI-UI-001 already centralizes profile resolution, reuse it; otherwise this
  logic is duplicated from the CLI command.
- **Per-task diagnostics route needs task existence validation.** The bridge
  must validate that the requested `taskId` belongs to the resolved board and is
  not archived, matching `runDiagnostics` behavior.

## 19. Migration Notes

- No database migration. The dashboard uses existing schema, models, and event
  stream.
- No change to `src/db.ts`. `getDb()` resolution from `KDI_DB`/`KDI_DB_PATH` is
  inherited from the server process.

## 19. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-009: Stats and Diagnostics UI — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-009-stats-diagnostics-ui.md`
- [ ] `/stats` page renders status counts, assignee counts, and oldest ready age
- [ ] `/diagnostics` page renders findings with severity filter, per-task filter, and action shortcuts (reclaim, reassign, unblock, comment, cli_hint, open_docs)
- [ ] JSON export matches `kdi stats --json` and `kdi diagnostics --json`
- [ ] Smoke test compares UI numbers to CLI output with temp HOME/KDI_DB
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
```

## 20. Spec Location

`specs/sveltekit-ui/KDI-UI-009-stats-diagnostics-ui.md`

## 21. Worktree Branch Name

`docs/kdi-ui-009-stats-diagnostics-ui-spec`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD is non-editing and runs in the shared checkout.)
