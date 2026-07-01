# KDI SvelteKit UI Backlog

> Source: `specs/hermes-kanban-backlog.md`, `STATUS.md`, live CLI help, and current schema/models.
> Goal: turn implemented KDI/Hermes parity features into a SvelteKit operator UI backlog.
> Scope: backlog only, no frontend scaffold yet.

## Frontend Decisions

- Use SvelteKit for the operator UI.
- Gate the whole UI behind `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND`, with browser flag `VITE_FF_SVELTEKIT_FRONTEND` when code exists.
- Prefer a single SvelteKit app that calls existing KDI model code from server routes. No separate API service until deployment needs it.
- Do not put source in `frontend/` or `backend/`; current repo rules forbid those paths. Default future location: `apps/web/`, with `AGENTS.md` updated when scaffolding starts.
- Polling is enough for v1 live updates. Add SSE/WebSockets only after polling proves insufficient.

## P0 - UI Foundation

- [x] **KDI-UI-000: SvelteKit app shell** (implemented in `apps/web/`)
  - Create the SvelteKit app structure and scripts without breaking the CLI build.
  - Add a restrained product UI shell: board switcher, left navigation, main work area, command/action area.
  - Add feature flag handling for `FF_SVELTEKIT_FRONTEND` and `VITE_FF_SVELTEKIT_FRONTEND`.
  - Acceptance: `bun run lint`, CLI build, and SvelteKit build/dev command all work with isolated `KDI_DB`.

- [x] **KDI-UI-001: Server-side data bridge** (spec written: `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`)
  - Add SvelteKit server routes or load functions that call existing KDI models for boards, tasks, events, runs, logs, stats, diagnostics, workflows, and notifications.
  - Keep SQLite access server-side only.
  - Return small JSON shapes designed for UI screens, not raw CLI text.
  - Acceptance: one smoke test can create a temp board/task through the UI bridge and read it back.

## P1 - Core Operator Workflow

- [x] **KDI-UI-002: Board management UI** (spec written: `specs/sveltekit-ui/KDI-UI-002-board-management-ui.md`)
  - List boards with current marker, archived toggle, metadata, workdir, base ref, and task counts.
  - Create/edit boards with name, icon, color, description, workdir, default workdir, base ref, and `switch after create`.
  - Archive and hard-delete only with explicit confirmation.
  - Acceptance: covers `boards create/list/show/edit/switch/archive/rm/set-default-workdir/rename` behavior.

- [x] **KDI-UI-003: Kanban board view** (spec written: `specs/sveltekit-ui/KDI-UI-003-kanban-board-view.md`)
  - Show the 9 statuses: `triage`, `todo`, `scheduled`, `ready`, `running`, `blocked`, `review`, `done`, `archived`.
  - Show counts, assignee, priority, tenant, age, status reasons, and stale/rate-limited markers.
  - Filters: status, assignee, tenant, created-by, mine, session, archived, workflow template, step key, sort.
  - Acceptance: UI can reproduce `kdi list` filtered/sorted views.

- [x] **KDI-UI-004: Task create/edit UI** (spec written: `specs/sveltekit-ui/KDI-UI-004-task-create-edit-ui.md`)
  - Create tasks with title, body, assignee, status, schedule time, priority, tenant, created-by, skills, model, runtime, retries, workspace, session, workflow, goal mode, and parent dependencies.
  - Edit task fields supported by current CLI/model behavior.
  - Use native form controls first; no custom widgets unless required.
  - Acceptance: a created task displays correctly in board view and `kdi show`.

- [x] **KDI-UI-005: Task detail panel** (spec written: `specs/sveltekit-ui/KDI-UI-005-task-detail-panel.md`)
  - Show body, metadata, result, summary, comments, dependencies, attachments, context, runs, events, worker log, and worktree handoff branch/path.
  - Support run filtering by status/outcome.
  - Support log tail and event tail non-follow modes.
  - Acceptance: detail panel covers `show`, `runs`, `tail`, `log`, `context`, and `attach` data.

- [x] **KDI-UI-006: Task lifecycle actions** (spec written: `specs/sveltekit-ui/KDI-UI-006-task-lifecycle-actions.md`)
  - Actions: promote, promote dry-run, block, unblock, schedule, review, archive, restore if implemented later, complete, assign, reassign, claim, reclaim, heartbeat.
  - Bulk actions: promote, block, unblock, schedule, archive, complete.
  - Confirm destructive actions; inline reason fields for block/schedule/review/reclaim/reassign.
  - Acceptance: every action maps to an existing CLI/model path and shows success/skip/error per task.

## P2 - Dispatch, Health, and Observability

- [x] **KDI-UI-007: Dispatch control center** (spec written: `specs/sveltekit-ui/KDI-UI-007-dispatch-control-center.md`)
  - Show dispatcher presence, ready/running counts, profile availability, and recent spawn failures.
  - Trigger `dispatch --once` with `max`, `failure-limit`, and rate-limit cooldown options.
  - Surface KDI-056 profile doctor/repair state when that backend work lands.
  - Acceptance: user can safely run one dispatch pass and see spawned/blocked/skipped results.

- [x] **KDI-UI-008: Live activity view** (spec written: `specs/sveltekit-ui/KDI-UI-008-live-activity-view.md`)
  - Board-wide activity stream with filters for assignee, tenant, and event kinds.
  - Per-task event stream and worker log view.
  - Poll first, with pause/resume and manual refresh.
  - Acceptance: covers `watch`, `tail`, and `log` without requiring a WebSocket server.

- [x] **KDI-UI-009: Stats and diagnostics UI** (spec written: `specs/sveltekit-ui/KDI-UI-009-stats-diagnostics-ui.md`)
  - Show per-status counts, per-assignee counts, oldest-ready age, and health diagnostics.
  - Severity filter and task-specific diagnostics.
  - Add action shortcuts for diagnostics actions: reclaim, reassign, unblock, comment, open docs/CLI hint.
  - Acceptance: UI output matches `kdi stats --json` and `kdi diagnostics --json`.

- [x] **KDI-UI-010: Notification subscriptions UI** (spec written: `specs/sveltekit-ui/KDI-UI-010-notification-subscriptions-ui.md`)
  - List global and per-task subscriptions.
  - Subscribe/unsubscribe with platform, chat id, thread id, user id, and notifier profile.
  - Include archived/unsubscribed toggle.
  - Acceptance: covers `notify-subscribe`, `notify-list`, and `notify-unsubscribe`.

## P3 - Advanced Workflow UI

- [x] **KDI-UI-011: Triage automation UI** (spec written: `specs/sveltekit-ui/KDI-UI-011-triage-automation-ui.md`)
  - Specify one triage task, all triage tasks, or tenant-filtered triage tasks.
  - Decompose one/all/tenant-filtered triage tasks.
  - Show LLM errors and invalid responses as blocking feedback.
  - Acceptance: maps to `specify` and `decompose`, including `--skip-llm` for manual promotion.

- [x] **KDI-UI-012: Swarm builder** (spec written: `specs/sveltekit-ui/KDI-UI-012-swarm-builder.md`)
  - Create swarm graphs with workers, verifier, synthesizer, shared body, workspace, session, priority, and workspace kind.
  - Include dry-run preview before creation.
  - Acceptance: covers `kdi swarm --dry-run` and real swarm creation.

- [x] **KDI-UI-013: Workflow templates UI** (spec written: `specs/sveltekit-ui/KDI-UI-013-workflow-templates-ui.md`)
  - Define/list workflow templates with template id, name, and ordered step keys.
  - Create tasks from workflow templates and advance/jump steps with reasons.
  - Acceptance: covers `workflows define`, `workflows list`, `create --workflow-template-id`, and `step`.

- [x] **KDI-UI-014: Goal mode UI** (spec written: `specs/sveltekit-ui/KDI-UI-014-goal-mode-ui.md`)
  - Create goal-mode tasks with max turns and judge profile.
  - Show remaining turns, judge profile, and goal continuation events.
  - Acceptance: disabled unless `FF_GOAL_MODE=true` and hidden behind the frontend flag.

## P4 - Product Quality Gates

- [x] **KDI-UI-015: Accessibility and keyboard baseline** (spec written: `specs/sveltekit-ui/KDI-UI-015-accessibility-keyboard-baseline.md`)
  - Keyboard navigable board, task list, filters, forms, and action menus.
  - Visible focus states, labels on every input, and accessible status/action announcements.
  - Acceptance: Playwright selectors use stable roles/names or `input[name=...]`; no unlabeled form fields.

- [x] **KDI-UI-016: End-to-end UI smoke loop** (spec written: `specs/sveltekit-ui/KDI-UI-016-end-to-end-ui-smoke-loop.md`)
  - Use temp `HOME` and temp `KDI_DB`.
  - Real path: init → create board → create task → promote → dispatch once → inspect result/log/events → archive.
  - Acceptance: the smoke test proves the UI path and CLI path read/write the same data.

## Explicit Non-Goals for v1

- No auth/multi-user permissions until KDI has a server deployment story.
- No drag-and-drop until click/keyboard lifecycle actions are solid.
- No WebSockets/SSE until polling is too slow or wasteful.
- No separate backend service unless SvelteKit server routes cannot meet deployment needs.
