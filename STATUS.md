# kdi — Status

## SvelteKit UI Design Refresh — Applied
- [x] Selected design direction: **Brutalist Soft — Yellow** (after exploring 10+ modern directions and focused variations)
- [x] Added `PRODUCT.md` and `DESIGN.md` at project root to lock down product context, tone, color strategy, typography, elevation, and component rules
- [x] Rewrote `apps/web/src/app.css` with new token system: light background, black outlines, white surfaces, yellow accent, offset shadows
- [x] Moved component-specific layout back into scoped `<style>` blocks for `KanbanBoard`, `KanbanColumn`, `TaskCard`, `BoardKanbanView`, `KanbanFilterBar`, `BoardListRow`, and board routes while keeping global tokens/utilities in `app.css`
- [x] Made kanban board responsive: `auto-fill` grid, single-column collapse at ≤768px
- [x] Added accessibility baseline: `focus-visible` outlines, `prefers-reduced-motion` support, mobile sidebar breakpoint
- [x] Fixed design system consistency: surface `#fdfdfd`, active nav uses muted yellow `#fff9c4`, consolidated duplicate `.badge` declarations
- [x] Fixed warning badge contrast: warning badges now use dark text (`#1a1a1a`) on `#ff6b6b` backgrounds
- [x] Fixed primary button focus: `.btn--primary:focus-visible` uses accent (`#fff176`) outline
- [x] Fixed button shadow: all buttons now use `#fff176` accent shadow per `DESIGN.md`
- [x] Restored `.badge.archived-tag` styling and removed duplicate scoped `.archived-tag` in `BoardKanbanView.svelte`; switched archived board tag to use global `.badge.archived-tag`
- [x] Combined `.badge.warn`, `.badge.archived-tag`, and `.badge.stale` into one shared rule in `app.css`
- [x] Fixed body font: app shell no longer forces `Space Grotesk`; UI chrome uses `Space Grotesk`, `.work-area` uses `Inter`
- [x] Added tokens for success and semantic badge colors; documented in `DESIGN.md`
- [x] Deleted redundant per-element focus-visible rules and redundant `.btn.secondary` override in `KanbanFilterBar`
- [x] Deleted throwaway `apps/web/static/design-preview.html`
- [x] Verification: `bun run lint`, `bun run test` (1006 pass / 0 fail), `bun run build`, `bun run check:web`, `bun run build:web` all pass
- [ ] Review follow-up: further contrast audit for archived rows; self-host fonts to avoid Google Fonts render-block

## Tech Debt
- [ ] KDI-UI-006: Pre-existing dispatch HTTP flake — `bridge.http.test.ts` dispatch test fails intermittently under full-suite load (passes in isolation). Not caused by KDI-UI-006 but surfaces when running the full suite.
- [ ] KDI-UI-006: Pre-existing loader gaps — `boards`, `boards/new`, `activity`, `dispatch` loaders lack `isSvelteKitEnabled()` re-check (pre-date KDI-UI-006). The two touched loaders (`tasks/[id]`, `boards/[slug]`) comply; a blanket follow-up should close the rest.
- [ ] KDI-UI-005: `readHeadText` caps non-tail logs at 500KB but may split a trailing UTF-8 character at the byte boundary; trim trailing partial sequence if that becomes user-visible.
- [ ] KDI-UI-005: No HTTP smoke test forces `buildTaskContext` to throw, so `contextError: "not_available"` rendering is covered by unit tests only.
- [ ] Flaky test: `tests/commands/triage-automation.test.ts > specify --all sweeps triage tasks` fails intermittently when run in the full suite (passes in isolation). Likely a mock-server / timing interaction.

## SvelteKit UI Backlog - Drafted
- [x] Drafted UI backlog at `specs/sveltekit-ui-backlog.md` based on implemented Hermes/KDI parity features.
- [x] Linked frontend backlog from `specs/hermes-kanban-backlog.md`.
- [x] Registered planned `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` / `VITE_FF_SVELTEKIT_FRONTEND` in `specs/feature-flags.md`, default `false`.

## KDI-UI-003: Kanban Board View — Implemented
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-003-kanban-board-view.md`
- [x] Kanban board view renders nine status columns with counts, assignee, priority, tenant, age, status reasons, and stale/rate-limited markers
- [x] Filter bar reproduces `kdi list` filters: status, assignee, tenant, created-by, mine, session, archived, workflow template, step key, sort
- [x] Created `/boards/[slug]` route with a minimal board shell (header, archived tag, metadata) since KDI-UI-002 is not yet merged; consumes KDI-UI-001 data bridge endpoints
- [x] Extended KDI-UI-001 bridge: `/api/boards/[slug]/tasks` now returns the full `KanbanTask` camelCase shape (id, title, status, assignee, priority, tenant, createdBy, createdAt, updatedAt, scheduledAt, lastHeartbeatAt, blockReason, scheduleReason, reviewReason, rateLimitedUntil, workflowTemplateId, currentStepKey, sessionId, archivedAt); added `/api/profiles` endpoint for assignee dropdown population
- [x] Gated by `FF_SVELTEKIT_FRONTEND`; reuses CLI flags (`FF_LIST_FILTERS_SORT`, `FF_TENANT_NAMESPACE`, `FF_CREATED_BY`, `FF_ASSIGNEES_LISTING`, `FF_WORKFLOW_TEMPLATES`, `FF_RATE_LIMIT_EXIT_CODE`, `FF_HEARTBEAT`)
- [x] Root `/` redirects to `/boards/default` for a working default landing page
- [x] Added bridge unit tests for the Kanban task shape and `/api/profiles`; extended HTTP smoke test to fetch `/boards/[slug]` and assert the rendered HTML contains the task ID, title, and board name
- [x] Acceptance: UI reproduces `kdi list` filtered/sorted views against a temp `HOME`/`KDI_DB`; all builds pass (`bun run lint`, `bun run build`, `bun run check:web`, `bun run build:web`, `bun test`)

## KDI-UI-004: Task Create/Edit UI — Implemented
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-004-task-create-edit-ui.md`
- [x] Create form supports title, body, assignee, status, schedule time, priority, tenant, created-by, skills, model override, runtime, retries, workspace, session, workflow template + step key, goal mode, and parent dependencies
- [x] Edit form supports only `body` (the only field `editTask` currently supports)
- [x] Every optional field gated by the same CLI feature flag; no new flags
- [x] All UI mutations gated behind `FF_SVELTEKIT_FRONTEND` (server hook redirect + server action re-check)
- [x] Standalone routes: `boards/[slug]/tasks/new` and `boards/[slug]/tasks/[id]/edit`; no dependency on KDI-UI-003 board view
- [x] Server actions consume only the KDI-UI-001 bridge; no `bun:sqlite` or `~/models/*` imports in route/client files
- [x] Added bridge helpers: `editTaskJson`, `createTaskJson` parent linking, `taskFlags`, `getWorkflowTemplateJson`, `validateStepKeyBridge`, `profilesJson`, `parseDurationBridge`
- [x] Added bridge unit tests in `apps/web/src/lib/server/createEditTask.test.ts`
- [x] Added HTTP smoke tests in `apps/web/src/lib/server/createEditTask.http.test.ts` and updated `apps/web/src/lib/server/bridge.http.test.ts` to close the dev server before the CLI cross-check (fixes cross-process SQLite lock flakiness)
- [x] Review fixes: empty/whitespace optional fields (tenant, created-by, model override, workspace, session) are now rejected with the spec messages; edit route renders `Task <id> not found.` for missing tasks; bridge title error matches CLI (`Title is required.`); added HTTP smoke coverage for disabled per-field flags (AC-05) and empty-field rejection
- [x] Full verification with isolated `KDI_DB`: `bun install`, `bun run lint`, `bun run build`, `bun run check:web`, `bun run build:web`, `bun test` → **1023 pass / 0 fail**

## KDI-UI-005: Task Detail Panel — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-005-task-detail-panel.md`
- [x] Review fix: blocked-by-dependency visual indication (FR-10) — `TaskDetailPanel` shows a top-level "Blocked by dependencies" callout and a `blocking` badge on each non-done parent when the task is blocked
- [x] Review fix: surface `contextError` in the UI — `TaskDetailPanel` shows a "Context not available" callout when `taskDetailJson` returns `contextError: "not_available"`
- [x] Review fix: log tail no longer loads the whole file into memory — `taskLogJson` reads only the requested tail bytes from disk and aligns to a valid UTF-8 boundary; large non-tail logs are capped at 500KB without reading past the cap
- [x] Task detail page renders body, metadata, result, summary, comments, attachments, dependencies, context, runs, events, worker log, and worktree handoff
- [x] Aggregate endpoint returns full snapshot; specialized routes for log, dependencies, and handoff
- [x] Polling for events and log tail; run filtering when `FF_SHOW_RUN_FILTERING` is on
- [x] Smoke test with temp HOME/KDI_DB opens a CLI-created task and asserts the panel renders title, status, and body
- [x] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass

## KDI-UI-006: Task Lifecycle Actions — Done
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-006-task-lifecycle-actions.md`; all 30 acceptance criteria (AC-01..AC-30) verified against that spec
- [x] Single actions: promote (+dry-run/force), block, unblock, schedule, review, archive, complete (+metadata gate), assign, reassign (+reclaim), claim, reclaim, heartbeat — all via `performTaskAction` in `apps/web/src/lib/server/bridge.ts` (single choke point), calling the same model fns the CLI uses
- [x] Bulk actions: promote, block, unblock, schedule, archive, complete — `performBulkAction` loops the single-task core, returns per-task results + `{attempted,succeeded,skipped,failed}` summary
- [x] Server-side flag re-checks mirror CLI error text (`feature_disabled` 403); client gating via `lifecycleFlags()` capability map with flag/status tooltips
- [x] Master flag `FF_SVELTEKIT_FRONTEND` re-checked in `tasks/[id]` and `boards/[slug]` loaders via `isSvelteKitEnabled()`; JSON routes via `apiPost` to `gate()`
- [x] Per-action REST endpoints: `POST /api/boards/[slug]/tasks/[id]/{promote,...,heartbeat}` — action in URL path, body is fields, returns FR-21 shape; bulk: `POST .../tasks/actions`
- [x] Components: `TaskActions.svelte` (detail panel), `BulkActionsToolbar.svelte` (board), `TaskCard.svelte` checkbox selection — DESIGN.md compliant (tokens, `.btn`/`.badge`, focus-visible, prefers-reduced-motion, aria-live)
- [x] Tests: `task-lifecycle-actions.test.ts` (46 unit + 4 UTF-8 clamp + 1 multibyte heartbeat), `task-lifecycle-actions.http.test.ts` (3 HTTP smoke with `kdi show` cross-check), `handler.test.ts` (3 malformed-JSON), `e2e/lifecycle.e2e.ts` (3 incl. in-dialog role=alert error)
- [x] Verification: `bun run lint`, `bun run build`, `bun run check:web`, `bun run build:web` all pass; 1115/1115 `bun test` pass; 5/5 Playwright e2e pass
- [x] **PR #91 review (round 3) — all 4 findings fixed:**
  - **#1 (High, byte limit):** heartbeat note now clamped to a true 4 KiB **UTF-8 byte** budget at the server boundary (`clampUtf8Bytes` + `MAX_HEARTBEAT_NOTE_BYTES` in `bridge.ts`); UI counter switched from `note.length` to `TextEncoder` byte count with a live `{bytes}/4096` readout and dropped the misleading char-based `maxlength`. Multibyte unit tests (CJK 3-byte, emoji 4-byte) + integration test added. Model/CLI char-based cap left untouched (AC-27: no `src/models` churn) and tracked as tech debt below.
    - **Round 4 (surrogate split):** the byte-budget binary search operates on UTF-16 indices and could land mid-surrogate-pair (e.g. `"a".repeat(4093)+"🎯"` → index 4094 = lone high surrogate, corrupting the persisted note). Added an O(1) guard: if the selected index ends with a high surrogate (`& 0xfc00 === 0xd800`), back up one to a complete code point. Regression tests added for the exact ASCII+emoji split case and a pure-emoji inexact-boundary case; both assert no lone surrogate, no `\uFFFD`, and clean UTF-8 round-trip.
  - **#2 (High, error behind modal):** a failed single action now keeps the dialog open and renders the message in-dialog as `role="alert"` (`dialogError` in `TaskActions.svelte`); covered by Playwright (`failed action surfaces an in-dialog role=alert error`).
  - **#3 (Medium, a11y):** disabled action buttons use `aria-disabled` (not `disabled`) so they stay keyboard-focusable, with per-action `aria-describedby` → visually-hidden reason text; same fix on the bulk schedule button. `.btn[aria-disabled="true"]` mirrors the `:disabled` style.
  - **#4 (Medium, 400 vs 500):** the shared `apiPost` factory in `handler.ts` now maps malformed/empty JSON to a stable `400 invalid_json` instead of leaking a `SyntaxError` through the generic 500 path (one guard, all 16+ POST routes). Covered by `handler.test.ts`.

## KDI-UI-000: SvelteKit App Shell — InDev
- [x] Scaffolded SvelteKit app under `apps/web/` (Bun workspaces); repo root `package.json` gains `workspaces` and `dev:web` / `build:web` / `check:web` / `preview:web` scripts. CLI `build`/`lint` unchanged.
- [x] Pinned live-compatible versions: svelte `5.56.4`, `@sveltejs/kit` `2.68.0`, `@sveltejs/vite-plugin-svelte` `7.1.2`, vite `8.1.0`, `@sveltejs/adapter-node` `5.5.7`, svelte-check `4.7.1` (peers verified live).
- [x] Restricted product UI shell: board switcher, left navigation, main work area, command/action bar, flag badge (`apps/web/src/routes/+layout.svelte`).
- [x] Feature flag handling: server hook `apps/web/src/hooks.server.ts` redirects to `/disabled` while `FF_SVELTEKIT_FRONTEND != "true"`; `FlagBadge` reads `VITE_FF_SVELTEKIT_FRONTEND`.
- [x] Stub routes: `/` board placeholder (KDI-UI-003) and catch-all placeholder for unbuilt nav views (tasks/dispatch/activity/stats).
- [x] `bun run lint` (CLI `tsc --noEmit`: clean), `bun run build` (CLI binary: 121 modules), `bun run build:web` (adapter-node), `bun run check:web` (svelte-check 0/0), `bun run dev:web` (vite) all pass.
- [x] Dev smoke with isolated env: flag-off `GET /` → 307 `/disabled`; flag-on `GET /` → 200 shell (`Board: default`, `board-switcher`, badge).
- [x] `bun test` (938 pass / 0 fail) — CLI suite unaffected.
- [x] Promoted `ff_sveltekit_frontend` to `InDev` (default `false`) in `specs/feature-flags.md`; updated `AGENTS.md` repo rules + verified stack versions for the `apps/web` workspace.
- [x] Specs drafted for next items:
  - `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`
  - `specs/sveltekit-ui/KDI-UI-002-board-management.md`
  - `specs/sveltekit-ui/KDI-UI-003-kanban-board-view.md`
  - `specs/sveltekit-ui/KDI-UI-004-task-create-edit-ui.md`
  - `specs/sveltekit-ui/KDI-UI-005-task-detail-panel.md`
  - `specs/sveltekit-ui/KDI-UI-006-task-lifecycle-actions.md`
  - `specs/sveltekit-ui/KDI-UI-007-dispatch-control-center.md`
  - `specs/sveltekit-ui/KDI-UI-008-live-activity-view.md`
  - `specs/sveltekit-ui/KDI-UI-009-stats-diagnostics-ui.md`
  - `specs/sveltekit-ui/KDI-UI-010-notification-subscriptions-ui.md`
  - `specs/sveltekit-ui/KDI-UI-011-triage-automation-ui.md`
  - `specs/sveltekit-ui/KDI-UI-012-swarm-builder.md`
  - `specs/sveltekit-ui/KDI-UI-013-workflow-templates-ui.md`
  - `specs/sveltekit-ui/KDI-UI-014-goal-mode-ui.md`
  - `specs/sveltekit-ui/KDI-UI-015-accessibility-keyboard-baseline.md`
  - `specs/sveltekit-ui/KDI-UI-016-end-to-end-ui-smoke-loop.md`
- [ ] Next implementation: P1 task detail and lifecycle UI (KDI-UI-005/006/007) consuming the merged KDI-UI-001 bridge, then observability and end-to-end smoke loop (KDI-UI-016). Specs drafted for P3/P4 items KDI-UI-013, KDI-UI-015, and KDI-UI-016 in PR #66.

## KDI-UI-001: Server-Side Data Bridge — Implemented (PR #69)
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`
- [x] SvelteKit server routes call existing `src/models/*` for boards, tasks, events, runs, context, comments, attachments, diagnostics, workflows, notifications (read) and board/task create (write) — `apps/web/src/routes/api/**/+server.ts` backing a single choke point `apps/web/src/lib/server/bridge.ts`. No new model/SQL created; models imported read-only.
- [x] Bridge imports models via the `~/*` alias the CLI already uses (spec FR-1), wired once via `kit.alias` in `apps/web/svelte.config.js` (`~ -> ../../src`); SvelteKit auto-generates the matching vite + tsconfig aliases (no manual tsconfig `paths`, which would clash with the generated one). Confirmed green under svelte-check, `bun test` (root tsconfig `~/*->src/*`), and the adapter-node build.
- [x] `logs` (in scope but absent from the Resource Map and with no `src/models/*` reader — worker logs are file paths in `src/observability.ts`) surfaced as the spec's prescribed escape hatch: `GET /api/boards/[slug]/tasks/[id]/logs` returns `501 {error:"not_implemented", reason:"model gap..."}`. A real logs route is a follow-up backlog item (alongside `ff_worker_log_capture`).
- [x] All responses JSON + camelCase (one `toCamel` helper + typed `CamelCase<T>` mirror so responses are genuinely typed, not fake-cast onto snake_case interfaces); SQLite stays server-side only — guard test scans the route tree and fails if any non-bridge file imports `bun:sqlite` or model modules (`~/models/*` or relative `../src/models/`).
- [x] `KDI_DB`/`KDI_DB_PATH`/default resolution honored server-side via `initDb()` (env inherited, `src/db.ts` unchanged); `FF_SVELTEKIT_FRONTEND=false` disables writes and signals disabled for reads — `/api/*` returns `503 {enabled:false}` (hook exempted `/api/*` from the `/disabled` redirect so feature-detect works); HTTP smoke confirmed flag-off POST 503 and wrote NO board.
- [x] Bridge unit smoke (`apps/web/src/lib/server/bridge.test.ts`, 10 tests) calls bridge functions directly under the Bun runtime against temp HOME/KDI_DB and cross-checks JSON against `showTask`/`showBoard` model source of truth; also guards the SQLite-server-side rule by scanning the route tree for `bun:sqlite` / `~/models/*` imports.
- [x] HTTP end-to-end smoke (`apps/web/src/lib/server/bridge.http.test.ts`) spawns the real `bun run dev:web` server against temp HOME/KDI_DB, hits POST/GET boards + tasks + show + logs over HTTP (201/200/501), and CLI cross-checks the created task via `showTask` on the same DB; verifies flag-off POST returns 503 and writes nothing. This is the spec's actual acceptance path.
- [ ] **Runtime wiring note:** the bridge imports CLI models that pull `bun:sqlite`, which only the Bun runtime can load. SvelteKit SSR otherwise runs under Node and 500s on every data route. The root `dev:web` / `preview:web` scripts now force Bun via `bun --bun`; the adapter-node **production** build must be **run with `bun apps/web/build/index.js`, not `node`** (running it with `node` 500s on every `/api/*` route). Follow-up: consider `@sveltejs/adapter-bun` to make the prod entry Bun-native and drop the `--bun` / `node`-vs-`bun` footgun.
- [x] `bun run lint` (CLI tsc --noEmit clean), `bun run build` (CLI 122 modules), `bun run check:web` (svelte-check 0/0), `bun run build:web` (adapter-node, `bun:sqlite` emitted external), and `bun test` (970 pass / 0 fail) all pass with isolated `KDI_DB`. `src/` unchanged except `src/flags.ts` (registered `FF_SVELTEKIT_FRONTEND`).
- [x] **Follow-up cleanup (PR #71):** `FF_SVELTEKIT_FRONTEND` is now registered in `src/flags.ts` (default `false`, status `InDev`); the server hook and bridge gate both use `isEnabled(FF_SVELTEKIT_FRONTEND)` instead of ad-hoc `process.env` reads, so the UI honors the same env/registry override contract as every other KDI feature.

## KDI-UI-002: Board Management UI — Implemented
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-002-board-management.md` and reconciled: `/boards` is the list route, `/boards/[slug]` is the detail route, and the current board is highlighted in the list (AC-04 updated to match implemented route structure).
- [x] SvelteKit routes implemented: `/boards` (list + archived toggle + current badge), `/boards/[slug]` (detail + actions), `/boards/new` (create), `/boards/[slug]/edit` (metadata + default workdir).
- [x] Board actions implemented: switch, rename display name, rename slug, archive, hard-delete (flag-gated) via SvelteKit form actions on `/boards/[slug]` and `/boards/[slug]/edit`.
- [x] Flag gating: `FF_SVELTEKIT_FRONTEND` gates the whole UI; per-action flags (`FF_BOARD_METADATA`, `FF_BOARD_CREATE_SWITCH`, `FF_BOARD_SWITCH`, `FF_BOARD_RENAME_HERMES`, `FF_BOARD_RENAME`, `FF_DEFAULT_WORKDIR`, `FF_BOARD_RM_DELETE`) re-checked server-side and reflected client-side.
- [x] Bug fix: edit-form metadata/default-workdir action URLs corrected to `/boards/[slug]/edit?/...` and the metadata action now skips empty optional fields so unchanged icon/color inputs do not cause empty-string rejections.
- [x] AC-21 UI smoke test added at `apps/web/src/lib/server/board-management.http.test.ts`: spawns the real `bun run dev:web` server against a temp `HOME` + `KDI_DB`, runs `init → create board via UI form → show detail → switch → edit → set/clear default workdir → rename display name → rename slug → archive → hard-delete with wrong-then-right typed slug`, and cross-checks every mutation with the CLI on the same DB.
- [x] `bun run lint`, CLI `bun run build`, `bun run check:web`, `bun run build:web`, and the full `bun test` suite pass with isolated `KDI_DB`.

## KDI-UI-011: Triage Automation UI — Spec
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-011-triage-automation-ui.md`
- [ ] `/triage` route lists triage tasks with Specify, Specify manually, and Decompose actions
- [ ] Single-task and sweep actions for `specify` and `decompose`, including tenant-filtered variants
- [ ] LLM configuration, progress, and blocking feedback on LLM/validation errors
- [ ] Server actions call existing `specifyTaskWithLlm`, `specifyTask`, `decomposeTask`, and `callTriageLlm` directly; no new CLI/model/LLM code
- [ ] UI smoke with temp HOME/KDI_DB asserts list matches `kdi list --status triage` and actions update task states
- [ ] `bun run lint`, CLI build, SvelteKit build pass with isolated `KDI_DB`

## KDI-UI-008: Live Activity View — Done
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-008-live-activity-view.md`
- [x] `/activity` page renders a board-wide live event stream with pause/resume
      and manual refresh
- [x] Filter controls for assignee, tenant, kinds, and poll interval when
      `FF_WATCH_FILTERS=true`
- [x] Per-task event tail and worker log panel reusing KDI-UI-001/005 routes
- [x] Server-side filter gating in `boardEventsJson` (FF_WATCH_FILTERS, FF_TENANT_NAMESPACE):
      rejects assignee/kinds/tenant with `400 feature_disabled` when the flag is off
      (AC-16); events are scoped to the resolved board so `/api/boards/a/events`
      cannot disclose board B events
- [x] Poll interval clamped to min 0.5s and NaN-guarded; state + shareable URL are
      normalized, not just the scheduler (AC-17)
- [x] Distinct "No matching events" (filters active) vs "No events yet" empty states,
      plus distinct error + retry states so 5xx/network failures are not masked as
      "Task not found" / "No events yet" / "No log captured yet" (AC-11, AC-18)
- [x] Overlapping filter/task requests are generation-guarded so stale responses
      cannot populate a newer task pane or reinsert prior-filter events
- [x] `getEventsAfter` honors an optional limit; the route bounds `since` queries to
      1–200 so a resumed tab cannot pull an unbounded backlog
- [x] Smoke test with temp HOME/KDI_DB creates a task via the CLI, generates events
      (create, promote), and asserts the activity stream reads them (AC-14)
- [x] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
      with isolated `KDI_DB`; full suite `bun run test` = 1058 pass / 0 fail and
      terminates cleanly (HTTP smoke spawns the dev server in its own process group)
- [x] Hydrated-browser regression (Playwright `bun run test:web:e2e`, `@playwright/test@1.61.1`):
      AC-14 proves CLI-written events render after client-side fetch; P1-1 proves
      a stale board-A response (route-intercepted and held, then released after
      navigating to board B) cannot populate board B — verified to fail without
      the boardGen guard. Surfaced and fixed a real hydration bug (the poll
      `$effect` read+wrote the timer `$state`, an infinite
      `effect_update_depth_exceeded` loop on hydration; timer handles are now
      plain non-reactive vars).

## KDI-UI-009: Stats and Diagnostics UI — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-009-stats-diagnostics-ui.md`
- [ ] Show per-status counts, per-assignee counts, oldest-ready age, and health diagnostics
- [ ] Severity filter and task-specific diagnostics
- [ ] Action shortcuts for diagnostics actions: reclaim, reassign, unblock, comment, open docs/CLI hint
- [ ] Acceptance: UI output matches `kdi stats --json` and `kdi diagnostics --json`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass with isolated `KDI_DB`

## KDI-UI-010: Notification Subscriptions UI — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-010-notification-subscriptions-ui.md`
- [ ] List global and per-task subscriptions
- [ ] Subscribe/unsubscribe with platform, chat id, thread id, user id, and notifier profile
- [ ] Include archived/unsubscribed toggle
- [ ] Acceptance: covers `notify-subscribe`, `notify-list`, and `notify-unsubscribe`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass with isolated `KDI_DB`

## KDI-UI-007: Dispatch Control Center — Spec
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-007-dispatch-control-center.md`
- [x] `/dispatch` page renders dispatcher presence, ready/running counts, profile
      health, recent spawn failures, and a one-shot dispatch form
- [x] Server action calls `tick()` directly with `max`, `failureLimit`, and
      `rateLimitCooldown` options; returns spawned/blocked/skipped/failed/processed
      breakdown
- [x] Profile health/repair card gated by `FF_REAL_HARNESS_PROFILES`
- [x] Smoke test with temp HOME/KDI_DB creates a ready task and triggers one-shot
      dispatch from the UI, asserting the counts update
- [x] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass

## KDI-UI-012: Swarm Builder — Spec
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-012-swarm-builder.md`
- [ ] `/swarm` page renders a form for workers, verifier, synthesizer, and shared fields
- [ ] Dry-run preview uses `planSwarmGraph` and matches `kdi swarm --dry-run`
- [ ] Create action uses `createSwarmGraph` and redirects to board view or orchestrator detail
- [ ] Server-side validation mirrors the CLI; gated by `FF_SWARM_MODE` and `FF_SVELTEKIT_FRONTEND`
- [ ] Smoke test with temp HOME/KDI_DB creates a swarm through the UI and asserts parity with `kdi swarm`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass

## KDI-UI-013: Workflow Templates UI — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-013-workflow-templates-ui.md`
- [ ] `/boards/[slug]/workflows` route lists templates and provides a define/upsert form
- [ ] Quick-create action on each template row creates a task via `createTask` with the template and an optional step key
- [ ] Step action on task detail page advances or jumps workflow steps with an optional reason
- [ ] Server-side validation mirrors the CLI; gated by `FF_WORKFLOW_TEMPLATES` and `FF_SVELTEKIT_FRONTEND`
- [ ] UI smoke with temp HOME/KDI_DB defines templates, creates tasks from templates, and steps tasks; matches `kdi workflows list`/`kdi show`/`kdi step`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass with isolated `KDI_DB`

## KDI-UI-014: Goal Mode UI — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-014-goal-mode-ui.md`
- [ ] Goal-mode indicator/badge on board view task cards when `FF_GOAL_MODE=true`
- [ ] Dedicated goal-mode card on task detail panel showing max turns, remaining turns, and judge profile
- [ ] Goal-turn event timeline rendering verdicts (`continue`, `done`, `exhausted`) and notes
- [ ] "Create goal-mode task" shortcut linking to create form with goal mode pre-selected
- [ ] Acceptance: UI is hidden when `FF_GOAL_MODE=false` and unavailable when `FF_SVELTEKIT_FRONTEND=false`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass

## KDI-UI-015: Accessibility and Keyboard Baseline — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-015-accessibility-keyboard-baseline.md`
- [ ] Skip link, visible focus states, and landmark regions in app shell
- [ ] Labels and ARIA names on all form inputs and icon-only buttons
- [ ] Keyboard-operable board view, filters, forms, and action menus
- [ ] ARIA live region for status announcements and loading states
- [ ] `prefers-reduced-motion` support and contrast/focus contract
- [ ] Playwright tests use stable role/name selectors; no CSS-class-based assertions
- [ ] Keyboard smoke test covers core operator path
- [ ] `bun run check:web` and `bun run build:web` pass

## KDI-UI-016: End-to-end UI Smoke Loop — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-016-end-to-end-ui-smoke-loop.md`
- [ ] Hermetic smoke test uses temp HOME and temp KDI_DB
- [ ] Real path: init → create board → create task → promote → dispatch once → inspect result/log/events → archive
- [ ] CLI-created task is visible in UI board view and detail panel
- [ ] UI-created task is visible in `kdi show` / `kdi list`
- [ ] No new UI screens, CLI commands, or flags; only a test harness and no-op smoke profile
- [ ] `bun run lint`, CLI build, `bun run build:web`, and `bun run check:web` pass

## KDI-055: Worktree Handoff — Done
- [x] BRD finalized at `specs/brd-kdi-055-worktree-handoff.md`
- [x] Feature flag `ff_worktree_handoff` / `FF_WORKTREE_HANDOFF` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `true`
- [x] `src/worktree.ts` exposes `detectWorktreeChanges()` helper
- [x] Dispatcher checks successful task worktrees for uncommitted changes or commits ahead of the board base ref when `FF_WORKTREE_HANDOFF=true`
- [x] Successful worktrees with changes preserve the `wt/<profile>/<task_id>` branch and worktree; a `worktree_handed_off` event records the branch and worktree path, and the board log receives operator-facing handoff message
- [x] Successful worktrees with no changes continue to be cleaned up as today
- [x] When `FF_WORKTREE_HANDOFF=false`, existing cleanup behavior is unchanged
- [x] Original board workdir is never modified by this feature
- [x] Unit tests in `tests/worktree.test.ts` cover clean, untracked, modified, and committed-change detection plus handoff metadata
- [x] Dispatcher integration tests in `tests/dispatcher.test.ts` cover preserve-with-changes, cleanup-without-changes, and disabled-flag fallback
- [x] User-loop smoke test with temp `HOME`/`KDI_DB` proves real CLI dispatch preserves the worktree/branch and leaves the original repo clean
- [x] `bun run lint`, `bun test` (**938 pass / 0 fail**), `bun run build` pass

## KDI-056: Real Harness Profiles — Done
- [x] Added KDI-056 backlog item for real Pi/opencode harness profile bootstrap/doctor support after local smoke showed user-level profiles can point to stale `/tmp/mock-harness` and block dispatch with exit 127.
- [x] BRD drafted at `specs/brd-kdi-056-real-harness-profiles.md` (gated behind `ff_real_harness_profiles` / `FF_REAL_HARNESS_PROFILES`, default `false`).
- [x] Flag `ff_real_harness_profiles` / `FF_REAL_HARNESS_PROFILES` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`.
- [x] `resolveCommandBinary()` pure helper in `src/profiles.ts` resolves a profile's leading binary against `PATH` (no shell exec).
- [x] `kdi profiles doctor [--json]` reports per-profile health (`ok` / `missing-binary` / `parse-error`) and exits non-zero when any profile is unhealthy.
- [x] `kdi profiles bootstrap [--force]` writes known-good `opencode`+`pi` entries, preserving other entries and (without `--force`) existing `opencode`/`pi`.
- [x] Pre-claim dispatcher guard (in `src/dispatcher.ts`): when the flag is on, a task whose profile binary is missing is NOT claimed, no worktree is created, a `profile_invalid` event is recorded with `{ profile, binary }`, and an operator-facing hint is written to the board log; the task stays `ready`.
- [x] Harness env/template contract documented in `specs/harness-contract.md` (every `KDI_*` env var, every `{{template}}`, `.kdi-result.txt` convention).
- [x] Unit tests in `tests/profiles.test.ts` for `resolveCommandBinary`, `doctorProfiles`, `bootstrapRealProfiles`; dispatcher guard tests in `tests/dispatcher.test.ts` (skip-claim on missing binary, claim when binary resolves, no-op when flag off); CLI tests in `tests/commands/profiles.test.ts`.
- [x] User-loop smoke with temp `HOME`/`KDI_DB`: flag-on dispatch against a `/tmp/mock-harness` profile leaves the task `ready` with a `profile_invalid` event and no run; flag-off dispatch claims, spawns, and records `exit 127` (current behavior unchanged).
- [x] Real `opencode`/`pi` install smoke: `profiles bootstrap` repairs stale profiles to real `/opt/homebrew/bin/opencode` and `/opt/homebrew/bin/pi`; `profiles doctor` reports both as `ok`; dispatch against a resolvable binary reaches `done`; dispatch against `/tmp/nonexistent-harness` leaves task `ready` with `profile_invalid`.
- [x] `bun run lint`, `bun test` (**959 pass / 0 fail**), `bun run build` pass
- [x] Promoted `ff_real_harness_profiles` / `FF_REAL_HARNESS_PROFILES` to **Active** (default `true`) in `src/flags.ts` and `specs/feature-flags.md`
- [x] Updated `STATUS.md` to mark KDI-056 complete
- [ ] Pending: collect operator feedback on `claude`/`codex` bootstrap.

## KDI-052: Stabilize Test Suite — Done
- [x] Reproduced intermittent failure in `worker log capture > spawnHarness writes combined stdout/stderr to log file`
- [x] Root cause: `spawnHarness` resolved before `logStream.end()` flushed data, so immediate file reads could observe partial logs
- [x] Added regression coverage for large combined stdout/stderr log output
- [x] Fixed `spawnHarness` to wait for log stream flush before resolving/rejecting while keeping log-write failures best-effort
- [x] Verification: `bun run lint`, `bun run test` (931 pass / 0 fail), `bun run build` pass

## End-User Rollout — Feature Flags Promoted to Active
- [x] Hermes Kanban parity smoke test completed (create → promote → dispatch --once → done, result captured, worktree cleaned)
- [x] Promoted stable feature flags to **Active** (default `true`) in `src/flags.ts`:
  - Core dispatch: `FF_ENABLE_KANBAN_DISPATCH`, `FF_DISPATCH_ONCE`, `FF_DISPATCH_CONTROLS`, `FF_DISPATCHER_PRESENCE_WARNING`
  - Harness context/results: `FF_HARNESS_CONTEXT`, `FF_RESULT_SUMMARY`, `FF_WORKER_LOG_CAPTURE`
  - Task lifecycle: `FF_SCHEDULED_STATUS`, `FF_REVIEW_STATUS`, `FF_HEARTBEAT`, `FF_CRASH_GRACE_PERIOD`, `FF_RATE_LIMIT_EXIT_CODE`, `FF_MAX_RUNTIME`, `FF_MAX_RETRIES`, `FF_ASSIGN_REASSIGN`, `FF_LINK_UNLINK`, `FF_CREATE_PARENT`, `FF_BULK_OPERATIONS`, `FF_COMPLETE_METADATA`, `FF_PRIORITY_INTEGER`, `FF_TAIL_NO_FOLLOW`
  - Task metadata: `FF_CREATED_BY`, `FF_TENANT_NAMESPACE`, `FF_SKILLS_ARRAY`, `FF_MODEL_OVERRIDE`, `FF_TASK_ATTACHMENTS`, `FF_COMMENT_ENHANCEMENTS`, `FF_LIST_FILTERS_SORT`
  - Board management: `FF_BOARD_METADATA`, `FF_BOARD_SWITCH`, `FF_BOARD_CREATE_SWITCH`, `FF_GLOBAL_BOARD`, `FF_BOARD_RENAME`, `FF_BOARD_RENAME_HERMES`, `FF_DEFAULT_WORKDIR`
  - Observability/context: `FF_STATS`, `FF_GC`, `FF_ASSIGNEES_LISTING`, `FF_DIAGNOSTICS`, `FF_CONTEXT_BUILDER`, `FF_SHOW_RUN_FILTERING`, `FF_RUNS_FILTERING`, `FF_WATCH_FILTERS`
  - Workflows: `FF_WORKFLOW_TEMPLATES`
- [x] Flags left **InDev** (default `false`) for safety/bake time: `FF_BOARD_RM_DELETE`, `FF_NOTIFY_SUBS`, `FF_TRIAGE_AUTOMATION`, `FF_SWARM_MODE`, `FF_GOAL_MODE`
- [x] Updated `specs/feature-flags.md` registry statuses and added rollout notes
- [x] Full verification: `bun run lint`, `bun test`, `bun run build` pass

## Hermes Kanban Autonomous Completion Smoke Test — Worktree Cleanup Fix
- [x] End-to-end user-loop smoke test with temp `HOME`/`KDI_DB`: create board → create task → promote → `kdi dispatch --once` → task reaches `done`
- [x] Verified task result/summary capture via `FF_RESULT_SUMMARY` and `.kdi-result.txt`
- [x] Discovered bug: `removeWorktree` failed when harnesses left untracked files (e.g. `.kdi-result.txt`), leaving orphaned `wt/<profile>/<id>` worktrees and branches
- [x] Fixed `src/worktree.ts` to use `git worktree remove --force` for kdi-owned ephemeral worktrees
- [x] Added regression test in `tests/worktree.test.ts` for cleanup with untracked files
- [x] Full verification: `bun run lint`, `bun test` (**929 pass / 0 fail**), `bun run build` pass

## Hermes Kanban Parity — KDI-046 (Done)
- [x] BRD drafted at `specs/brd-kdi-046-boards-rename-semantics.md`
- [x] Feature flag `ff_board_rename_hermes` / `FF_BOARD_RENAME_HERMES` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `kdi boards rename <slug> <name>` implemented: updates `boards.name` only; slug, data directory, and current-board file untouched
- [x] `kdi boards rename-slug <old-slug> <new-slug>` implemented: preserves existing slug-rename behavior
- [x] Model function `renameBoard` renamed to `renameBoardSlug`
- [x] Unit/e2e tests and user-loop smoke pass
- [x] `bun run lint`, `bun test` (863 pass), `bun run build` pass

## KDI-047..049 Consolidated — Done
- [x] KDI-047: Bulk `kdi unblock <id>...` implemented with per-task reporting and tests
- [x] KDI-048: Bulk `kdi archive <id>...` implemented behind `FF_BULK_OPERATIONS` with tests
- [x] KDI-049: Non-following `kdi tail --lines N` / `--no-follow` implemented behind `FF_TAIL_NO_FOLLOW` with tests
- [x] `bun run lint`, `bun run test` (873 pass), and `bun run build` pass on consolidated branch
- [x] Verified KDI-046, KDI-048, KDI-049 are already implemented in `main` behind their respective flags; discarded redundant specs.

## KDI-050: Ensure `default` Board Exists After `kdi init` — Done
- [x] BRD drafted at `specs/brd-kdi-050-init-default-board.md`
- [x] Reviewed BRD against `src/commands/init.ts`, `src/models/board.ts`, `src/db.ts`, and `src/resolveBoard.ts`
- [x] `kdi init` creates active `default` board when missing
- [x] Idempotency: repeated `kdi init` does not error or duplicate
- [x] Default board workdir set to `<kdi_data_dir>/boards/default`
- [x] `kdi boards show` and `kdi create` work immediately after `kdi init`
- [x] Unit/e2e tests and user-loop smoke pass
- [x] `bun run lint`, `bun run test` (910 pass), `bun run build` pass

## KDI-052: Pass Task Title/Body to Harness — Done
- [x] Feature flag `ff_harness_context` / `FF_HARNESS_CONTEXT` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] Added `title` and `body` to `ALLOWED_TEMPLATES` in `src/profiles.ts`
- [x] Updated `substituteCommand` in `src/profiles.ts` to accept and substitute `{{title}}` and `{{body}}`
- [x] Updated `src/dispatcher.ts` `tick` to pass `title` and `body` into `substituteCommand` only when `FF_HARNESS_CONTEXT` is enabled
- [x] Updated `src/dispatcher.ts` `harnessEnv` to set `KDI_TASK_TITLE`, `KDI_TASK_BODY`, `KDI_TASK_ID`, and `KDI_BOARD` only when `FF_HARNESS_CONTEXT` is enabled
- [x] Added tests in `tests/profiles.test.ts` for `{{title}}`/`{{body}}` validation and substitution
- [x] Added tests in `tests/dispatcher.test.ts` for `{{title}}`/`{{body}}` command substitution and `KDI_TASK_*` env vars, including null-body handling and disabled-flag behavior
- [x] Updated existing dispatcher tests that previously expected an undefined env object when no optional env vars were set
- [x] `bun run lint`, `bun run test`, and `bun run build` pass

## Hermes Kanban Parity Verification — 2026-06-20/21 (in progress)
- [x] Live CLI verification run via `kdi-new-feature-loop` with temp `HOME`/`KDI_DB` and all feature flags enabled.
- [x] ~~Critical bug: global/subcommand `--board` flag is ignored; only `KDI_BOARD` env and current-board file resolve correctly.~~ **Fixed by KDI-042.**
- [x] Critical bug: `src/flags.ts` contained unresolved git merge conflict markers that broke `bun run build`/`dev`; resolved during verification.
- [x] Additional verified gaps documented in `specs/hermes-kanban-backlog.md` (KDI-042 through KDI-052); **KDI-043 is done**.
- [x] Test suite health: `bun run lint` passes; `bun test` reports **867 pass / 0 fail** (867 tests, 41 files) when run with isolated `KDI_DB`.
- [x] **Real harness end-to-end test with opencode**: dispatcher creates worktree `wt/opencode/1`, spawns `opencode run`, agent edits `README.md`, task moves to `done`. Verified worktree isolation, log capture, and run recording.
- [x] KDI-052: Pass task title/body/context to harnesses implemented.
- [x] KDI-053: Clean result/summary capture from harness output implemented.
- [x] KDI-054: Real harness parity test added (opt-in via `KDI_REAL_HARNESS_TEST=true`).

## KDI-052 / KDI-053 / KDI-054: Hermes Parity Bundle — Done
- [x] Feature flags `ff_harness_context` / `FF_HARNESS_CONTEXT` and `ff_result_summary` / `FF_RESULT_SUMMARY` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `ALLOWED_TEMPLATES` and `substituteCommand` support `{{title}}`, `{{body}}`, and `{{result_file}}`
- [x] Dispatcher exports `KDI_TASK_TITLE`, `KDI_TASK_BODY`, `KDI_TASK_ID`, `KDI_BOARD`, and `KDI_RESULT_FILE` to harnesses when flags are enabled
- [x] Pure helper `extractHarnessResult()` in `src/harnessResult.ts` reads `.kdi-result.txt` or parses the last JSON text chunk from stdout
- [x] Dispatcher stores clean result/summary on successful harness runs when `FF_RESULT_SUMMARY` is enabled
- [x] Opt-in real harness parity test at `tests/real-harness-parity.test.ts` (gated by `KDI_REAL_HARNESS_TEST=true`); test creates a fake `opencode` harness, a real git repo, a KDI board, task, and dispatcher daemon; asserts the harness receives expected task context env vars and writes a marker file in the active worktree; asserts the task transitions to `running`, then `done` after a sentinel file is written, and `kdi show` contains the clean result
- [x] `bun run lint`, `bun run build`, and targeted tests pass

## KDI-045: `kdi create --parent` — Done
- [x] BRD drafted at `specs/brd-kdi-045-create-parent.md`
- [x] Feature flag `ff_create_parent` / `FF_CREATE_PARENT` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi create <title> --parent <task_id>` repeatable option added to `src/commands/tasks.ts`
- [x] Each `--parent` value creates a parent-\u003echild dependency via `addDependency`
- [x] Missing parents, self-dependencies, and circular dependencies rejected with clear errors
- [x] Duplicate parent links are idempotent (ignored on UNIQUE constraint)
- [x] Unit tests in `tests/create-parent.test.ts` cover single parent, multiple parents, flag gating, missing parent, self-dependency, circular dependency, and idempotency with `--idempotency-key`
- [x] `bun run lint`, `bun test tests/create-parent.test.ts`, and `bun run build` pass

## Bulk `kdi unblock` (KDI-047) — Done
- [x] BRD drafted at `specs/brd-kdi-047-unblock-bulk.md`
- [x] `kdi unblock <id1> <id2>...` unblocks or readies multiple tasks at once
- [x] Per-task success/skip reporting with summary line
- [x] Exit 1 when any task is skipped
- [x] Single-task behavior preserved
- [x] Update `specs/hermes-kanban-backlog.md` KDI-047 status and feature mapping
- [x] Unit/CLI tests cover single-task, bulk, mixed-status, missing, and archived cases
- [x] `bun run lint`, `bun run test`, `bun run build` pass
- [x] User-loop smoke proven with temp `HOME` and temp `KDI_DB`

## Dispatcher Presence Warning (KDI-037) — Done
- [x] BRD drafted at `specs/brd-kdi-037-dispatcher-presence-warning.md`
- [x] Feature flag `ff_dispatcher_presence_warning` / `FF_DISPATCHER_PRESENCE_WARNING` registered in `src/flags.ts` and `specs/feature-flags.md`, default **Active** (`true`)
- [x] `src/dispatcherPresence.ts` exposes `getDispatcherPidPath(slug)` and `isDispatcherPresent(slug)`; `isDispatcherPresent` returns `true` only when the PID file exists, is readable, contains a single positive integer, and `process.kill(pid, 0)` succeeds — any other condition returns `false`
- [x] `kdi create <title> [--no-dispatcher-warning]` option added to `src/commands/tasks.ts`; warning is printed to stderr (single line via `console.warn`) after the board is resolved and before the task is created, only when the flag is on AND `--no-dispatcher-warning` is not set
- [x] Warning is non-blocking: task ID is still printed to stdout and the command exits `0`
- [x] Unit tests in `tests/dispatcherPresence.test.ts` cover missing, empty, non-numeric, negative, zero, dead-PID, live-PID, and non-existent-board-slug cases
- [x] CLI tests in `tests/commands/tasks.test.ts` (KDI-037 describe block) cover flag-on/live, flag-on/missing, flag-on/dead, flag-on/malformed, `--no-dispatcher-warning` suppression, and flag-off/option-accepted
- [x] User-loop smoke proven with temp `HOME` and temp `KDI_DB`: warning appears on no-PID/dead-PID, suppressed on live-PID, suppressed by `--no-dispatcher-warning`, and absent when flag is off
- [x] `bun run lint`, `bun test tests/dispatcherPresence.test.ts tests/commands/tasks.test.ts`, and `bun run build` pass; full suite (807 tests) passes
- [x] Out of scope (deferred): dispatcher writes per-board PID marker at startup and removes it on clean shutdown (separate scope)

## Global `--board` Flag Resolution (KDI-042) — Done
- [x] Root Commander program registers `--board <slug>` as a global option in `src/index.ts`
- [x] `preAction` hook copies the global `--board` value into `KDI_BOARD` when the subcommand does not provide its own `--board`; gated by `FF_GLOBAL_BOARD`
- [x] Subcommand `--board` continues to take precedence over the global `--board`
- [x] Resolution chain honored: explicit `--board` flag (global or subcommand) → `KDI_BOARD` env → current-board file → `"default"`
- [x] `kdi dispatch` accepts `--board <slug>` and filters the one-shot/daemon tick to that board
- [x] E2e coverage in `tests/global-board.test.ts` proves global `--board` works for `create`, `list`, `show`, `dispatch`, and `swarm`
- [x] Feature flag `FF_GLOBAL_BOARD` remains registered and defaults to `false`
- [x] `bun run lint`, `bun run test`, and `bun run build` pass in the worktree with isolated `KDI_DB`

## Triage Automation (KDI-040) — Done
- [x] BRD drafted at `specs/brd-kdi-040-triage-automation.md` to match LLM-powered triage automation semantics
- [x] Feature flag `ff_triage_automation` / `FF_TRIAGE_AUTOMATION` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `kdi specify` LLM path and `kdi decompose` command in `src/commands/tasks.ts`; `kdi decompose` wired into `src/index.ts`
- [x] `specifyTaskWithLlm()` / `decomposeTask()` model helpers in `src/models/task.ts`
- [x] OpenAI-compatible LLM client and prompt builders in `src/llm.ts`
- [x] `--all` and `--tenant` sweep modes for both commands
- [x] `--skip-llm` escape hatch preserves manual `kdi specify` behavior
- [x] Invalid LLM responses block tasks with clear reasons; invalid decomposition blocks parent with no children created
- [x] `specified` event gains `{ llm: true }` payload; new `decomposed` event kind
- [x] Unit and CLI tests covering flag gating, LLM success/failure paths, `--all`, `--tenant`, decomposition validation, and `--skip-llm`
- [x] `bun run lint` and `bun run build` pass; new tests pass; full suite matches existing flaky baseline

## Swarm Mode (KDI-041) — Done
- [x] BRD revised at `specs/brd-kdi-041-swarm-mode.md` to match multi-agent task graph semantics
- [x] Feature flag `ff_swarm_mode` / `FF_SWARM_MODE` registered in `specs/feature-flags.md`, defaults to `false`
- [x] Feature flag constant `FF_SWARM_MODE` registered in `src/flags.ts`
- [x] Schema migration for `tasks.swarm_parent_id INTEGER` column and `idx_tasks_swarm_parent` index
- [x] `createSwarmGraph()` model helper in `src/models/swarm.ts`
- [x] `kdi swarm` command in `src/commands/swarm.ts` wired into `src/index.ts`
- [x] CLI parsing for repeatable `--worker <profile>:<title>` plus `--verifier` and `--synthesizer`
- [x] Input validation: at least one worker, required verifier/synthesizer, worker format, duplicate titles
- [x] `--dry-run` prints planned graph without mutating state
- [x] Dispatcher honors dependency ordering for verifier and synthesizer
- [x] Dispatcher swarm watcher: auto-complete orchestrator on synthesizer success, block on child failure
- [x] Result propagation via KDI-023 context builder (parent results)
- [x] Events: `swarm_created`, `swarm_worker_created`, `swarm_verifier_created`, `swarm_synthesizer_created`, `swarm_completed`, `swarm_failed`
- [x] Unit and CLI tests covering happy path, dry-run, validation errors, dependency ordering, result propagation, and failure handling
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Board Slug Path Traversal Hardening — Done
- [x] Shared board slug validation requires `^[a-zA-Z0-9_-]+$`
- [x] `boards create <slug>` and `createBoard()` reject traversal slugs
- [x] `getBoardDataDir()` validates slugs before constructing board data paths
- [x] Unit/e2e coverage proves traversal slugs are rejected

## Created-by Tracking (KDI-007) — Done
- [x] `created_by` column on tasks with migration default `"unknown"`
- [x] `kdi create --created-by <actor>` stores creator explicitly
- [x] Creator fallback chain: `--created-by` → `KDI_CREATED_BY` → `USER` → `"unknown"`
- [x] `kdi show <id>` displays `Created by:` when flag enabled
- [x] `kdi list --board <slug> --created-by <actor>` filters by creator
- [x] Feature flag `ff_created_by` registered and defaults to `false`

## Board Management
- [x] `kdi boards create <slug> --workdir <path>` — creates board with SQLite db
- [x] `kdi boards list` — list all boards (excludes archived; use `--all` to include)
- [x] `kdi boards show <slug>` — show board details + task counts (triage, todo, ready, running, done, blocked, archived)
- [x] `kdi boards archive <slug>` — archive board (soft delete)
- [x] `kdi boards rename-slug <old-slug> <new-slug>` — rename a board slug (data directory, current-board)

## Board Metadata (KDI-012) — Done
- [x] `name`, `icon`, `color` columns added to `boards` table (schema + migration)
- [x] Feature flag `ff_board_metadata` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards create <slug> --workdir <path> [--name <name>] [--icon <icon>] [--color <color>]` — stores board metadata when flag enabled
- [x] `kdi boards edit <slug> [--name <name>] [--icon <icon>] [--color <color>]` — updates board metadata when flag enabled
- [x] `kdi boards show <slug>` displays Name, Icon, Color when set and flag enabled
- [x] `kdi boards list` shows metadata compactly when flag enabled
- [x] Board name defaults to slug when omitted; icon and color default to null

## Board Description (KDI-044) — Done
- [x] `description` column added to `boards` table (schema + migration)
- [x] `kdi boards create <slug> --workdir <path> [--description <description>]` — stores board description when `ff_board_metadata` enabled
- [x] `kdi boards edit <slug> [--description <description>]` — updates board description when `ff_board_metadata` enabled
- [x] `kdi boards show <slug>` displays Description when set and `ff_board_metadata` enabled
- [x] `--description` is rejected when `ff_board_metadata` is disabled
- [x] Empty/whitespace-only descriptions are rejected
- [x] Description defaults to null when omitted
- [x] Existing databases are migrated to include the `description` column
- [x] Unit tests in `tests/board.test.ts` and CLI/e2e tests in `tests/e2e.test.ts` cover create, edit, show, flag gating, trimming, and migration
- [x] `bun run lint`, `bun run test tests/board.test.ts tests/e2e.test.ts`, `bun run build` pass
- [x] User-loop smoke proven with temp `HOME` and temp `KDI_DB`

## Board Rename (KDI-014) — Done
- [x] `FF_BOARD_RENAME` flag registered in `src/flags.ts`, defaults to `false`
- [x] `kdi boards rename-slug <old-slug> <new-slug>` command added to `src/commands/boards.ts`
- [x] `renameBoardSlug()` model function in `src/models/board.ts` handles DB slug update and directory rename
- [x] All error cases handled: flag disabled, invalid slugs, same slug, not found, archived, conflict with existing slug (active or archived)
- [x] Board data directory renamed on disk when it exists; warning on stderr when it doesn't
- [x] Current-board file updated when it references the old slug
- [x] Tasks preserved after rename (board_id FK doesn't change)
- [x] Tests cover AC-01 through AC-14 from the BRD

## `kdi boards rm --delete` (KDI-012c) — Done
- [x] `kdi boards rm <slug>` — soft-archive board (sets `archived_at`, keeps row and files)
- [x] `kdi boards rm <slug> --delete` — permanently delete board row and board data directory
- [x] `--delete` gated by `FF_BOARD_RM_DELETE` (defaults to `false`)
- [x] Clear error when `--delete` is used on a non-existent slug
- [x] Cascade-delete tasks and related rows when hard-deleting a board
- [x] Feature flag `ff_board_rm_delete` registered in `specs/feature-flags.md`

## Board Switch / Resolution Chain (KDI-013) — Done
- [x] `kdi boards switch <slug>` — writes slug to `~/.local/share/kdi/current`
- [x] `kdi boards show` (without slug) — displays current board via resolution chain
- [x] Resolution chain: `--board` flag → `KDI_BOARD` env → current file → `"default"`
- [x] `kdi create`, `kdi list`, `kdi specify` all resolve board via chain when `--board` is omitted
- [x] `kdi boards switch` rejects path traversal and non-existent slugs
- [x] Feature flag `ff_board_switch` registered and defaults to `false`
- [x] Unit tests for `resolveBoard()`, `writeCurrentBoard()`, `readCurrentBoard()`
- [x] E2e tests for `boards switch`, resolution chain priority, and flag gating

## Default Workdir (KDI-015) — Done
- [x] `default_workdir` column added to `boards` table (schema + migration)
- [x] `workspace` column added to `tasks` so explicit/inherited task workspace paths persist
- [x] Feature flag `ff_default_workdir` / `FF_DEFAULT_WORKDIR` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards set-default-workdir <slug> <path>` stores and displays a board default workdir when the flag is enabled
- [x] `kdi boards set-default-workdir <slug>` clears the board default workdir when the flag is enabled
- [x] `kdi create <title> --board <slug>` inherits the board default when `--workspace` is omitted and the flag is enabled
- [x] `kdi create <title> --board <slug> --workspace <path>` overrides the board default when the flag is enabled
- [x] When `FF_DEFAULT_WORKDIR=false`, the command/`--workspace` option are rejected and default inheritance is skipped

## `kdi boards create --switch` (KDI-043) — Done
- [x] Feature flag `ff_board_create_switch` / `FF_BOARD_CREATE_SWITCH` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards create <slug> --workdir <path> --switch` auto-switches to the newly created board when `FF_BOARD_CREATE_SWITCH=true`
- [x] `--switch` is gated solely by `FF_BOARD_CREATE_SWITCH` (does not require `FF_BOARD_SWITCH`)
- [x] Without `--switch`, the current-board file is left unchanged
- [x] With `--switch` and `FF_BOARD_CREATE_SWITCH=false`, the command errors with a clear message and does not touch the current-board file
- [x] Invalid slugs are rejected before any current-board file mutation
- [x] Tests in `tests/board.test.ts` cover flag-on + `--switch`, flag-on + no `--switch`, flag-off + `--switch`, and invalid slug + `--switch`
- [x] User-loop smoke verified with temp `HOME` and temp `KDI_DB`: `--switch` switches to new board, no-switch leaves current board unchanged, flag-off errors cleanly
- [x] `bun run lint`, `bun run test`, and `bun run build` pass

## Heartbeat (KDI-016) — Done
- [x] BRD drafted at `specs/brd-kdi-016-heartbeat.md`
- [x] Feature flag `ff_heartbeat` / `FF_HEARTBEAT` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_HEARTBEAT` constant added to `src/flags.ts`
- [x] `kdi heartbeat <task_id> [--note <text>]` command gated by `FF_HEARTBEAT`
- [x] Heartbeat updates `last_heartbeat_at` on task and active `task_runs` row
- [x] Heartbeat records a `heartbeat` event with optional note payload
- [x] Dispatcher reclaims `running` tasks whose `last_heartbeat_at` is older than 60 minutes
- [x] `kdi show <id>` displays `Last heartbeat:` when flag enabled and task is running
- [x] Unit/e2e tests added and passing
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Crash Grace Period (KDI-016b) — Done
- [x] BRD drafted at `specs/brd-kdi-016b-crash-grace.md`
- [x] Feature flag `ff_crash_grace_period` / `FF_CRASH_GRACE_PERIOD` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `spawned_at INTEGER` column added to `task_runs` via schema + migration in `src/db.ts`
- [x] `TaskRun` interface, column list, `createRun`, and `updateRun` updated to include `spawned_at`
- [x] Dispatcher records `spawned_at` on active runs at claim time and checks running runs for dead PIDs
- [x] Dispatcher skips dead-PID crash detection for 30 seconds after `spawned_at` when flag enabled
- [x] Dispatcher finalizes post-grace dead-PID runs as `outcome=crashed` and blocks/requeues per `max_retries`
- [x] `kdi runs <task_id>` displays `spawned_at` when flag enabled
- [x] Unit/dispatcher integration tests cover grace-period protection, post-grace crash detection, flag-disabled fallback, and `runs` display
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Rate-Limit Exit Code Handling (KDI-016c) — Done
- [x] BRD drafted at `specs/brd-kdi-016c-rate-limit-exit-code.md`
- [x] Feature flag `ff_rate_limit_exit_code` / `FF_RATE_LIMIT_EXIT_CODE` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_RATE_LIMIT_EXIT_CODE` constant added to `src/flags.ts`
- [x] `tasks.rate_limited_until INTEGER` column and `idx_tasks_rate_limited_until` index added via migration in `src/db.ts`
- [x] `Task` model, `TASK_COLUMNS`, and `hydrateTask` updated to include `rate_limited_until`
- [x] Dispatcher treats harness exit code 75 as transient rate limit when flag enabled
- [x] Rate-limited tasks return to `ready` without incrementing `consecutive_failures`
- [x] Dispatcher ready-task query and `atomicClaim` skip tasks whose `rate_limited_until` is in the future
- [x] Cooldown default 60s, overridable via `KDI_RATE_LIMIT_COOLDOWN_SECONDS` and `kdi dispatch --rate-limit-cooldown <duration>`
- [x] `kdi show <id>` displays `Rate limited until:` when flag enabled and cooldown is set
- [x] `rate_limited` event recorded with exit code, cooldown timestamp, and reason
- [x] Unit/dispatcher integration tests cover EX_TEMPFAIL requeue, cooldown suppression, override, flag-disabled fallback, and `kdi show` display
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Assign / Reassign (KDI-017) — Done
- [x] BRD drafted at `specs/brd-kdi-017-assign-reassign.md`
- [x] Feature flag `ff_assign_reassign` / `FF_ASSIGN_REASSIGN` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_ASSIGN_REASSIGN` constant added to `src/flags.ts`
- [x] `assignTask()` / `unassignTask()` / `reassignTask()` model functions in `src/models/task.ts`
- [x] `kdi assign <task_id> <profile>` and `kdi assign <task_id> none` commands
- [x] `kdi reassign <task_id> <profile> [--reclaim] [--reason <text>]` command
- [x] `kdi reclaim <task_id> --reason <text>` option gated by `FF_ASSIGN_REASSIGN`
- [x] `assigned`, `unassigned`, and `reclaimed` event emissions covered by tests
- [x] Unit/e2e tests added and passing
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Worker Log Capture (KDI-018) — Done
- [x] BRD drafted at `specs/brd-kdi-018-worker-log-capture.md`
- [x] Feature flag `ff_worker_log_capture` / `FF_WORKER_LOG_CAPTURE` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_WORKER_LOG_CAPTURE` constant added to `src/flags.ts`
- [x] Dispatcher writes harness stdout/stderr to `~/.local/share/kdi/logs/<board>/<task_id>.log` when flag enabled
- [x] `kdi log <task_id>` command prints the captured log
- [x] `kdi log <task_id> --tail <bytes>` prints only trailing bytes
- [x] Log-write failures do not cause the dispatcher to fail the task
- [x] Unit/dispatcher integration tests cover log creation, `--tail`, missing log handling, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Board Stats (KDI-019) — Done
- [x] BRD drafted at `specs/brd-019-stats.md`
- [x] Feature flag `ff_stats` / `FF_STATS` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_STATS` constant added to `src/flags.ts`
- [x] `kdi stats [--board <slug>]` command gated by `FF_STATS`
- [x] `kdi stats` prints per-status counts, per-assignee counts, and oldest-ready age
- [x] `kdi stats --json` emits stable JSON document
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover counts, JSON output, board resolution, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Diagnostics (KDI-020) — Done
- [x] BRD drafted at `specs/brd-kdi-020-diagnostics.md`
- [x] Feature flag `ff_diagnostics` / `FF_DIAGNOSTICS` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_DIAGNOSTICS` constant added to `src/flags.ts`
- [x] `kdi diagnostics [--board <slug>]` command gated by `FF_DIAGNOSTICS`
- [x] `kdi diagnostics --severity {warning|error|critical}` filters by minimum severity
- [x] `kdi diagnostics --task <task_id>` restricts findings to a single task
- [x] `kdi diagnostics --json` emits stable JSON array
- [x] 8 diagnostic rules implemented: `stranded_in_ready`, `stuck_in_blocked`, `repeated_failures`, `repeated_crashes`, `block_unblock_cycling`, `hallucinated_cards`, `prose_phantom_refs`, `triage_aux_unavailable`
- [x] Each finding includes rule, severity, task_id, message, and suggested actions
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover each rule, severity filtering, per-task mode, JSON output, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Garbage Collection (KDI-021) — Done
- [x] BRD drafted at `specs/brd-kdi-021-gc.md`
- [x] Feature flag `ff_gc` / `FF_GC` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `FF_GC` constant added to `src/flags.ts`
- [x] `kdi gc [--board <slug>] [--event-retention-days <n>] [--log-retention-days <n>]` command gated by `FF_GC`
- [x] `kdi gc` deletes task events older than `--event-retention-days`
- [x] `kdi gc` deletes worker logs older than `--log-retention-days`
- [x] `kdi gc` cleans KDI-owned workspaces for archived tasks (board data dir or temp `kdi-*` paths)
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover event deletion, log deletion, workspace cleanup, board resolution, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Assignees Listing (KDI-024) — Done
- [x] Feature flag `ff_assignees_listing` / `FF_ASSIGNEES_LISTING` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `getAssigneeCounts()` model helper in `src/models/task.ts` counts non-archived tasks per assignee for a board
- [x] `kdi assignees [--board <slug>]` command in `src/commands/assignees.ts`, wired into `src/index.ts`
- [x] Listing merges known profiles from the profile registry with assignees present on the resolved board
- [x] Each profile shows the count of non-archived tasks assigned to it on the board
- [x] `kdi assignees --json` emits a stable JSON document (`{ board, assignees: [{ profile, count }] }`)
- [x] Board resolved via standard chain; errors clearly when board is missing or archived
- [x] Unit/CLI tests cover counts, JSON output, board resolution, archived exclusion, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Task Attachments (KDI-022) — Done
- [x] BRD drafted at `specs/brd-kdi-022-task-attachments.md`
- [x] Feature flag `ff_task_attachments` / `FF_TASK_ATTACHMENTS` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `task_attachments` table + index added via schema + migration in `src/db.ts`
- [x] `kdi attach <task_id> <file>` command copies file to board storage and records metadata
- [x] `kdi show <id>` displays attachments when flag enabled
- [x] Board hard-delete cascade-deletes attachment rows and on-disk `attachments/` directory
- [x] Unit/CLI tests cover storage, flag gating, duplicate-name rejection, and hard-delete cascade
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Context Builder (KDI-023) — Done
- [x] BRD drafted at `specs/brd-kdi-023-context-builder.md`
- [x] Feature flag `ff_context_builder` / `FF_CONTEXT_BUILDER` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_CONTEXT_BUILDER` constant added to `src/flags.ts`
- [x] `kdi context <task_id> [--board <slug>] [--json]` command gated by `FF_CONTEXT_BUILDER`
- [x] Context builder composes 7 sections: header, body, parent results, prior attempts, role history, comments, attachments
- [x] All free-text/count fields capped per BRD to prevent prompt overflow
- [x] Parent results only include done parents; ordered by insertion order
- [x] Role history derives actors and notes from task events
- [x] Comments fallback to `"user"` when `author` column is absent
- [x] Attachment paths resolved to absolute; tolerated when `task_attachments` table missing
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover happy path, truncation, caps, missing task, flag gating, JSON output
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Notification Subscriptions (KDI-025) — Done
- [x] BRD drafted at `specs/brd-kdi-025-notification-subscriptions.md`
- [x] Feature flag `ff_notify_subs` / `FF_NOTIFY_SUBS` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `kanban_notify_subs` table schema and migration in `src/db.ts`
- [x] `subscribe()` / `listSubscriptions()` / `unsubscribe()` model functions in `src/models/notifySub.ts`
- [x] `kdi notify-subscribe <task_id> --platform <name> --chat-id <id>` command
- [x] `kdi notify-list [<task_id>] [--archived] [--json]` command
- [x] `kdi notify-unsubscribe <task_id> --platform <name> --chat-id <id>` command
- [x] Notifier profiles registry `~/.config/kdi/notifiers.yaml` with built-in `log` profile
- [x] Notifier watcher in dispatcher tick loop gated by `FF_NOTIFY_SUBS`
- [x] Transport handlers: telegram, slack, discord, webhook, log
- [x] Unit/CLI tests for all CLI commands and notifier watcher
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## CLI Polish Specs (KDI-030 through KDI-035) — Done
- [x] BRDs drafted:
  - `specs/brd-kdi-030-list-filters-sort.md`
  - `specs/brd-kdi-031-show-run-filtering.md`
  - `specs/brd-kdi-032-bulk-operations.md`
  - `specs/brd-kdi-033-comment-enhancements.md`
  - `specs/brd-kdi-034-dispatch-controls.md`
  - `specs/brd-kdi-035-watch-filters.md`
- [x] Feature flags registered in `specs/feature-flags.md`:
  - `ff_list_filters_sort` / `FF_LIST_FILTERS_SORT`
  - `ff_show_run_filtering` / `FF_SHOW_RUN_FILTERING`
  - `ff_bulk_operations` / `FF_BULK_OPERATIONS`
  - `ff_comment_enhancements` / `FF_COMMENT_ENHANCEMENTS`
  - `ff_dispatch_controls` / `FF_DISPATCH_CONTROLS`
  - `ff_watch_filters` / `FF_WATCH_FILTERS`
- [x] Feature flags registered in `src/flags.ts`

## KDI-030: `kdi list` Filters and Sort — Done
- [x] `session_id`, `workflow_template_id`, `current_step_key` columns added to `tasks` (schema + migrations)
- [x] Supporting indexes: `idx_tasks_session`, `idx_tasks_workflow_template`, `idx_tasks_step_key`
- [x] `kdi list --mine` — filter by current profile assignee (resolved from `KDI_PROFILE` → `HERMES_PROFILE` → `"user"`)
- [x] `kdi list --session <session_id>` — filter by originating session
- [x] `kdi list --archived` — include archived tasks in listing
- [x] `kdi list --sort <key>` — sort by `assignee`, `created`, `created-desc`, `priority`, `priority-desc`, `status`, `title`, `updated`
- [x] `kdi list --workflow-template-id <id>` — filter by workflow template
- [x] `kdi list --step-key <key>` — filter by current step key
- [x] `kdi create --session <session_id>` — store originating session on task
- [x] `--mine` and `--assignee` mutually exclusive; clear error when used together
- [x] New filters compose with existing `--status`, `--assignee`, `--tenant`, `--created-by`
- [x] All new options gated by `FF_LIST_FILTERS_SORT` (defaults to `false`)
- [x] Invalid sort keys rejected with a list of valid values
- [x] Unit tests cover each filter, sort key, archived inclusion, and flag gating
- [x] CLI/e2e tests cover all acceptance criteria from the BRD
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-031: `kdi show` Run Filtering — Done
- [x] `kdi show <task_id>` displays a "Runs:" section after comments and attachments when flag enabled
- [x] `--state-type status --state-name <value>` filters runs by status
- [x] `--state-type outcome --state-name <value>` filters runs by outcome
- [x] Only passing both `--state-type` and `--state-name` is valid; partial pairs rejected
- [x] Invalid `--state-type` rejected with clear error listing valid values
- [x] "No runs found for this task." when task has no runs
- [x] "No runs match the filter." when filter matches nothing
- [x] All new options gated by `FF_SHOW_RUN_FILTERING` (defaults to `false`)
- [x] `kdi runs` and default `kdi show` output unchanged when flag disabled
- [x] Unit tests for `getRunsFiltered` — validation, filter matching, empty states
- [x] CLI/e2e tests cover acceptance criteria
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-036: `kdi runs` Filtering — Done
- [x] `kdi runs <task_id>` lists all runs for the task, newest first, format unchanged
- [x] `--state-type status --state-name <value>` filters runs by status
- [x] `--state-type outcome --state-name <value>` filters runs by outcome
- [x] Only passing both `--state-type` and `--state-name` is valid; partial pairs rejected
- [x] Invalid `--state-type` rejected with clear error listing valid values
- [x] "No runs found for this task." when task has no runs
- [x] "No runs match the filter." when filter matches nothing
- [x] All new options gated by `FF_RUNS_FILTERING` (defaults to `false`)
- [x] Unfiltered `kdi runs` output byte-for-byte unchanged when flag disabled
- [x] Reuses the `getRunsFiltered` model helper from KDI-031 as the single source of truth
- [x] Unit tests for `getRunsFiltered` cover filter matching, validation, empty states
- [x] CLI/e2e tests cover flag gating, both/neither validation, invalid type, status/outcome match, empty filter, no-runs baseline
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-032: Bulk Operations — Done
- [x] `kdi block <id1> <id2>... --reason <text>` — bulk block with pre-checks for already-blocked
- [x] `kdi schedule <id1> <id2>... --at <timestamp> [--reason <text>]` — bulk schedule with per-task try/catch
- [x] `kdi promote <id1> <id2>... [--force] [--dry-run]` — bulk promote with dependency override
- [x] `kdi promote --force` bypasses parent dependency checks
- [x] `kdi promote --dry-run` prints verdicts without mutating state
- [x] `kdi archive --rm <id1> <id2>...` — permanently delete archived tasks (FK-safe cascade)
- [x] Already-blocked tasks skipped with clear "already blocked" message
- [x] Already-archived tasks skipped during block operations
- [x] `archive --rm` rejects non-archived tasks with clear error
- [x] Bulk operations gated by `FF_BULK_OPERATIONS` (defaults to `false`)
- [x] Single-task `block`/`promote`/`archive` work when flag disabled
- [x] Unit tests cover `promoteTaskAdvanced`, `archiveTaskHard`, flag gating
- [x] CLI/e2e tests cover acceptance criteria
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-033: Comment Enhancements — Done
- [x] `kdi comment <task_id> <text> --author <name>` — stores author on comment
- [x] Default author resolved from `KDI_PROFILE` → `HERMES_PROFILE` → `"user"`
- [x] `kdi comment <task_id> <text> --max-len <n>` — trims stored text to n characters
- [x] Empty `--author` rejected with clear error
- [x] Invalid `--max-len` (0, -1, non-numeric) rejected with clear error
- [x] `kdi show <task_id>` displays author with each comment when flag enabled
- [x] `author` column added to `comments` table (migration guarded by `PRAGMA table_info`)
- [x] All new options gated by `FF_COMMENT_ENHANCEMENTS` (defaults to `false`)
- [x] Preserve backward compatibility: existing comments show "user" as fallback author
- [x] Unit/CLI tests cover author resolution, max-len trimming, flag gating, show display
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-034: Dispatch Controls — Done
- [x] `kdi dispatch --failure-limit <n>` — per-pass failure threshold
- [x] Failure counter increments for: crash, spawn-fail, board not found, unknown profile, worktree failure, harness failure
- [x] Rate-limited tasks (exit code 75) excluded from failure counter
- [x] Dependency-skipped tasks excluded from failure counter
- [x] Warning emitted to stderr + board log when limit reached
- [x] `--failure-limit` combines independently with `--max`
- [x] `--max <n>` behavior preserved unchanged (ungated)
- [x] `parseFailureLimit()` pure function extracted, unit-tested
- [x] `--failure-limit` gated by `FF_DISPATCH_CONTROLS` (defaults to `false`)
- [x] Unit/dispatcher tests cover happy-path, early-exit, zero/invalid inputs, flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-035: Watch Filters — Done
- [x] `kdi watch --assignee <profile>` — filter by task assignee
- [x] `kdi watch --tenant <name>` — filter by task tenant (also gated by `FF_TENANT_NAMESPACE`)
- [x] `kdi watch --kinds <kind1>,<kind2>` — filter by event kinds
- [x] `kdi watch --interval <seconds>` — custom poll interval (min 0.1s)
- [x] Filters compose with AND semantics
- [x] Empty `--assignee`, `--tenant`, `--kinds` rejected with clear errors
- [x] Invalid `--interval` rejected with clear error
- [x] Unfiltered `kdi watch` behavior unchanged
- [x] `getRecentEvents` and `getEventsAfter` accept optional `WatchFilters`
- [x] Filtered queries use parameterized SQL; no string interpolation of user input
- [x] Combined assignee + tenant AND filtering tested
- [x] All new options gated by `FF_WATCH_FILTERS` (defaults to `false`)
- [x] Unit/CLI tests cover filters, combinations, flag gating, edge cases
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-038: Goal Mode — Done
- [x] BRD drafted at `specs/brd-kdi-038-goal-mode.md` to match Ralph-style multi-turn goal loop semantics
- [x] Feature flag `ff_goal_mode` / `FF_GOAL_MODE` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] Additive schema migration adds `goal_mode`, `goal_max_turns`, `goal_remaining_turns`, `goal_judge_profile` columns to `tasks` and `idx_tasks_goal_mode` index; `task_runs.outcome` CHECK extended to include `'goal_continue'` via the same `tasks_new`-style table-recreate pattern
- [x] `Task` interface, `TASK_COLUMNS`, `CreateTaskInput`, `createTask`, `hydrateTask` updated in `src/models/task.ts`
- [x] `decrementGoalTurns(id)` and `resetGoalTurns(id)` helpers exported from `src/models/task.ts`; `unblockTask` resets `goal_remaining_turns` when unblocking a `"Goal max turns exhausted"` task
- [x] `kdi create --goal --goal-max-turns <n> --goal-judge <profile>` command in `src/commands/tasks.ts` with validation: `--goal` requires `--goal-max-turns` (positive int) and a known judge profile (CLI flag or `KDI_GOAL_JUDGE_PROFILE` env); rejects unknown profiles and disabled flag with clear errors
- [x] `kdi show <id>` displays `Goal: <remaining>/<max> turns, judge=<profile>` line when `FF_GOAL_MODE` is enabled and the task is goal-mode
- [x] Dispatcher goal-loop integration in `src/dispatcher.ts` (gated by `FF_GOAL_MODE`): passes `KDI_GOAL_*` env vars to the harness, and on a non-zero exit decrements `goal_remaining_turns` and requeues the task with a `goal_turn` event, or blocks with `"Goal max turns exhausted"` when the budget hits 0
- [x] Judge approximation: `isGoalSatisfied()` treats a `exit 0` harness as a satisfied goal; a `ponytail:` comment in `src/dispatcher.ts` names the upgrade path (spawn `task.goal_judge_profile` with the same env vars, parse verdict from `KDI_GOAL_VERDICT_FILE`)
- [x] Unit, CLI, and dispatcher tests covering schema round-trip, `--goal` validation, `kdi show` goal-mode display, requeue on no-satisfy, exhaustion blocking, flag-disabled behavior, and env-var pass-through
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-039: Workflow Templates — Done
- [x] BRD finalized at `specs/brd-kdi-039-workflow-templates.md`
- [x] Feature flag `ff_workflow_templates` / `FF_WORKFLOW_TEMPLATES` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `workflow_templates` table schema and migration in `src/db.ts`; cascade-deleted on board hard-delete
- [x] `defineWorkflowTemplate()` / `listWorkflowTemplates()` / `getWorkflowTemplate()` / `validateStepKey()` / `advanceTaskStep()` / `setTaskStep()` model functions in `src/models/workflowTemplate.ts`
- [x] `kdi workflows define <id> --name <name> --steps <json>` command
- [x] `kdi workflows list [--board <slug>] [--json]` command
- [x] `kdi create <title> --workflow-template-id <id> [--step-key <key>]` command; validates template exists and step key is valid
- [x] `kdi step <task_id> [--to <key>] [--reason <text>]` command; advances to next step or jumps to arbitrary step
- [x] `kdi show <task_id>` displays workflow template and current step when flag enabled
- [x] Step advancement emits `stepped` event; terminal step transitions task to `done` and emits `completed`
- [x] Step-key driven routing: dispatcher records `current_step_key` on `task_runs`, substitutes `{{step_key}}` in profile commands, and sets `KDI_CURRENT_STEP_KEY` env var for harnesses
- [x] `kdi runs <task_id>` displays `step=<key>` when the run has a step key
- [x] Unit/CLI tests cover template CRUD, step advancement, terminal completion, validation, dispatcher routing, runs display, and flag gating
- [x] E2E verified: define template → create bound task → step through workflow → terminal completion
- [x] `bun run lint` and `bun run build` pass
- [x] Code-review fixes: duplicate BRD files removed, missing imports in `tests/task.test.ts` restored, template name length capped at 255 in `defineWorkflowTemplate()`, event payloads no longer use `Record<string, any>`

- [x] `kdi create <title> --board <slug> --assignee <profile>` — create task
- [x] `kdi create <title> --board <slug> --triage` — create task in triage
- [x] `kdi create <title> --board <slug> --idempotency-key <key>` — create idempotently; returns existing non-archived task id if matched
- [x] `kdi create <title> --board <slug> --initial-status <status>` — create task with custom initial status (triage, todo, scheduled, ready, running, done, blocked)
- [x] `kdi create <title> --board <slug> --priority <n>` — create task with integer priority (default 0, higher = more urgent)
- [x] `kdi create <title> --board <slug> --max-runtime <duration>` — create task with per-task runtime cap (feature-flagged)
- [x] `kdi create <title> --board <slug> --tenant <name>` — create task with tenant namespace (feature-flagged)
- [x] `kdi specify <task_id> --board <slug>` — promote triage → todo
- [x] `kdi specify --all --board <slug>` — promote all triage tasks
- [x] `kdi list --board <slug> --status <status>` — list tasks filtered
- [x] `kdi list --board <slug> --tenant <name>` — list tasks filtered by tenant namespace (feature-flagged)
- [x] `kdi show <task_id>` — show task details
- [x] `kdi edit <task_id> --body <text>` — edit task body
- [x] `kdi comment <task_id> <text>` — add comment
- [x] `kdi promote <task_id>` — move todo → ready
- [x] `kdi block <task_id> --reason <text>` — mark blocked
- [x] `kdi unblock <task_id>` — unblock task
- [x] `kdi archive <task_id>` — archive task
- [x] `kdi complete <task_id> --result <text> --summary <text> --metadata <json>` — complete task with metadata
- [x] `kdi complete <task_id_1> <task_id_2> ... --result <text>` — bulk complete (result applies to all)
- [x] `kdi tail <task_id>` — tail events for a task
- [x] `kdi watch` — watch board-wide events

## Triage Status (KDI-001) — Done
- [x] `triage` status added to tasks CHECK constraint (with migration via table recreation)
- [x] `kdi create --triage` parks new tasks in `triage` instead of `todo`
- [x] `kdi specify <task_id>` promotes `triage` → `todo` (requires non-empty body)
- [x] `kdi specify --all` sweeps all triage tasks on a board
- [x] `specified` event emitted on promotion

## Scheduled Status (KDI-002) — Done
- [x] `scheduled` status added to tasks CHECK constraint (with migration via table recreation)
- [x] `scheduled_at` and `schedule_reason` columns added to tasks
- [x] `kdi schedule <task_id> --at <timestamp> [--reason <text>]` parks task in `scheduled`
- [x] `--at` accepts ISO 8601 or Unix seconds; rejects timestamps in the past
- [x] `kdi unblock <task_id> [--reason <text>]` immediately promotes `scheduled` → `ready`
- [x] Dispatcher auto-promotes `scheduled` tasks to `ready` when `scheduled_at` passes
- [x] `ready` and `scheduled` events emitted on the respective transitions

## Review Status (KDI-003) — Done
- [x] `review` status added to tasks CHECK constraint (with migration via table recreation)
- [x] `kdi review <task_id> --reason <text>` marks a task as under review
- [x] `reviewed` event emitted on transition
- [x] Distinct from `blocked` — indicates output is under human/code review

## Complete with Metadata (KDI-005) — Done
- [x] `kdi complete <task_id> --result "..." --summary "..." --metadata '{"tests": 12}'`
- [x] `kdi complete <id1> <id2> ...` — bulk complete (only `--result` applies to all)
- [x] Stores `result` and `summary` on the task row
- [x] Creates or finalizes a `task_runs` row with `outcome = completed`
- [x] Emits a `completed` event with optional metadata payload

## Task Runs (KDI-000)
- [x] `task_runs` table with per-attempt history (profile, step_key, status, claim_lock, worker_pid, started_at, ended_at, outcome, summary, metadata, error)
- [x] Dispatcher creates a `task_runs` row on claim and finalizes it on finish/fail
- [x] `kdi runs <task_id>` — show attempt history with optional `--state-type`/`--state-name` filters (KDI-036)

## Task Runs Status (KDI-000e)
- [x] `status` column on `task_runs`: `running | done | blocked | crashed | timed_out | failed | released`
- [x] Distinct from `outcome` (terminal classification)
- [x] Indexed: `idx_runs_status`
- [x] `finishRun` maps outcome → status (e.g. `reclaimed` → `released`, `crashed` → `crashed`)

## Task Events (KDI-000b)
- [x] `task_events` table with task_id, run_id, kind, payload, created_at
- [x] `kdi tail <task_id>` — follow events live (poll 1s), with optional `--lines N` / `--no-follow` non-following mode (KDI-049)
- [x] `kdi watch` — board-wide event stream (poll 0.5s) with optional `--assignee`, `--tenant`, `--kinds`, and `--interval` filters (KDI-035)
- [x] Event emissions: created, promoted, blocked, unblocked, completed, archived, claimed, finished

## CAS Claim System (KDI-000c)
- [x] `claim_lock` + `claim_expires` columns on tasks (with migration)
- [x] `last_heartbeat_at` column on tasks (with migration)
- [x] `atomicClaim()` — CAS update: ready → running with TTL
- [x] Default claim TTL: 15 minutes (900s), env override: `KDI_CLAIM_TTL_SECONDS`
- [x] `kdi claim <task_id> --ttl <seconds>` — atomically claim a ready task
- [x] `kdi reclaim <task_id> --reason <text>` — release active claim
- [x] `kdi heartbeat <task_id> --note <text>` — worker liveness signal
- [x] Stale claim detection in dispatcher (expired claim or heartbeat > 60min)
- [x] Dispatcher records initial heartbeat on claim

## Cross-process Init Lock (KDI-000d)
- [x] File-based lock (`<dbPath>.init.lock`) serializes schema setup across concurrent processes
- [x] Stale lock detection via PID liveness check
- [x] 30-second timeout with 50ms retry backoff
- [x] Lock released after migrations complete (try/finally guarantee)

## Harness Profiles — Accepted
- [x] Profile registry at `~/.config/kdi/profiles.yaml`
- [x] Built-in profiles: opencode, claude, codex, pi
- [x] Template substitution: `{{workdir}}`, `{{branch}}`, `{{task_id}}`, `{{agent}}`, `{{skills}}`
- [x] Profile validation on load

## Dispatcher — Accepted
- [x] `kdi dispatch` — background polling daemon (tick function; long-running mode TBD)
- [x] Poll interval configurable (default 5s)
- [x] Claim ready tasks (CAS: ready → running)
- [x] Resolve assignee → harness profile → command
- [x] Spawn in isolated git worktree
- [x] Capture stdout/stderr/exit code
- [x] Update task status: done / failed
- [x] Task runs table (per-attempt history)
- [ ] Dispatcher writes per-board PID markers and `kdi create` warns when no live dispatcher is detected (KDI-037)

## Worktree Isolation — Accepted
- [x] Auto-create worktree branch `wt/<profile>/<task_id>`
- [x] Configurable base ref (default `origin/main`)
- [x] Cleanup on completion

## Skills Array (KDI-009) — Done
- [x] `skills TEXT` JSON-array column added to tasks (with migration)
- [x] `kdi create <title> --board <slug> --skill <skill>` repeatable; gated by `FF_SKILLS_ARRAY`
- [x] `kdi show <task_id>` displays skills as comma-separated list
- [x] Dispatcher substitutes `{{skills}}` in profile commands
- [x] Dispatcher sets `KDI_SKILLS` env var for harness process

## Max Runtime (KDI-008) — Done
- [x] `max_runtime_seconds INTEGER` column added to tasks (with migration)
- [x] `kdi create <title> --board <slug> --max-runtime <duration>`; gated by `FF_MAX_RUNTIME`
- [x] Duration parser accepts seconds (`300`) or suffixes (`30m`, `1h`, `2d`)
- [x] `kdi show <task_id>` displays max runtime when set
- [x] Dispatcher copies task cap into active `task_runs` row on claim
- [x] Dispatcher passes cap as harness timeout; SIGTERM then SIGKILL on expiry
- [x] Timed-out runs recorded with `outcome=timed_out` and task blocked

## Max retries / circuit breaker (KDI-011) — Done
- [x] Feature flag `ff_max_retries` / `FF_MAX_RETRIES` registered in `src/flags.ts` and `specs/feature-flags.md`
- [x] Schema adds `max_retries` and `consecutive_failures` columns with migrations
- [x] Task model, `CreateTaskInput`, `TASK_COLUMNS`, and hydration updated
- [x] `kdi create --max-retries <n>` implemented and gated by `FF_MAX_RETRIES`
- [x] `kdi show` displays `max_retries` and `consecutive_failures` when flag enabled
- [x] Dispatcher implements circuit breaker: requeue until `max_retries` then block
- [x] Successful harness run resets `consecutive_failures` to 0
- [x] `EX_TEMPFAIL` does not increment `consecutive_failures`
- [x] Tests added and passing for new behavior
- [x] `bun run lint`, `bun run test`, and `bun run build` all pass

## Tenant Namespace (KDI-006) — Done
- [x] `tenant TEXT` column added to tasks (with migration and `idx_tasks_tenant` index)
- [x] `kdi create <title> --board <slug> --tenant <name>`; gated by `FF_TENANT_NAMESPACE`
- [x] `kdi list --board <slug> --tenant <name>` filters by tenant and composes with `--status` / `--assignee`
- [x] `kdi show <task_id>` displays tenant when present
- [x] Feature flag `FF_TENANT_NAMESPACE` registered in `specs/feature-flags.md` and defaults to `false`

## Model Override (KDI-010) — Done
- [x] `model_override TEXT` column added to tasks (with migration)
- [x] `kdi create <title> --board <slug> --model <model>`; gated by `FF_MODEL_OVERRIDE`
- [x] `kdi show <task_id>` displays `Model override:` when flag enabled and value is set
- [x] Dispatcher substitutes `{{model}}` in harness profile commands when override is set
- [x] Dispatcher sets `KDI_MODEL=<model>` env var for harness process when override is set
- [x] Feature flag `FF_MODEL_OVERRIDE` registered in `specs/feature-flags.md` and defaults to `false`

## Dependencies
- [x] Parent/child task blocking (KDI-045 `kdi create --parent`)
- [x] Child waits until parent is `done`
- [x] Dependency chain resolution

## Notifications
- [x] Terminal delivery on task completion (KDI-025 notifier watcher; gated by `FF_NOTIFY_SUBS`, InDev)
- [x] Webhook support (KDI-025 `webhook` transport; gated by `FF_NOTIFY_SUBS`, InDev)

## Feature Flags
- [x] `FF_ENABLE_KANBAN_DISPATCH` — gates dispatcher loop (Active, default `true`)
- [x] Most flags promoted to **Active** (default `true`); see "End-User Rollout — Feature Flags Promoted to Active" and `specs/feature-flags.md`. InDev (default `false`): `FF_BOARD_RM_DELETE`, `FF_NOTIFY_SUBS`, `FF_TRIAGE_AUTOMATION`, `FF_SWARM_MODE`, `FF_GOAL_MODE`, `FF_SVELTEKIT_FRONTEND`.

## Non-Functional Requirements
- [ ] Single binary (bun compile)
- [ ] SQLite with WAL mode
- [ ] Sub-100ms CLI response
- [ ] Idempotent task claim
- [ ] macOS + Linux support

## Observability
- [x] Task runs table (per-attempt history)
- [ ] Dispatcher tick count
- [ ] Claim success/failure rate
- [ ] Task age histogram
- [ ] Per-agent duration + error rate
- [ ] Log file per board at `~/.local/share/kdi/logs/<slug>.log`


## Tech Debt

### Known gaps (not blocking, tracked for future work)

- [ ] **KDI-UI-006: heartbeat note byte limit is char-based in the model + CLI** — `src/models/claim.ts` (`MAX_HEARTBEAT_NOTE_BYTES` + `note.length`/`note.slice`) and `src/commands/tasks.ts:1533` enforce the 4 KiB budget via JS code-unit count, not UTF-8 bytes, so CJK/emoji input can exceed the intended byte limit. The SvelteKit UI now clamps by true UTF-8 bytes at the server boundary (`clampUtf8Bytes` in `bridge.ts`), making the model path a harmless no-op for UI submissions, but the CLI path is still char-based. Fixing the model/CLI is out of KDI-UI-006 scope (AC-27 forbids `src/models` churn); track for a separate flag-gated slice with CLI tests.

- [ ] **KDI-000d: Live-PID contention test** — `initDb` is synchronous and blocks the event loop; async test cleanup races with the sync loop. The implementation is correct (verified by code review), but testing live-PID lock contention requires spawning a real concurrent process, which is flaky in the Bun test runner.
- [ ] **KDI-000e: `finishRun(null outcome)` defaults to `"done"`** — Reviewer noted this weakens the "status is derived from outcome" invariant. Making `outcome` non-nullable would be a breaking change to existing callers. Consider enforcing in a future refactor.
- [ ] **KDI-001b: `list --status archived` is broken** — Pre-existing behavior: `listTasksCommand` reuses `isValidStatus` which rejects `"archived"`. Not introduced by KDI-001b, but should be fixed if listing archived tasks is desired.
- [ ] **KDI-002: Missing model/e2e test for `create --initial-status scheduled --at`** — The CLI and model guard both enforce `scheduled_at` requirement, but no dedicated model test covers the success path. Feature-flag gated by default makes e2e harder; unit tests cover the logic.
- [ ] **KDI-003: `review_reason` column vs `block_reason` design quirk** — `review_reason` exists in the SCHEMA and `reviewTask` now writes to it, but `kdi show` displays both `Block reason` and `Review reason` for review-status tasks. Consider consolidating display to show only the relevant reason per status.
- [ ] **KDI-003: `reviewTask` accepts status transitions without guard** — Can transition from `blocked`, `running`, `done`, or any non-archived status to `review`. The behavior is correct but should be explicitly spec'd or restricted in a future pass.
- [ ] **KDI-005: `completeTask()` uses synthetic zero-duration run** — When no active run exists, it creates a `task_runs` row with `started_at = now` and immediately finishes it. Functionally correct but run history is slightly misleading.
- [ ] **KDI-005: `ff_complete_metadata` gating is coarse** — The entire `--metadata` path is gated; the flag doesn't apply to the base `--result`/`--summary` paths. Consider finer-grained flags if metadata needs independent rollout.
- [ ] **Branch naming convention not enforced** — `AGENTS.md` requires `feat/<brd-id>-<feature-slug>` but the current branch `fix/review-gaps` was not renamed. Either update `AGENTS.md` with an exemption or enforce via CI.
- [ ] **`spawnHarness` uses `shell: true`** — Changed from manual shell parser to `spawn(command, { shell: true })`. This changes quoting/escaping semantics for profile commands. Verify no existing profiles depend on the old literal-argument behavior. Document in PR description.
- [x] **`bun run test` exits 1 despite all tests passing** — Fixed by switching `createTaskCommand` and `listTasksCommand` error handling to `this.error()` (Commander's internal exit path) and updating KDI-030/KDI-039 tests to use `exitOverride()` instead of mocking `process.exit`. Added `resetCommandOptions()` helper to clear stale Commander singleton option state between tests.
- [ ] **Worker log capture test flaky in full-suite runs** — `worker log capture > spawnHarness writes combined stdout/stderr to log file` (and the matching e2e dispatcher log test) occasionally fail when the full suite runs but pass in isolation. Likely an ordering/timing interaction between tests sharing `HOME`/`KDI_DB` defaults. Documented by reviewer for KDI-022; investigate and fix if it persists on `main`.
- [ ] **SQLite monolithic migration** — The single `CREATE TABLE tasks_new ... DROP TABLE ... RENAME TO` migration handles schema changes for KDI-001 (triage), KDI-002 (scheduled), KDI-003 (review), and KDI-004 (integer priority) in one pass. This is technically required by SQLite (can't `ALTER TABLE` CHECK constraints or change column types), but it mixes feature boundaries. If versioned migration files are ever introduced, this should be split into per-feature steps with intermediate schema versions.
- [ ] **`tests/init.test.ts` fails when `KDI_DB` is set** — `defaultDbPath()` honors the `KDI_DB`/`KDI_DB_PATH` environment variables, but `tests/init.test.ts` asserts that `defaultDbPath()` ends with `.db`. When the parent environment sets `KDI_DB` to a path without that suffix (e.g. `.../kdi.sqlite`), the assertion fails. The implementation is correct; the test is environment-sensitive. Run the suite with `env -u KDI_DB bun test` for a clean baseline.
- [ ] **Import-path convention conflict** — `AGENTS.md` prescribes the `~/*` alias for `src/*` imports, but the entire existing codebase uses relative imports (e.g. `../models/board`). KDI-024 followed the existing relative-import convention to stay consistent with surrounding code. The project should either migrate all imports to `~/*` or update `AGENTS.md` to reflect the actual convention.

- [ ] **KDI-UI-007: `bridge.http.test.ts` times out locally** — `apps/web/src/lib/server/bridge.http.test.ts` starts a dev server and frequently hangs until the test runner timeout on both `main` and feature branches. The test assertions were updated to match the corrected `processed`/`dispatch_failed` behavior, but the test itself cannot be run reliably in the local loop. Investigate server startup/teardown and port contention, or run it in CI.
- [ ] **KDI-UI-007: `lastRefreshed` derived fallback creates a new `Date()` per evaluation** — The derived `lastRefreshed` falls back to `data.status ? new Date() : null` for SSR. Each evaluation constructs a fresh `Date()`, which could produce a minor server/client timestamp mismatch if hydration is slow. Functionally harmless; consider storing the SSR timestamp explicitly if exact parity matters.

### Review nits (from KDI-036/037/038 reviews)

- [ ] **KDI-036: `validTypes` constant duplicated in three places** — `["status", "outcome"]` is defined in `src/models/taskRun.ts:117` (model), `src/commands/tasks.ts:1448` (`listRunsCommand`, KDI-036), and `src/commands/tasks.ts:464` (`showTaskCommand`, KDI-031). Extract a single `VALID_RUN_FILTER_TYPES` const or a small `parseRunFilterOptions(...)` helper. Risk: the two commands can drift on error wording; consolidating removes the duplication. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.
- [ ] **KDI-036: option-gate / partial-pair / valid-type validation block duplicated between `listRunsCommand` and `showTaskCommand`** — `src/commands/tasks.ts:1431-1455` (KDI-036) is a near byte-for-byte copy of `src/commands/tasks.ts:444-462` (KDI-031). Extract a shared helper to remove ~25 lines of duplication. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.
- [x] ~~**KDI-031 docs typo: `ff_show_run_filtering` lifecycle header still says `— Planned`**~~ — fixed in `specs/feature-flags.md`; header is now `— Active` and status transitions note the promotion.
- [ ] **KDI-037: unused imports in `tests/dispatcherPresence.test.ts:2,8`** — `readFileSync` (from `node:fs`) and `createBoard` (from `../src/models/board`) are imported but never referenced. The linter does not catch them because the project does not enable `noUnusedLocals` for this file context. Drop the imports. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.
- [ ] **KDI-037: dead helpers `captureWarn` / `restoreWarn` in `tests/commands/tasks.test.ts:864-878`** — Defined in the KDI-037 describe block but never called; every test inlines its own `console.warn` capture via `try/finally`. Delete the helpers. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.

### Deferred non-blocking items (from KDI-038 review)

- [ ] **KDI-038: AC-13 — missing-judge-profile runtime block not enforced** — A goal-mode task created directly via the model (bypassing CLI) with `goal_judge_profile = null` is still dispatched, with the harness exit code standing in for the missing judge. CLI validation prevents this in practice. The BRD's defensive block-reason ("Goal-mode task missing required judge profile") is not enforced at the dispatcher level. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: NFR — `tasks.result` not capped at 64 KiB on requeue** — `src/dispatcher.ts:333-336` (`handleGoalContinue`) concatenates `task.result` with the new `[turn N] <error>` note without a cap. Long-running goal loops with verbose harnesses could grow `tasks.result` without bound. BRD NFR says to trim to 64 KiB. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: test gap — `KDI_GOAL_CONTEXT` env var not asserted** — `src/dispatcher.ts:582` sets `KDI_GOAL_CONTEXT = task.result ?? ""` for the harness, but the env-vars test in `tests/dispatcher.test.ts:1697-1719` does not assert it. A regression that drops the env var would not be caught. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: test gap — `task_runs.outcome === 'goal_continue'` not asserted on the requeue path** — AC-09 requires the active run to be finalized with `outcome = 'goal_continue'` and `status = 'released'` on a continue verdict. The requeue test asserts the event but not the run row's outcome. A regression that drops the outcome mapping would not be caught. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: judge approximation (intentional v1)** — `isGoalSatisfied()` in `src/dispatcher.ts` treats `exit 0` as a satisfied goal. A `ponytail:` comment names the upgrade path (spawn `task.goal_judge_profile` with the same `KDI_GOAL_*` env vars, parse verdict from `KDI_GOAL_VERDICT_FILE`). Replace with real LLM-as-judge when the judge profile integration lands.

## Acceptance Criteria
- [x] `kdi create "backend: auth" --board myproj --assignee opencode` returns task ID
- [x] Task promoted to ready claimed by dispatcher within 10s
- [x] Harness runs in worktree branch `wt/<profile>/<task_id>`
- [x] Task result stored and visible via `show <task_id>`
- [x] Parent dependency blocks child until parent done
- [x] 100 tasks created + dispatched without SQLite contention
- [x] `kdi --version` returns semantic version
- [x] Adding new harness profile to `profiles.yaml` requires zero code changes

## Hermes Backlog Verification (2026-06-19) — Historical Snapshot

- [x] `scripts/verify-hermes-backlog.sh` runs **89 / 90 PASS** against `main` (a4b2618) with every `FF_*` flag on, temp `HOME` + temp `KDI_DB`
- [x] Full per-item report at `specs/hermes-backlog-verification-2026-06-19.md`
- [x] Backlog updated with a `## Verification (2026-06-19)` section at `specs/hermes-kanban-backlog.md` listing 5 gaps
- [x] ~~**Gap: global `--board` flag**~~ — resolved by **KDI-042** (`FF_GLOBAL_BOARD` / `kdi --board <slug>`)
- [x] ~~**Gap: `kdi boards create --switch`**~~ — resolved by **KDI-043** (`FF_BOARD_CREATE_SWITCH`)
- [x] ~~**Gap: one-shot `kdi dispatch` mode**~~ — resolved by **KDI-034x** / `FF_DISPATCH_ONCE` (`kdi dispatch --once`)
- [x] ~~**Gap: `kdi link` / `kdi unlink` CLI**~~ — resolved by **KDI-026** (`FF_LINK_UNLINK`)
- [ ] **Gap: `kdi specify --tenant <name>` sweep** — still open; `kdi decompose --tenant <name>` exists, but `kdi specify` does not yet support a tenant-only sweep
- [x] `bun test` (836 pass) and `tsc --noEmit` (clean) after adding the verification harness
