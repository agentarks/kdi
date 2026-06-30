# Specification: KDI-UI-010 — Notification Subscriptions UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-010: Notification subscriptions UI`.
> Scope of this document: the **full** KDI-UI-010 item — a browser operator UI for managing KDI notification subscriptions. This is a **spec-writing task**, not an implementation. All behavior contracts are validated against the live CLI/model source (`src/commands/notify.ts`, `src/models/notifySub.ts`, `src/notifiers.ts`, `src/flags.ts`, `specs/feature-flags.md`).

---

## 1. Business Goal

Give operators a browser UI to manage KDI notification subscriptions for the current board and for individual tasks. The UI must support the same operations as the CLI (`notify-subscribe`, `notify-list`, `notify-unsubscribe`): list global (board-scoped) subscriptions, list per-task subscriptions, subscribe with platform/chat/thread/user/notifier-profile fields, and unsubscribe. It must also expose an archived/unsubscribed toggle so operators can review historical subscriptions. All behavior is gated by `FF_NOTIFY_SUBS` and the master `FF_SVELTEKIT_FRONTEND` flag.

---

## 2. Problem Statement

KDI's notification subscription commands (`notify-subscribe`, `notify-list`, `notify-unsubscribe`) are CLI-only. Operators must know the exact task ID, platform name, and notifier profile to manage subscriptions. The SvelteKit UI has no screen for this, so operators cannot visually browse active subscriptions, see which tasks have subscribers, or unsubscribe without reconstructing the original CLI arguments. A UI screen reduces errors and makes subscription state discoverable.

---

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web/` SvelteKit app scaffolded; `FF_SVELTEKIT_FRONTEND` registered in `src/flags.ts` (InDev, default `false`) and `VITE_FF_SVELTEKIT_FRONTEND` available to the browser; AGENTS.md amended to permit `apps/web/`; CLI `bun run build` and SvelteKit build/dev work with isolated `KDI_DB`.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions can call existing KDI model code (`src/models/*`) and return UI-shaped JSON. SQLite access stays server-side only. The bridge must expose `showBoard`, `listSubscriptions`, `subscribe`, and `unsubscribe` for this screen (and the task-detail route must be reachable from KDI-UI-005, even if it is a stub).
- **KDI-025 — notification subscriptions backend.** `FF_NOTIFY_SUBS` registered in `src/flags.ts` and `specs/feature-flags.md` (InDev, default `false`). `src/models/notifySub.ts` (`subscribe`, `listSubscriptions`, `unsubscribe`), `src/commands/notify.ts`, and `src/notifiers.ts` (`getNotifier`, `loadNotifiers`) are implemented and stable.
- **Notifier profiles configured.** The UI validates a chosen notifier profile against the configured profile set (default path `~/.config/kdi/notifiers.yaml`, overridable by `KDI_NOTIFIERS_PATH`). The `log` notifier profile is always available as a built-in.

KDI-UI-010 adds **only** SvelteKit routes, loaders, and components for subscription management. It must not modify `src/models/*`, `src/commands/*`, `src/notifiers.ts`, `src/db.ts`, or `src/flags.ts` beyond imports. If a needed JSON shape is missing, the gap is raised against KDI-UI-001, not patched here.

---

## 4. Decision Options

1. **Top-level `/notifications` route plus per-task `/tasks/[id]/notifications`.** The global list resolves the current board; the per-task list is scoped to one task. Subscribe/unsubscribe forms live on the per-task page. The global list is read-only except for row-level unsubscribe actions. **Chosen.** Matches the CLI semantics (`notify-list` without a task ID uses the current board; `notify-subscribe`/`notify-unsubscribe` require a task ID) and keeps the global list focused on board-wide discovery.
2. **All subscription management on a single board-scoped page.** Combine global and per-task subscribe into one `/boards/[slug]/notifications` route. This conflates the two list scopes and makes the per-task subscribe flow awkward. Rejected.
3. **Subscribe from the global list without a task context.** The CLI requires a task ID for `notify-subscribe`; allowing global subscribe would introduce new behavior not in the model. Rejected.

---

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| Global subscription list | `notify-list --board <slug>` prints a table of subscriptions for the current board | `/notifications` renders a table of all subscriptions for the resolved board |
| Per-task subscription list | `notify-list <task_id>` prints a table of subscriptions for one task | `/tasks/[id]/notifications` renders a table of subscriptions for that task |
| Subscribe | `notify-subscribe <task_id> --platform <name> --chat-id <id> [--thread-id ...] [--user-id ...] [--notifier-profile ...]` | Subscribe form on the per-task page with the same fields |
| Unsubscribe | `notify-unsubscribe <task_id> --platform <name> --chat-id <id> [--thread-id ...]` | Unsubscribe button on each subscription row (global or per-task) |
| Archived/unsubscribed toggle | `notify-list --board <slug> --archived` includes soft-unsubscribed rows | "Include unsubscribed" toggle on both list pages |
| Notifier profile | `--notifier-profile` defaults to the platform name; validated against `notifiers.yaml` | Notifier profile input defaults to the selected platform; server validates via `getNotifier` |
| Duplicate prevention | CLI/model reject duplicate (task, platform, chat, thread) while active | Same validation surfaced inline on the subscribe form |
| Validation errors | CLI exits with error text | Inline form errors with the same text |

---

## 6. Functional Requirements

### 6.1 Global subscription list (`/notifications`)

- **FR-1** A read-only `/notifications` route provides a `+page.server.ts` load function that resolves the board via `readCurrentBoard()` → `"default"` fallback, then loads the board via `showBoard(slug, false)`. It returns the board metadata plus the active subscriptions from `listSubscriptions(undefined, includeArchived, board.id)`. If the board is missing or archived, the page renders an inline `Board "..." not found.` error; the app shell is still rendered.
- **FR-2** The list table renders, for each subscription: `id`, `task_id` (with a link to `/tasks/[id]/notifications`), `platform`, `chat_id`, `thread_id` (when set), `user_id` (when set), `notifier_profile`, `subscribed_at` (relative time), and `unsubscribed_at` (when the archived toggle is on and the row is unsubscribed). The default sort is `subscribed_at DESC` (the model's default).
- **FR-3** An "Include unsubscribed" toggle switches `includeArchived` between `false` and `true`, re-runs the loader, and updates the query string (e.g., `?archived=1`). When off, only active subscriptions are shown. When on, unsubscribed rows are visually distinguished (dimmed + "unsubscribed" tag) and include the `unsubscribed_at` timestamp.
- **FR-4** When the board has no active subscriptions, the page shows a clear empty state with a link to the task list/board view so the operator can navigate to a task and subscribe.

### 6.2 Per-task subscription list (`/tasks/[id]/notifications`)

- **FR-5** A read-only `/tasks/[id]/notifications` route loads the task via `showTask(id)` (404 if missing or archived) and returns the task summary plus the active subscriptions from `listSubscriptions(task.id, includeArchived)`. It also returns the current board metadata and the board slug so the page can link back to the board view.
- **FR-6** The list table renders the same columns as the global list, but scoped to the task. The task summary (title, status, id) is shown above the table. Active subscriptions are shown by default; the same "Include unsubscribed" toggle as FR-3 applies.
- **FR-7** When the task has no subscriptions, the page shows an empty state with the subscribe form visible, prompting the operator to add a subscription.

### 6.3 Subscribe form

- **FR-8** A subscribe form is rendered on the per-task page (`/tasks/[id]/notifications`) and submitted via a SvelteKit form action. The form requires:
  - `platform` — one of `telegram`, `slack`, `discord`, `webhook` (dropdown, normalized to lowercase server-side).
  - `chat_id` — free-text input, required (e.g., channel ID, webhook URL, or chat identifier; no extra validation beyond non-empty).
  - `thread_id` — optional free-text input (thread/topic ID).
  - `user_id` — optional free-text input (user mention).
  - `notifier_profile` — optional free-text input; when empty, the server defaults to the selected `platform` value (matching `options.notifierProfile ?? platform`).
- **FR-9** The server action validates the selected notifier profile via `getNotifier(profile)` before calling `subscribe`. If the profile is missing or misconfigured, it returns the model error verbatim (`Notifier profile '...' not found.` or `Notifier profile '...' is missing required config key '...'.`).
- **FR-10** The server action calls `subscribe(taskId, platform, chatId, { threadId, userId, notifierProfile })`. On success, it re-renders the per-task page with the new subscription visible and a success message. On failure, the form stays mounted with values preserved and the error inline.
- **FR-11** Duplicate active subscriptions are rejected with the same messages as the model:
  - No-thread duplicate: `A subscription for this task + platform + chat already exists (no thread). Use --thread-id to add a thread-scoped subscription.`
  - Thread duplicate: `A subscription for this task + platform + chat + thread already exists.`
- **FR-12** Unsupported platforms are rejected with `Unsupported platform. Valid platforms: telegram, slack, discord, webhook.`
- **FR-13** Subscribing to a missing or archived task is rejected with `Task <id> not found.` (from the model).

### 6.4 Unsubscribe action

- **FR-14** Each subscription row on both the global and per-task lists has an "Unsubscribe" action. The action submits a SvelteKit form action with the subscription's `task_id`, `platform`, `chat_id`, and `thread_id` (when set).
- **FR-15** The server action calls `unsubscribe(taskId, platform, chatId, threadId)`. On success, the page re-renders with the row now marked as unsubscribed (if the "Include unsubscribed" toggle is on) or removed from the active list (if the toggle is off). On failure, it returns the error inline (`No active subscription found.`).
- **FR-16** Unsubscribe without a `thread_id` removes all matching active subscriptions for that task/platform/chat (including any thread-scoped ones), matching the model behavior. Thread-scoped unsubscribe removes only the matching thread subscription. The UI does not need a separate confirmation dialog; the action is reversible only by re-subscribing.

### 6.5 Board and task resolution

- **FR-17** The global list uses the same board-resolution subset as KDI-UI-003: `?board=<slug>` query parameter, then `readCurrentBoard()`, then `"default"`. The browser has no `--board` or `KDI_BOARD` env context, so the URL query parameter is the only way to target a non-current board in the UI.
- **FR-18** The per-task page resolves the task via `showTask(id)`. A missing or archived task renders a 404 / `Task <id> not found.` message. The task must belong to the resolved board; if it does not, the loader returns `404 { error: "task_not_found" }` or an inline error, matching the CLI's behavior of operating on whatever task ID is supplied (the model itself does not enforce board membership on `showTask`, so the UI may optionally verify `task.board_id === board.id` for consistency).

### 6.6 Cross-cutting

- **FR-19** The whole UI renders only when `FF_SVELTEKIT_FRONTEND` is enabled (server-side gate via `hooks.server.ts`). The per-feature gate is `FF_NOTIFY_SUBS`: when `FF_NOTIFY_SUBS=false`, the routes still exist but return a disabled state (`503 { enabled: false }` or an inline "Notification subscriptions feature is not enabled." message), and no subscription mutations occur.
- **FR-20** KDI-UI-010 adds only SvelteKit routes and components. It imports existing model functions: `showBoard`, `readCurrentBoard`, `showTask`, `listSubscriptions`, `subscribe`, `unsubscribe`, `getNotifier`, and `isEnabled`/`FF_*` constants. It must not modify `src/models/*`, `src/commands/*`, `src/notifiers.ts`, `src/db.ts`, or `src/flags.ts`.
- **FR-21** All response data is normalized to camelCase at the route boundary (same convention as KDI-UI-001). The client component receives `{ board, task?, subscriptions, flags, filters }`.

---

## 7. Scope

In scope:
- Read-only `/notifications` route for the global (board-scoped) subscription list.
- Read-only `/tasks/[id]/notifications` route for the per-task subscription list and subscribe form.
- Subscribe form on the per-task page: platform, chat id, thread id, user id, notifier profile.
- Unsubscribe action on each subscription row (global and per-task).
- "Include unsubscribed" toggle on both list pages.
- Server-side validation of notifier profiles via `getNotifier`.
- Feature flag gating for `FF_NOTIFY_SUBS` and the master `FF_SVELTEKIT_FRONTEND`.

Out of scope (explicitly):
- SvelteKit scaffolding / `apps/web` / `FF_SVELTEKIT_FRONTEND` registration (KDI-UI-000).
- General server-side data bridge framework (KDI-UI-001); only the narrow loaders/actions these routes need.
- Editing existing subscriptions (e.g., changing the notifier profile or chat id). The model does not support this; the operator must unsubscribe and re-subscribe.
- Creating or editing notifier profiles from the UI (KDI-056/ops concerns; the UI only consumes them).
- Sending test notifications or configuring the notifier watcher. The watcher runs in the dispatcher; this UI only manages subscriptions.
- Real-time delivery status or delivery logs for notifications (deferred to KDI-UI-008 activity view if needed).
- Bulk subscribe/unsubscribe across multiple tasks.
- Any change to CLI commands, models, the notifier system, db schema, or flag semantics.

---

## 8. Acceptance Criteria

- **AC-01 (global list)** The `/notifications` route resolves the current board, loads active subscriptions via `listSubscriptions(undefined, false, board.id)`, and renders them in a table with `id`, `task_id`, `platform`, `chat_id`, `thread_id`, `user_id`, `notifier_profile`, and `subscribed_at`.
- **AC-02 (global list archived toggle)** The "Include unsubscribed" toggle on `/notifications` adds `?archived=1`, includes unsubscribed subscriptions, and visually distinguishes them. With the toggle off, unsubscribed rows are not shown.
- **AC-03 (global list empty state)** When the board has no active subscriptions, `/notifications` shows an empty state with a link to navigate to a task.
- **AC-04 (per-task list)** The `/tasks/[id]/notifications` route loads the task and its subscriptions, renders the task summary, and lists the same columns as the global list.
- **AC-05 (per-task subscribe form)** The per-task page renders a subscribe form with platform dropdown, chat id, thread id, user id, and notifier profile fields. Submitting it calls `subscribe` and adds the row to the list.
- **AC-06 (notifier profile default)** When the notifier profile field is left empty, the server defaults to the selected platform name (e.g., platform `telegram` → profile `telegram`) and validates it via `getNotifier`.
- **AC-07 (notifier profile validation)** Submitting a subscribe form with a missing or misconfigured notifier profile returns the model error verbatim and preserves the form values.
- **AC-08 (duplicate subscription)** Submitting a subscribe form that duplicates an active (task, platform, chat, thread) subscription returns the model's duplicate error message and does not create a second row.
- **AC-09 (unsupported platform)** The platform dropdown contains only `telegram`, `slack`, `discord`, and `webhook`; a direct POST with an unsupported platform is rejected with the CLI error text.
- **AC-10 (unsubscribe from per-task list)** Clicking "Unsubscribe" on a per-task row calls `unsubscribe` and removes the row from the active list (or marks it unsubscribed when the archived toggle is on).
- **AC-11 (unsubscribe from global list)** Clicking "Unsubscribe" on a global row uses the row's `task_id`, `platform`, `chat_id`, and `thread_id` to call `unsubscribe` and updates the list.
- **AC-12 (thread-scoped unsubscribe)** Unsubscribing a thread-scoped row leaves the no-thread subscription for the same task/platform/chat intact, matching the model.
- **AC-13 (no-thread unsubscribe removes all)** Unsubscribing a no-thread row removes all active subscriptions for that task/platform/chat, including thread-scoped ones, matching the model.
- **AC-14 (flag gate)** With `FF_NOTIFY_SUBS=false`, the routes signal disabled and do not mutate subscriptions; with it on, all controls work. With `FF_SVELTEKIT_FRONTEND=false`, the app-level disabled screen is shown.
- **AC-15 (no code churn)** No file under `src/models`, `src/commands`, `src/notifiers.ts`, `src/db.ts`, or `src/flags.ts` is modified (review-enforced; only imports).
- **AC-16 (UI smoke)** A smoke test using temp `HOME` + temp `KDI_DB` with `FF_NOTIFY_SUBS=true` can: create a board and task → subscribe to the task via the per-task UI → verify the subscription appears in the global list → toggle "Include unsubscribed" → unsubscribe from the global list → verify the active list is empty and the unsubscribed row appears only when the toggle is on. The test passes `bun run lint`, CLI `bun run build`, and the SvelteKit build.

---

## 9. Risks / Open Questions / Gaps

- **Blocked on KDI-UI-000/001/025:** this item cannot start until the shell, bridge, and notification subscription backend exist. Mitigation: §3 makes the gates explicit; no backend code is bundled here.
- **Notifier profile configuration is external.** The UI cannot create or edit notifier profiles; it only validates against `~/.config/kdi/notifiers.yaml` (or `KDI_NOTIFIERS_PATH`). If no profiles are configured, the only usable profile is the built-in `log`. A future ops/KDI-056 slice could expose profile management in the UI.
- **Chat ID / webhook URL free-text input.** The model does not validate the format of `chat_id` or `chat_id`-like values for webhooks; the operator is responsible for entering correct values, matching the CLI. The UI provides a native text input with no masking.
- **Thread ID and user_id semantics are platform-specific.** The model stores them as opaque strings; the UI does not explain platform-specific formatting. A follow-up slice could add per-platform placeholders or help text.
- **No subscription editing.** The model only supports create/delete (soft unsubscribe). The operator must re-subscribe to change a notifier profile or chat ID. This is documented as intentional, not a gap to fix here.
- **Global list N+1 task lookup.** The global list renders one row per subscription and links to each task. `listSubscriptions` returns `task_id` only; the loader may call `showTask` per row if task titles are needed. At expected subscription counts this is acceptable; a future KDI-001 enhancement could add a board-wide subscription view with task titles in one query.
- **Board membership enforcement.** The model does not enforce that a task belongs to the resolved board when subscribing or unsubscribing; the UI may optionally verify this for consistency, but it is not required by the CLI contract.
- **URL conventions.** The global list uses `/notifications` and the per-task list uses `/tasks/[id]/notifications`. If KDI-UI-005 adopts a different task detail URL scheme, the per-task route should align with it (e.g., `/tasks/[id]/subscriptions` vs `/tasks/[id]/notifications`). This spec recommends `/notifications` for consistency with the `notify-*` command family.

---

## 10. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. Gates the **whole** UI. Inherited from KDI-UI-000; this item adds no new master flag.
- `ff_notify_subs` / `FF_NOTIFY_SUBS` (browser: `VITE_FF_NOTIFY_SUBS` once client nav exists), default `false`, status `InDev`. Gates the notification subscriptions feature. This item reuses the existing flag; it does not introduce a new flag.
- **Rollback / deactivation:** Set `FF_SVELTEKIT_FRONTEND=false` to hide the entire UI; set `FF_NOTIFY_SUBS=false` to disable the subscriptions routes and reject all subscribe/unsubscribe mutations while leaving the rest of the UI intact.
- **Deprecation plan:** N/A (additive UI).

---

## 11. Dependencies / Model surface this item consumes

Validated live in `src/models/notifySub.ts`, `src/models/task.ts`, `src/models/board.ts`, and `src/notifiers.ts`:

- `NotifySub` interface: `id`, `task_id`, `platform`, `chat_id`, `thread_id`, `user_id`, `notifier_profile`, `subscribed_at`, `unsubscribed_at`.
- `subscribe(taskId, platform, chatId, options: { threadId?, userId?, notifierProfile? })` → returns `NotifySub`.
- `listSubscriptions(taskId?, includeArchived?, boardId?)` → returns `NotifySub[]`.
- `unsubscribe(taskId, platform, chatId, threadId?)` → returns the number of rows soft-deleted.
- `showTask(id)` → returns `Task | null` (used for the per-task page).
- `showBoard(slug, false)` and `readCurrentBoard()` → used to resolve the board for the global list.
- `getNotifier(name)` and `loadNotifiers()` → used to validate the chosen notifier profile before subscribing.
- `isEnabled(flag)` and `FF_NOTIFY_SUBS` / `FF_SVELTEKIT_FRONTEND` constants from `src/flags.ts`.

No new model functions or SQL are introduced by this item.

---

## 12. Verification Notes

Implementation should prove:
- A smoke test with temp `HOME` + temp `KDI_DB` (same pattern as `kdi-new-feature-loop` and `AGENTS.md` worktree isolation) creates a board and task, subscribes via the per-task UI, verifies the subscription appears in the global list, unsubscribes from the global list, and verifies the archived toggle behavior.
- The smoke test verifies that disabled flags (`FF_NOTIFY_SUBS=false` or `FF_SVELTEKIT_FRONTEND=false`) prevent mutations and show the disabled state.
- The smoke test verifies that duplicate subscription attempts, unsupported platforms, and missing notifier profiles return the same errors as the CLI.
- `bun run lint`, CLI `bun run build`, and the SvelteKit build all pass with isolated `KDI_DB`.

---

## 13. Spec Location

`specs/sveltekit-ui/KDI-UI-010-notification-subscriptions-ui.md`

---

## 14. Worktree Branch Name

`feat/kdi-ui-010-notification-subscriptions-ui`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec authoring for this item is non-editing and runs in the shared checkout.)

---

## 15. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-010: Notification Subscriptions UI — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-010-notification-subscriptions-ui.md`
- [ ] `/notifications` global list shows active/unsubscribed subscriptions for the current board
- [ ] `/tasks/[id]/notifications` per-task list shows subscriptions and a subscribe form
- [ ] Subscribe form covers platform, chat id, thread id, user id, and notifier profile; validates via `getNotifier`
- [ ] Unsubscribe action on each row calls `unsubscribe` with the same task/platform/chat/thread semantics as the CLI
- [ ] Smoke test with temp HOME/KDI_DB proves subscribe/list/unsubscribe round-trip matches `notify-subscribe/list/unsubscribe`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass with isolated `KDI_DB`
```
