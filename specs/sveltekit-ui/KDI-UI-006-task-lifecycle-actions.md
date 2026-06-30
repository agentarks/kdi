# Specification: KDI-UI-006 — Task Lifecycle Actions

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-006: Task lifecycle actions`.
> Scope of this document: the **full** KDI-UI-006 item — the browser UI affordances
> that let an operator mutate a single task or a selected group of tasks through
> the existing CLI model layer. This is a **spec-writing task**, not an
> implementation. All behavior contracts are validated against the live CLI/model
> source (`src/commands/tasks.ts`, `src/models/task.ts`, `src/models/claim.ts`,
> `src/models/dependency.ts`, `src/flags.ts`, `specs/feature-flags.md`).

---

## 1. Business Goal

Give operators a browser UI for the complete single-task and bulk-task lifecycle
surface that `kdi <task>` already exposes on the CLI: **promote, promote dry-run,
block, unblock, schedule, review, archive, complete, assign, reassign, claim,
reclaim, and heartbeat**. The UI must call the same model functions the CLI uses,
gate each action behind the same feature flags, and surface success / skip /
error per task so operators can safely act on one task or many without
shelling out. The browser is the primary interaction surface for operators who
prefer click/keyboard workflows over CLI commands.

## 2. Problem Statement

Task lifecycle mutation today is CLI-only (`kdi promote`, `kdi block`, etc.).
The CLI commands are feature-complete and flag-stable, but there is no UI. The
SvelteKit UI backlog gates this screen at P1 (KDI-UI-006), but its prerequisites
are not built: there is no task-selection mechanism, no task-detail context, no
SvelteKit app bridge to call the model layer, and `FF_SVELTEKIT_FRONTEND` is
InDev with a default of `false`. A browser UI for lifecycle actions therefore
cannot exist until the shell, server-side data bridge, kanban board, and task
detail panel are in place.

This document specifies the contract KDI-UI-006 must meet once the prerequisites
land, so implementation can proceed without re-deriving the CLI semantics and
reviewers can verify the parent acceptance (the union of `promote`, `block`,
`unblock`, `schedule`, `review`, `archive`, `complete`, `assign`, `reassign`,
`claim`, `reclaim`, and `heartbeat`) against a single source of truth.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web` SvelteKit app scaffolded;
  `FF_SVELTEKIT_FRONTEND` registered in `src/flags.ts` (InDev, default `false`)
  and `VITE_FF_SVELTEKIT_FRONTEND` available to the browser; CLI
  `bun run build` and SvelteKit build/dev work with isolated `KDI_DB`.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions
  can call existing KDI model code (`src/models/*`) and return UI-shaped JSON;
  SQLite access stays server-side only. One smoke test can create a temp
  board/task through the bridge and read it back. (A draft for this bridge exists
  at `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`.)
- **KDI-UI-003 — Kanban board view.** The board view provides the task selection
  mechanism: a list of tasks with selectable rows, status columns, and bulk
  selection checkboxes. Lifecycle actions need a context to act on.
- **KDI-UI-005 — Task detail panel.** The detail panel provides the single-task
  context: it shows a task's body, status, assignee, dependencies, and related
  data, and is the natural home for per-task action buttons.

KDI-UI-006 adds **only** SvelteKit action components and the narrow server
actions its screens need. It must not modify `src/models/*`, `src/commands/*`,
`src/flags.ts`, or `src/db.ts` beyond imports. If a needed JSON shape is missing,
the gap is raised against KDI-UI-001, not patched here.

## 4. Decision Options

1. **Action buttons on board rows and detail panel.** Each task row in the kanban
   board exposes a small action menu (e.g. "Promote", "Block", "Schedule"); the
   detail panel exposes the full action set. Bulk selection adds a toolbar with
   the bulk-capable actions. **Chosen.** Matches the operator's mental model:
    actions live where the task is shown, and bulk selection is a natural
    extension of the board.
2. **Dedicated lifecycle actions page.** A separate `/actions` page where the
   operator picks a task and then picks an action. Simpler to build but
   disconnected from board context, requiring extra navigation and state sharing.
    Rejected — it duplicates the task-selection work of KDI-UI-003 and hides
   context from the operator.
3. **Inline CLI command builder.** A form that constructs a `kdi` command string
   for the operator to copy. No real UI value and does not exercise the data
   bridge. Rejected.

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| Promote | `kdi promote <id>` → `promoteTask(id)` or `promoteTaskAdvanced(id)` | Promote action on row/detail for a `todo` task; inline dry-run preview and force checkbox |
| Promote dry-run | `kdi promote --dry-run <id>...` → `promoteTaskAdvanced(id, { dryRun: true })` | Dry-run button/checkbox showing per-task verdict before mutating |
| Promote force | `kdi promote --force <id>...` → `promoteTaskAdvanced(id, { force: true })` | Force checkbox bypassing `isBlockedByDependencies` |
| Block | `kdi block <id>... --reason <text>` → `blockTask(id, reason)` | Block action with inline reason field; per-row and bulk |
| Unblock | `kdi unblock <id>... [--reason <text>]` → `unblockTask(id, reason)` | Unblock action; optional reason field; scheduled tasks become `ready` |
| Schedule | `kdi schedule <id>... --at <ts> [--reason <text>]` → `scheduleTask(id, at, reason)` | Schedule form with datetime picker and reason field; future time enforced |
| Review | `kdi review <id> [--reason <text>]` → `reviewTask(id, reason)` | Review action with optional reason field |
| Archive | `kdi archive <id>...` → `archiveTask(id)` | Archive action; destructive confirmation; bulk supported |
| Complete | `kdi complete <id>... [--result <text>] [--summary <text>] [--metadata <json>]` → `completeTask(id, input)` | Complete form with result, summary, and metadata fields; bulk supports only `result` |
| Assign | `kdi assign <id> <profile>` → `assignTask(id, profile)`; `assign <id> none` → `unassignTask(id)` | Assign action with profile input; `none` unassigns |
| Reassign | `kdi reassign <id> <profile> [--reclaim] [--reason]` → `reassignTask(id, profile, { reclaim, reason })` | Reassign action with profile input, optional reclaim, and reason field |
| Claim | `kdi claim <id> [--ttl <seconds>]` → `atomicClaim(id, profile, ttl)` | Claim action; optional TTL input; profile defaults to current user |
| Reclaim | `kdi reclaim <id> [--reason <text>]` → `reclaimTask(id, reason)` | Reclaim action; optional reason field |
| Heartbeat | `kdi heartbeat <id> [--note <text>]` → `heartbeat(id, note)` | Heartbeat button; optional note field; note capped at 4 KiB |
| Bulk | Bulk IDs + `--force`/`--dry-run` gated by `FF_BULK_OPERATIONS` | Bulk selection on board rows; bulk actions for promote, block, unblock, schedule, archive, complete |
| Flag gating | CLI per-command flags | Whole UI behind `FF_SVELTEKIT_FRONTEND`; per-action flags enable/disable/hide controls |
| Result reporting | Per-line stdout/stderr per task | Per-task result row with status, task id, and message; summary counts for bulk |

## 6. Functional Requirements

All lifecycle actions are exposed through SvelteKit form actions (`+page.server.ts`
for detail-panel single actions, `+server.ts` or form actions for the board
bulk toolbar). Each action imports the existing model function from `~/models/*`
and returns a small JSON result shape. No action spawns the CLI binary or
introduces new SQL.

### 6.1 Promote

- **FR-1** A single-task "Promote" action on the detail panel and row menu
  calls `promoteTaskAdvanced(id)` for a `todo` task. It is enabled only when the
  task status is `todo` and the task is not archived. On success the task
  status becomes `ready` and an event is recorded; the UI reflects the new
  status.
- **FR-2** A "Dry run" checkbox on the promote action routes through
  `promoteTaskAdvanced(id, { dryRun: true })` and returns the verdict
  (`would_promote`, `not_found`, `archived`, `wrong_status`,
  `blocked_by_dependencies`) without mutating state. The UI displays the
  verdict per task before the operator confirms the real promote.
- **FR-3** A "Force" checkbox on the promote action routes through
  `promoteTaskAdvanced(id, { force: true })` to bypass the parent dependency
  check performed by `isBlockedByDependencies`. The checkbox is enabled only
  when a parent dependency is blocking the task (KDI-UI-001 must expose a way
  to read this state, or the UI can rely on the dry-run verdict).
- **FR-4** Bulk promote is available in the board bulk toolbar when at least one
  selected task is in `todo` status. It calls `promoteTaskAdvanced` per task
  with optional `force` and `dryRun`. Each task result is reported separately.
  The bulk action is gated by `FF_BULK_OPERATIONS`.

### 6.2 Block

- **FR-5** A "Block" action on the detail panel and row menu opens a small form
  with a required **Reason** textarea. The action calls `blockTask(id, reason)`.
  It is enabled for any non-archived task that is not already `blocked`. On
  success the task status becomes `blocked` and `block_reason` is set.
- **FR-6** Bulk block in the board bulk toolbar requires a reason and applies to
  all selected non-archived tasks. It skips tasks that are already `blocked` or
  `archived` and reports skip reasons per task. The bulk action is gated by
  `FF_BULK_OPERATIONS`.

### 6.3 Unblock

- **FR-7** An "Unblock" action on the detail panel and row menu calls
  `unblockTask(id, optionalReason)`. It is enabled for tasks in `blocked` or
  `scheduled` status. A `blocked` task becomes `todo`; a `scheduled` task becomes
  `ready` (requires `FF_SCHEDULED_STATUS` to be enabled). The optional reason is
  recorded as a comment when provided.
- **FR-8** Bulk unblock in the board bulk toolbar applies to selected `blocked`
  and/or `scheduled` tasks, with the same status transitions and per-task
  reporting. The bulk action is gated by `FF_BULK_OPERATIONS`.

### 6.4 Schedule

- **FR-9** A "Schedule" action on the detail panel and row menu opens a form
  with a required **At** datetime input and an optional **Reason** textarea. The
  action calls `scheduleTask(id, scheduledAt, reason)`. The UI rejects times in
  the past before calling the model (matching the model's guard). The action is
  gated by `FF_SCHEDULED_STATUS` and is enabled for non-archived tasks.
- **FR-10** Bulk schedule in the board bulk toolbar applies the same `at` and
  `reason` to all selected non-archived tasks and reports per-task results. The
  bulk action is gated by `FF_BULK_OPERATIONS` and `FF_SCHEDULED_STATUS`.

### 6.5 Review

- **FR-11** A "Review" action on the detail panel and row menu opens a form
  with an optional **Reason** textarea. The action calls `reviewTask(id, reason)`.
  It is gated by `FF_REVIEW_STATUS` and is enabled for any non-archived task
  that is not already in `review` status.

### 6.6 Archive

- **FR-12** An "Archive" action on the detail panel and row menu calls
  `archiveTask(id)`. It is enabled for any non-archived task. A confirmation
  dialog names the task ID and title and warns that archive is one-way (no UI
  restore exists today).
- **FR-13** Bulk archive in the board bulk toolbar archives all selected
  non-archived tasks and reports per-task results. The bulk action is gated by
  `FF_BULK_OPERATIONS`.

### 6.7 Complete

- **FR-14** A "Complete" action on the detail panel opens a form with optional
  **Result**, **Summary**, and **Metadata** (JSON textarea) fields. The action
  calls `completeTask(id, { result, summary, metadata })`. The metadata field
  is gated by `FF_COMPLETE_METADATA`; when the flag is off the field is hidden
  and any submitted metadata is rejected with
  `"Complete --metadata is not enabled."`. The action is enabled for any
  non-archived task.
- **FR-15** Bulk complete in the board bulk toolbar supports only a **Result**
  field (matching the CLI limitation that bulk complete does not support
  `--summary` or `--metadata`). It calls `completeTask(id, { result })` per
  selected non-archived task. The bulk action is gated by `FF_BULK_OPERATIONS`.

### 6.8 Assign / Unassign

- **FR-16** An "Assign" action on the detail panel and row menu opens a form
  with a **Profile** text input. Submitting a non-empty profile calls
  `assignTask(id, profile)`. Submitting the literal string `none` (case
  insensitive) calls `unassignTask(id)`. The action is gated by
  `FF_ASSIGN_REASSIGN`. The default displayed profile is the current user
  (`KDI_PROFILE` or `HERMES_PROFILE` or `"user"`).

### 6.9 Reassign

- **FR-17** A "Reassign" action on the detail panel opens a form with a
  **Profile** text input, a **Reclaim active claim** checkbox, and an optional
  **Reason** textarea. It calls `reassignTask(id, profile, { reclaim, reason })`.
  The literal `none` unassigns. The action is gated by `FF_ASSIGN_REASSIGN`. The
  `--reason` option is also gated by `FF_ASSIGN_REASSIGN` (matching the CLI).

### 6.10 Claim

- **FR-18** A "Claim" action on the detail panel and row menu calls
  `atomicClaim(id, profile, ttlSeconds)` for a `ready` task. The profile
  defaults to the current user; an optional **TTL** input accepts seconds. The
  action is enabled only for `ready` tasks that are not archived. On success the
  task becomes `running`, a run is created, and the UI shows the claim lock and
  expiration.

### 6.11 Reclaim

- **FR-19** A "Reclaim" action on the detail panel and row menu calls
  `reclaimTask(id, reason)` for a `running` task with an active claim. It has an
  optional **Reason** textarea. The `--reason` option is gated by
  `FF_ASSIGN_REASSIGN`. On success the task returns to `ready` and the run is
  finished with outcome `reclaimed`.

### 6.12 Heartbeat

- **FR-20** A "Heartbeat" action on the detail panel and row menu calls
  `heartbeat(id, note)` for a `running` task. It has an optional **Note** textarea
  capped at 4,096 bytes (matching `MAX_HEARTBEAT_NOTE_BYTES` in the model and
  CLI). The action is gated by `FF_HEARTBEAT`. On success the task's
  `last_heartbeat_at` and the active run's `last_heartbeat_at` are updated.

### 6.13 Result / skip / error reporting

- **FR-21** Every action returns a per-task result object with stable fields:
  `{ taskId, status: 'success' | 'skipped' | 'error', message, currentStatus? }`.
  Bulk actions return an array of these objects plus a summary `{ attempted,
  succeeded, skipped, failed }`. The UI renders the array as a result panel.
- **FR-22** Successes show the task ID and a short human message derived from the
  CLI output (e.g. `"Promoted task 42 to ready."`).
- **FR-23** Skips show the reason (e.g. `"skipped: already blocked"`,
  `"skipped: wrong_status (current: running)"`, `"skipped: not_found"`).
- **FR-24** Errors show the model error message verbatim (e.g.
  `"Task 42 not found or already archived"`, `"Scheduled time must be in the
  future"`). No stack trace is exposed in production.

### 6.14 Preconditions and flag gating

- **FR-25** Every action's affordance is disabled (with a tooltip naming the
  flag) when its required feature flag is off. Server-side, the action re-checks
  the flag and rejects any submitted mutation with the same CLI error text when
  the flag is off.
- **FR-26** The master flag `FF_SVELTEKIT_FRONTEND` hides the entire UI when
  `false`; when it is `false`, no lifecycle action route mutates state.
- **FR-27** Promote is only enabled for tasks in `todo` status. Block is only
  enabled for tasks that are not `blocked` and not `archived`. Unblock is only
  enabled for `blocked` or `scheduled` tasks. Schedule is only enabled when
  `FF_SCHEDULED_STATUS` is on and the task is not `archived`. Review is only
  enabled when `FF_REVIEW_STATUS` is on and the task is not `archived` or
  `review`. Archive is only enabled for non-archived tasks. Complete is only
  enabled for non-archived tasks. Assign/Reassign is only enabled when
  `FF_ASSIGN_REASSIGN` is on. Claim is only enabled for `ready` tasks. Reclaim is
  only enabled for `running` tasks with a claim. Heartbeat is only enabled when
  `FF_HEARTBEAT` is on and the task is `running`.

### 6.15 Server bridge requirements (consumed from KDI-UI-001)

- **FR-28** KDI-UI-001 must expose a SvelteKit form action or server route that
  accepts `taskId`, `action`, and action-specific fields and dispatches to the
  correct model function. This item does not build that dispatcher; it defines
  the contract it consumes.
- **FR-29** KDI-UI-001 must expose a read shape that includes the fields needed
  for precondition checks: `id`, `status`, `archived_at`, `assignee`,
  `claim_lock`, `claim_expires`, `last_heartbeat_at`, and parent dependency
  blocking state. If the dependency blocking state is not available, KDI-UI-006
  falls back to calling the dry-run promote and treating `blocked_by_dependencies`
  as the signal.

## 7. Scope

In scope:
- Single-task action affordances on the detail panel (KDI-UI-005) and task row
  menu (KDI-UI-003): promote, dry-run promote, force promote, block, unblock,
  schedule, review, archive, complete, assign, reassign, claim, reclaim, and
  heartbeat.
- Bulk action affordances in the board view toolbar: bulk promote, bulk block,
  bulk unblock, bulk schedule, bulk archive, and bulk complete.
- Inline reason/result/summary/metadata input fields for the actions that require
  them, using native form controls.
- Confirmation dialogs for destructive actions (archive, complete, reassign
  with reclaim, reclaim).
- Per-task success / skip / error result reporting and bulk summary counts.
- Server-side and client-side feature-flag gating for all gated actions.
- SvelteKit form actions/server routes that call the existing model functions
  listed in §12 Appendices.

Out of scope (explicitly):
- SvelteKit scaffolding / `apps/web` / `FF_SVELTEKIT_FRONTEND` registration
  (KDI-UI-000).
- General server-side data bridge framework (KDI-UI-001); only the narrow
  action-handling contract this item consumes.
- Kanban board view itself (KDI-UI-003) and task detail panel itself
  (KDI-UI-005). This item only defines the actions that attach to those
  surfaces.
- Task create/edit forms (KDI-UI-004), dispatch control center (KDI-UI-007),
  live activity view (KDI-UI-008), stats/diagnostics (KDI-UI-009),
  notifications (KDI-UI-010), triage automation (KDI-UI-011), swarm builder
  (KDI-UI-012), workflow templates (KDI-UI-013), goal mode (KDI-UI-014),
  accessibility baseline (KDI-UI-015), and end-to-end smoke loop (KDI-UI-016).
- Any new model function or SQL query. If a needed read shape is missing, it is
  a gap for KDI-UI-001 to expose, not something this item creates.
- New feature flags. This item reuses existing flags only.
- Drag-and-drop status changes, WebSockets/SSE real-time updates,
  auth/multi-user permissions, and path-picker widgets.
- Board management (KDI-UI-002) and task dependencies link/unlink (KDI-026
  CLI; not in the UI backlog yet).
- Any change to CLI commands, models, db schema, or flag semantics.

## 8. Acceptance Criteria

- **AC-01 (single promote)** The detail panel shows a "Promote" action for a
  `todo` task; clicking it calls `promoteTaskAdvanced(id)` and the task status
  changes to `ready` with a `promoted` event.
- **AC-02 (promote preconditions)** Promote is disabled for tasks not in `todo`
  status; attempting it server-side returns a `wrong_status` skip with the
  current status.
- **AC-03 (promote dry-run)** A "Dry run" toggle on the promote action calls
  `promoteTaskAdvanced(id, { dryRun: true })` and shows the verdict without
  mutating state.
- **AC-04 (promote force)** A "Force" toggle on the promote action calls
  `promoteTaskAdvanced(id, { force: true })` and promotes a `todo` task even when
  `isBlockedByDependencies` would block it.
- **AC-05 (bulk promote)** With `FF_BULK_OPERATIONS=true`, the board bulk toolbar
  can promote multiple selected `todo` tasks, reporting per-task success/skip
  and a summary count.
- **AC-06 (block)** A "Block" action with a required reason field calls
  `blockTask(id, reason)`; the task becomes `blocked` and `block_reason` is set.
- **AC-07 (block preconditions)** Block is disabled for already `blocked` or
  `archived` tasks; attempting it server-side returns a skip/error.
- **AC-08 (bulk block)** With `FF_BULK_OPERATIONS=true`, the bulk toolbar can
  block multiple selected non-archived tasks with one shared reason, reporting
  per-task results and skipping already-blocked tasks.
- **AC-09 (unblock)** An "Unblock" action calls `unblockTask(id, optionalReason)`;
  a `blocked` task becomes `todo`, a `scheduled` task becomes `ready`.
- **AC-10 (bulk unblock)** With `FF_BULK_OPERATIONS=true`, the bulk toolbar can
  unblock multiple selected `blocked`/`scheduled` tasks and report per-task
  results.
- **AC-11 (schedule)** With `FF_SCHEDULED_STATUS=true`, a "Schedule" action with
  a datetime input and optional reason calls `scheduleTask(id, at, reason)`; the
  task becomes `scheduled` and `scheduled_at` is set. Past times are rejected.
- **AC-12 (bulk schedule)** With `FF_BULK_OPERATIONS=true` and
  `FF_SCHEDULED_STATUS=true`, the bulk toolbar can schedule multiple selected
  tasks to the same future time.
- **AC-13 (review)** With `FF_REVIEW_STATUS=true`, a "Review" action with an
  optional reason field calls `reviewTask(id, reason)` and the task becomes
  `review`.
- **AC-14 (archive)** An "Archive" action calls `archiveTask(id)` after a
  confirmation dialog; the task becomes `archived` and disappears from the
  default board view.
- **AC-15 (bulk archive)** With `FF_BULK_OPERATIONS=true`, the bulk toolbar can
  archive multiple selected non-archived tasks after confirmation and report
  per-task results.
- **AC-16 (complete)** A "Complete" action with optional result, summary, and
  metadata fields calls `completeTask(id, { result, summary, metadata })`; the
  task becomes `done` and a run is finalized.
- **AC-17 (complete metadata gate)** With `FF_COMPLETE_METADATA=false`, the
  metadata field is hidden and a submitted metadata value is rejected with
  `"Complete --metadata is not enabled."`.
- **AC-18 (bulk complete)** With `FF_BULK_OPERATIONS=true`, the bulk toolbar can
  complete multiple selected non-archived tasks with a shared result field only.
- **AC-19 (assign)** With `FF_ASSIGN_REASSIGN=true`, an "Assign" action with a
  profile input calls `assignTask(id, profile)`; the literal `none` calls
  `unassignTask(id)`.
- **AC-20 (reassign)** With `FF_ASSIGN_REASSIGN=true`, a "Reassign" action with
  profile input, optional reclaim checkbox, and optional reason field calls
  `reassignTask(id, profile, { reclaim, reason })`; `none` unassigns.
- **AC-21 (claim)** A "Claim" action on a `ready` task calls
  `atomicClaim(id, profile, ttl)`; the task becomes `running`, a run is created,
  and the claim lock is shown.
- **AC-22 (reclaim)** A "Reclaim" action on a `running` task with an active
  claim calls `reclaimTask(id, reason)`; the task returns to `ready` and the run
  is finalized with outcome `reclaimed`.
- **AC-23 (heartbeat)** With `FF_HEARTBEAT=true`, a "Heartbeat" action on a
  `running` task calls `heartbeat(id, note)` and updates
  `last_heartbeat_at`; notes over 4,096 bytes are truncated.
- **AC-24 (result reporting)** Every action returns a per-task result with
  `taskId`, `status`, and `message`; bulk actions include summary counts and
  render per-task rows.
- **AC-25 (flag gate server-side)** With a required per-action flag off, the UI
  disables the control and a direct server submission is rejected with the CLI
  error text; no mutation occurs.
- **AC-26 (master flag)** With `FF_SVELTEKIT_FRONTEND=false`, all lifecycle
  action routes are unavailable and perform no mutations.
- **AC-27 (no model churn)** No file under `src/models`, `src/commands`,
  `src/flags.ts`, or `src/db.ts` is modified (review-enforced; only imports).
- **AC-28 (UI smoke)** A smoke test using temp `HOME` + temp `KDI_DB` can:
  create a board and task via the bridge → promote the task → block it with a
  reason → unblock it → schedule it → review it → assign it → claim it →
  heartbeat it → complete it → archive it → verify each state matches `kdi
  show` against the same DB. (Depends on KDI-UI-000/001/003/005 for the harness.)
- **AC-29 (bulk smoke)** With `FF_BULK_OPERATIONS=true`, a smoke test selects
  multiple tasks and runs bulk promote, block, unblock, schedule, archive, and
  complete, verifying per-task results and summary counts.
- **AC-30 (build)** `bun run lint`, CLI `bun run build`, and the SvelteKit build
  pass with isolated `KDI_DB`; existing CLI tests remain green.

## 9. Risks and Mitigations

- **Blocked on KDI-UI-000/001/003/005:** this item cannot start until the shell,
  data bridge, board view, and detail panel exist. Mitigation: §3 makes the
  gates explicit; do not bundle the shell or board view into this item.
- **Destructive action guard:** archive, complete, reassign-with-reclaim, and
  reclaim are destructive or state-changing. Mitigation: confirmation dialogs
  name the task ID and title; archive warns it is one-way; complete warns it
  finalizes the task; reclaim warns it releases an active claim. Confirm
  buttons are disabled until the operator explicitly confirms.
- **Precondition errors:** actions can race with other operators or the
  dispatcher. Mitigation: server-side preconditions mirror the model's guards
  (status checks, archived checks, claim checks); errors surface verbatim and
  do not fake success.
- **Client bypass:** a malicious client could POST directly to a server action.
  Mitigation: every action re-checks its feature flag and task state on the
  server; client gating is UX only.
- **Flag matrix:** multiple flags touch this item. Mitigation: a single
  server-side capability map is resolved once and passed to the UI; disabled
  controls show the flag name in a tooltip; direct submissions are rejected.
- **Dependency on prior UI items:** the board view and detail panel may change
  shape during implementation. Mitigation: this spec defines only the action
  contract; the UI components are added to the surfaces KDI-UI-003/005 provide.
- **Bulk partial failure:** a bulk action may succeed for some tasks and fail for
  others. Mitigation: per-task result reporting and summary counts make partial
  failure visible; the operator can retry only failed tasks.
- **Model error text drift:** the UI copies CLI error text for flag gates and
  preconditions. Mitigation: AC-25 and AC-26 verify the actual error text; the
  spec names the current messages but tests should assert the live text.

## 10. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser:
  `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. Gates the
  **whole** UI. Inherited; this item adds no new flag of its own.
- Per-action flags reused from the CLI (no new flags):
  - `FF_BULK_OPERATIONS` — bulk promote, bulk block, bulk unblock, bulk
    schedule, bulk archive, bulk complete; promote `--force` and `--dry-run`.
  - `FF_SCHEDULED_STATUS` — schedule and unblock-to-ready transitions.
  - `FF_REVIEW_STATUS` — review action.
  - `FF_ASSIGN_REASSIGN` — assign, reassign, and the `--reason` option on
    reclaim.
  - `FF_COMPLETE_METADATA` — complete `--metadata` field only; base complete is
    ungated.
  - `FF_HEARTBEAT` — heartbeat action.
- Actions with **no per-action flag** (mirroring the CLI): single promote, block,
  unblock, archive, complete, claim, and reclaim (base path).
- **Rollback / deactivation:** Set `FF_SVELTEKIT_FRONTEND=false` to hide the entire
  UI; per-action flags revert individual controls to disabled/hidden. The CLI
  continues to own all task lifecycle actions.
- **Deprecation plan:** N/A (additive UI).

## 11. CLI → UI behavior coverage map

Confirms the parent acceptance ("every action maps to an existing CLI/model
path and shows success/skip/error per task"):

| `tasks` behavior | Model function | FR(s) | AC(s) |
|---|---|---|---|
| `promote <id>` | `promoteTaskAdvanced(id)` | FR-1 | AC-01, AC-02 |
| `promote --dry-run <id>...` | `promoteTaskAdvanced(id, { dryRun: true })` | FR-2 | AC-03 |
| `promote --force <id>...` | `promoteTaskAdvanced(id, { force: true })` | FR-3 | AC-04 |
| bulk `promote <id>...` | `promoteTaskAdvanced` per task | FR-4 | AC-05 |
| `block <id>... --reason <text>` | `blockTask(id, reason)` | FR-5, FR-6 | AC-06, AC-07, AC-08 |
| `unblock <id>... [--reason]` | `unblockTask(id, reason)` | FR-7, FR-8 | AC-09, AC-10 |
| `schedule <id>... --at <ts> [--reason]` | `scheduleTask(id, at, reason)` | FR-9, FR-10 | AC-11, AC-12 |
| `review <id> [--reason]` | `reviewTask(id, reason)` | FR-11 | AC-13 |
| `archive <id>...` | `archiveTask(id)` | FR-12, FR-13 | AC-14, AC-15 |
| `complete <id>... [--result/--summary/--metadata]` | `completeTask(id, input)` | FR-14, FR-15 | AC-16, AC-17, AC-18 |
| `assign <id> <profile>` | `assignTask(id, profile)` / `unassignTask(id)` | FR-16 | AC-19 |
| `reassign <id> <profile> [--reclaim] [--reason]` | `reassignTask(id, profile, { reclaim, reason })` | FR-17 | AC-20 |
| `claim <id> [--ttl]` | `atomicClaim(id, profile, ttl)` | FR-18 | AC-21 |
| `reclaim <id> [--reason]` | `reclaimTask(id, reason)` | FR-19 | AC-22 |
| `heartbeat <id> [--note]` | `heartbeat(id, note)` | FR-20 | AC-23 |

Cross-cutting: FR-21..FR-29 / AC-24..AC-30. End-to-end: AC-28, AC-29.

---

## Appendix A — Model surface this item consumes

Validated live in `src/models/task.ts`, `src/models/claim.ts`, and
`src/models/dependency.ts`:

- `Task` interface — all task fields; the UI needs `id`, `status`, `title`,
  `assignee`, `archived_at`, `claim_lock`, `claim_expires`, `last_heartbeat_at`,
  `scheduled_at`, `block_reason`, `schedule_reason`, `review_reason`, and board
  relationship.
- `promoteTaskAdvanced(id, options?: { force?: boolean; dryRun?: boolean })` →
  `PromoteTaskResult` with `status: 'promoted' | 'not_found' | 'archived' |
  'wrong_status' | 'blocked_by_dependencies' | 'would_promote'`.
- `blockTask(id, reason)` → `Task`; throws `Task <id> not found or already archived`.
- `unblockTask(id, reason?)` → `Task`; throws `Task <id> not found` or
  `Task <id> is not in 'blocked' or 'scheduled' status`.
- `scheduleTask(id, scheduledAt, reason?)` → `Task`; throws
  `Scheduled time must be in the future` or `Task <id> not found or already archived`.
- `reviewTask(id, reason?)` → `Task`; throws
  `Task <id> not found, already in review, or archived`.
- `archiveTask(id)` → `Task`; throws `Task <id> not found or already archived`.
- `completeTask(id, input?)` → `Task`; throws `Task <id> not found or already archived`
  or `Task <id> is archived and cannot be completed`.
- `assignTask(id, profile)` → `Task`; throws `Task <id> not found or already archived`.
- `unassignTask(id)` → `Task`; throws `Task <id> not found or already archived`.
- `reassignTask(id, profile, options?)` → `Task`; calls `reclaimTask` when
  `reclaim` is true and status is `running`; calls `unassignTask` for `none`.
- `atomicClaim(taskId, profile, ttlSeconds?)` → `{ success, expiresAt?, runId? }`.
- `reclaimTask(taskId, reason?)` → `boolean`.
- `heartbeat(taskId, note?)` → `boolean`; note capped at 4,096 bytes in the CLI.
- `isBlockedByDependencies(taskId)` → `boolean` (parent dependency check for promote).

## Appendix B — CLI command surface mirrored

Validated live in `src/commands/tasks.ts`:

- `promote [task_ids...] [--force] [--dry-run]` — single or bulk; `force` and
  `dryRun` gated by `FF_BULK_OPERATIONS`.
- `block [task_ids...] --reason <text>` — bulk gated by `FF_BULK_OPERATIONS`.
- `unblock <task_ids...> [--reason <text>]` — bulk gated by `FF_BULK_OPERATIONS`.
- `schedule <task_ids...> --at <timestamp> [--reason <text>]` — gated by
  `FF_SCHEDULED_STATUS`; bulk gated by `FF_BULK_OPERATIONS`.
- `review <task_id> [--reason <text>]` — gated by `FF_REVIEW_STATUS`.
- `archive [task_ids...] [--rm]` — bulk gated by `FF_BULK_OPERATIONS`; `--rm`
  not surfaced in this UI slice (hard delete of archived tasks is out of scope).
- `complete <task_ids...> [--result <text>] [--summary <text>] [--metadata <json>]` —
  `--metadata` gated by `FF_COMPLETE_METADATA`; bulk supports only `--result`.
- `assign <task_id> <profile>` — `none` unassigns; gated by `FF_ASSIGN_REASSIGN`.
- `reassign <task_id> <profile> [--reclaim] [--reason <text>]` — gated by
  `FF_ASSIGN_REASSIGN`.
- `claim <task_id> [--ttl <seconds>]` — no feature flag.
- `reclaim <task_id> [--reason <text>]` — `--reason` gated by `FF_ASSIGN_REASSIGN`.
- `heartbeat <task_id> [--note <text>]` — gated by `FF_HEARTBEAT`.
