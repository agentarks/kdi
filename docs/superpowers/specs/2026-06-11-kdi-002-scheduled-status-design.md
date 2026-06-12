# KDI-002: Scheduled Status — Design

## Goal
Add a `scheduled` task status to KDI that parks a task until a future timestamp, then automatically promotes it to `ready` so the dispatcher can claim it.

## Context
Hermes Kanban includes `scheduled` in its lifecycle: a task waiting on time rather than human input. KDI currently supports `triage | todo | ready | running | done | blocked | archived`. This feature closes that gap.

## Design

### Schema
- Add `'scheduled'` to the `tasks.status` CHECK constraint (via table recreation, following the KDI-001 migration pattern).
- Add `scheduled_at INTEGER` to `tasks`.
- Add `schedule_reason TEXT` to `tasks`.
- Add index `idx_tasks_scheduled_at ON tasks(status, scheduled_at)` for the dispatcher's scheduled scan.

### Model layer (`src/models/task.ts`)
- Extend `TASK_COLUMNS`, `Task`, and `CreateTaskInput` with `scheduled_at` and `schedule_reason`.
- `scheduleTask(id, scheduledAtSeconds, reason?)`:
  - Verifies task exists and is not archived.
  - Rejects `scheduledAtSeconds` that are in the past.
  - Sets `status = 'scheduled'`, `scheduled_at = scheduledAtSeconds`, `schedule_reason = reason ?? null`, `updated_at = unixepoch()`.
  - Emits a `scheduled` event with `{ at: scheduledAtSeconds, reason }`.
- `unblockTask(id, reason?)`:
  - If `status = 'blocked'`: moves to `todo`, clears `block_reason`, emits `unblocked` event.
  - If `status = 'scheduled'`: moves to `ready`, clears `scheduled_at` and `schedule_reason`, emits `ready` event with `{ reason, source: 'unblock' }`.
  - Otherwise throws.
  - Optional `reason` is recorded as a comment before the transition when provided.
- `promoteScheduledTasks(nowSeconds): number`:
  - Updates all non-archived tasks where `status = 'scheduled' AND scheduled_at <= nowSeconds` to `status = 'ready'`, clears `scheduled_at` and `schedule_reason`, sets `updated_at = unixepoch()`.
  - Emits a `ready` event per promoted task with `{ source: 'scheduled' }`.
  - Returns the count promoted.

### Dispatcher (`src/dispatcher.ts`)
- Import `promoteScheduledTasks`.
- At the start of each `tick()`, after `reapStaleClaims()` and before `listReadyTasks()`, call `promoteScheduledTasks(Math.floor(Date.now() / 1000))`.
- This allows a scheduled task to be promoted and claimed in the same tick.

### CLI (`src/commands/tasks.ts`)
- Add `scheduled` to `VALID_STATUSES`.
- New command: `kdi schedule <task_id> --at <timestamp> [--reason <text>]`.
  - Accepts an ISO 8601 string or a Unix timestamp (seconds). Strictly rejects timestamps in the past.
  - Optional `--reason` stored as `schedule_reason` and in the event payload.
- Extend `kdi unblock <task_id> [--reason <text>]`:
  - Works for both `blocked` and `scheduled` tasks.
  - When used on a `scheduled` task, it promotes immediately to `ready` (ignoring `scheduled_at`).

### Events
- New event kinds: `scheduled`, `ready`.
- Existing `unblocked` event behavior is unchanged.

### Testing
- `tests/task.test.ts`:
  - `scheduleTask` sets status, `scheduled_at`, and reason.
  - `unblockTask` on a scheduled task moves it to `ready`.
  - `unblockTask` records reason as a comment when provided.
  - `promoteScheduledTasks` promotes only tasks whose `scheduled_at` has passed.
  - `promoteScheduledTasks` returns count and emits `ready` events.
- `tests/dispatcher.test.ts`:
  - A scheduled task whose time has passed is promoted to `ready` and then claimed/processed in the same tick.
- `tests/db.test.ts`:
  - Verify `'scheduled'` is present in the recreated `tasks` table CHECK constraint.
  - Verify `idx_tasks_scheduled_at` exists.

## Acceptance Criteria
- `kdi schedule 7 --at 2026-06-12T09:00 --reason "wait for deploy"` parks task 7 in `scheduled`.
- `kdi show 7` displays `Status: scheduled` and `Scheduled at: <iso>`.
- The dispatcher promotes the task to `ready` once the scheduled time passes.
- `kdi unblock 7 --reason "deploy landed"` immediately promotes a scheduled task to `ready`.
- `kdi list --status scheduled` lists scheduled tasks.
- All existing tests continue to pass.
