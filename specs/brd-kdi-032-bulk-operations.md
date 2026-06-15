# BRD-KDI-032: Bulk Operations Flags

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Reduce operator toil by letting a single command apply the same lifecycle
operation to many tasks at once. Bulk operations are common during triage
sweeps, incident response, and batch reviews.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can block several tasks with the same reason using
   `kdi block <id1> <id2>... --reason <text>`.
2. As an operator, I can schedule several tasks at once with the existing
   positional syntax `kdi schedule <id1> <id2> --at <timestamp>` (already
   supported).
3. As an operator, I can promote several todo tasks to ready at once with
   `kdi promote <id1> <id2>...`.
4. As an operator, I can promote a task even if its parent dependencies are
   not done by using `kdi promote --force`.
5. As an operator, I can validate whether a set of tasks can be promoted
   without mutating state by using `kdi promote <id1> <id2>... --dry-run`.
6. As an operator, I can permanently delete already-archived tasks with
   `kdi archive --rm <id1> <id2>`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi block <id1> <id2>... --reason <text>` blocks every listed non-archived
  task that is not already blocked. Each successful block emits a `blocked`
  event. If a listed task is already archived, it is skipped and reported. If
  a listed task is already blocked, it is skipped and reported.
- `kdi schedule <id1> <id2>... --at <timestamp> [--reason <text>]` is already
  supported via positional `<task_ids...>` — no `--ids` flag is needed.
  The bulk behavior (multiple IDs, per-task success/skip reporting) is
  inherited from the existing implementation.
- `kdi promote <id1> <id2>...` promotes every listed non-archived task from
  `todo` to `ready`. Each successful promotion emits a `promoted` event. Tasks
  not in `todo`, already archived, or blocked by incomplete parent
  dependencies are skipped and reported.
- `kdi promote <id1> <id2>... --force` promotes every listed non-archived
  task from `todo` to `ready` regardless of parent dependencies. Dependency
  checks are still performed and reported per task, but they do not prevent
  promotion.
- `kdi promote <id1> <id2>... --dry-run` validates whether each listed task
  could be promoted and prints a per-task verdict without mutating state.
  `--dry-run` may be combined with `--force`.
- `kdi archive <task_id>` (without `--rm`) continues to soft-archive a single
  non-archived task.
- `kdi archive --rm <id1> <id2>...` permanently removes already-archived
  tasks from the database. This is a hard delete of the task row, its events,
  runs, comments, attachments metadata, and dependency links. `--rm` is a
  destructive sub-mode of `archive`; when `--rm` is present, the command only
  accepts already-archived task IDs and performs a hard delete. Soft-archive
  and hard-delete are never mixed in a single invocation.
- Passing zero task IDs to a bulk command (e.g. `kdi block --reason x` with
  no IDs) is an error: "At least one task ID is required."
- Bulk operations are processed sequentially in the order given. Each task is
  committed independently so that one failure does not roll back earlier
  successes.
- Output reports the operation and task ID for each success, and a concise
  skip reason for each skipped task.
- Board resolution follows the standard chain for all commands:
  `--board` flag → `KDI_BOARD` env → current-board file → `"default"`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms per task in the bulk set.
- No breaking change to existing single-task `block`, `schedule`, `promote`,
  or `archive` behavior.
- Hard deletes via `archive --rm` are irreversible and require the task to
  already be archived as a safety guard.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_bulk_operations` registered in `src/flags.ts`:
  ```ts
  export const FF_BULK_OPERATIONS = "FF_BULK_OPERATIONS";
  registerFlag(FF_BULK_OPERATIONS, false);
  ```
- Env var form: `FF_BULK_OPERATIONS=false`.
- Defaults to `false` in every environment.
- The following are rejected when the flag is disabled:
  - `block <id>...` with more than one ID
  - `promote <id>...` with more than one ID
  - `promote --force`
  - `promote --dry-run`
  - `archive --rm`
- The base single-task commands (`block <id>`, `schedule <id>...`, `promote
  <id>`, `archive <id>`) remain available without the flag. `schedule <id1>
  <id2>...` positional bulk also works without the flag (it is part of the
  base `schedule` command).

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature uses existing `tasks`,
`task_events`, `task_runs`, `comments`, `dependencies`, and
`task_attachments` tables.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi block <id1> <id2>... --reason <text>` — bulk block.
- `kdi schedule <id1> <id2>... --at <timestamp> [--reason <text>]` —
  bulk schedule (existing positional syntax).
- `kdi promote <id1> <id2>... [--force] [--dry-run]` — bulk promote.
- `kdi promote <task_id> [--force] [--dry-run]` — single-task promote with
  force/dry-run flags.
- `kdi archive <task_id>` — soft-archive a single non-archived task.
- `kdi archive --rm <id1> <id2>...` — permanently delete archived tasks.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `blockTaskBulk(ids, reason)` iterates over `ids`, calls `blockTask(id,
   reason)` for each eligible task, and collects success/skip results.
2. `promoteTaskBulk(ids, options?)` iterates over `ids`, calls
   `promoteTaskAdvanced(id, options)` for each eligible task, and collects
   results.
3. `promoteTaskAdvanced(id, options)` wraps the existing single-task promotion
   with optional dependency override and dry-run support:
   - Load the task. Return `not_found` or `archived` if applicable.
   - If status is not `todo`, return `wrong_status`.
   - Check parent dependencies via `isBlockedByDependencies(id)`. If blocked
     and `options.force` is false, return `blocked_by_dependencies`.
   - If `options.dryRun` is true, return `would_promote`.
   - Otherwise update status to `ready`, emit `promoted`, and return
     `promoted`.
4. `archiveTaskHard(id)` permanently deletes a task and its related rows if
   the task is archived. Deletion order (foreign-key safe):
   1. `task_events` where `task_id = id`
   2. `task_runs` where `task_id = id`
   3. `comments` where `task_id = id`
   4. `task_attachments` where `task_id = id`
   5. `dependencies` where `parent_id = id` or `child_id = id`
   6. The `tasks` row itself
   If the task is not found or is not archived, return an error without
   deleting anything.
5. Board resolution happens in the command handler; model helpers receive a
   resolved `board_id` so that task IDs are scoped to the resolved board.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- `blocked`, `scheduled`, and `promoted` events continue to be emitted per
  task by the underlying single-task helpers.
- Hard-deleted tasks leave no events because their rows are removed.

-------------------------------------------------------------------------------
Dry-Run Output Format
-------------------------------------------------------------------------------
`--dry-run` prints one human-readable line per task:

```
<task_id>: <verdict> [detail]
```

Verdicts:
- `would_promote` — task is in `todo` and dependencies are satisfied (or
  `--force` bypasses them).
- `skipped: <reason>` — task is archived, not in `todo`, blocked by
  dependencies (without `--force`), or not found.

Example:
```
1: would_promote
2: skipped: blocked_by_dependencies
3: skipped: wrong_status
```

-------------------------------------------------------------------------------
Exit Codes
-------------------------------------------------------------------------------
- Exit `0` if every supplied ID is processed successfully.
- Exit `1` if any ID is skipped or errored.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_BULK_OPERATIONS=true kdi block 1 2 3 --reason "waiting on api"`
      blocks the listed non-archived tasks and emits a `blocked` event for
      each.
- [ ] `FF_BULK_OPERATIONS=true kdi block 1 2 --reason "x"` skips already
      archived or blocked tasks and reports the reason.
- [ ] `FF_BULK_OPERATIONS=true kdi schedule 1 2 --at 2026-06-15T10:00:00Z --reason "later"`
      schedules the listed non-archived tasks (uses existing positional bulk).
- [ ] `FF_BULK_OPERATIONS=true kdi schedule 1 2 --at 2026-06-15T10:00:00Z` skips already
      scheduled or archived tasks and reports the reason. Bulk schedule works
      without the flag because it is the base command.
- [ ] `FF_BULK_OPERATIONS=true kdi promote 1 2` promotes the listed todo
      tasks to ready.
- [ ] `FF_BULK_OPERATIONS=true kdi promote 1 2 --force` promotes todo
      tasks even when parent dependencies are not done.
- [ ] `FF_BULK_OPERATIONS=true kdi promote 1 2 --dry-run` prints a
      verdict for each task without changing any task status.
- [ ] `FF_BULK_OPERATIONS=true kdi promote 1 2 --force --dry-run` prints
      the forced-promote verdict without mutating state.
- [ ] `FF_BULK_OPERATIONS=true kdi promote 5 --force` promotes a single todo
      task even when parent dependencies are not done.
- [ ] `FF_BULK_OPERATIONS=true kdi promote 5 --dry-run` prints a single-task
      dry-run verdict.
- [ ] `FF_BULK_OPERATIONS=true kdi archive --rm 10 11` permanently deletes the
      archived tasks and their related rows.
- [ ] `FF_BULK_OPERATIONS=true kdi archive --rm 10` rejects a non-archived
      task with a clear error.
- [ ] `FF_BULK_OPERATIONS=false kdi block 1 2 --reason "x"` exits with
      "Bulk operations feature is not enabled."
- [ ] `kdi schedule 1 2 --at 2026-06-15T10:00:00Z` works when the flag is
      disabled (bulk schedule is part of the base command, not gated).
- [ ] `FF_BULK_OPERATIONS=false kdi promote 1 2` exits with the same
      feature-disabled error.
- [ ] `FF_BULK_OPERATIONS=false kdi promote --force 1` exits with the same
      feature-disabled error.
- [ ] `FF_BULK_OPERATIONS=false kdi promote --dry-run 1` exits with the same
      feature-disabled error.
- [ ] `FF_BULK_OPERATIONS=false kdi archive --rm 10` exits with the same
      feature-disabled error.
- [ ] `kdi block --reason "x"` (no IDs) exits with "At least one task ID is
      required."
- [ ] Single-task `block <id>`, `schedule <id>...`, `promote <id>`, and
      `archive <id>` continue to work when the flag is disabled.
- [ ] Unit and CLI tests cover block bulk, promote bulk/force/dry-run,
      archive hard-delete safety, and flag gating per operation.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Bulk promotion with `--force` could violate intended dependency
  ordering. **Mitigation:** `--force` is opt-in and reports which dependencies
  were bypassed.
- **Risk:** `archive --rm` is destructive. **Mitigation:** require the task to
  already be archived; do not add an `--rm` shortcut to the base archive
  command.
- **Risk:** Mixed success/skip output could be hard to parse by scripts.
  **Mitigation:** human-readable reporting only; machine parsing is out of
  scope for KDI-032.
- **Design note:** Bulk IDs use positional variadic arguments to align with
  the existing `kdi complete <id1> <id2>...` convention. The backlog entries
  that mention `--ids` are reinterpreted as bulk positional syntax because
  `kdi complete` already established the variadic-ID pattern in KDI.
- **Design note:** `schedule` already accepts multiple task IDs via positional
  `<task_ids...>`. The backlog entry `kdi schedule --ids <id1> <id2>` is
  satisfied by the existing positional bulk syntax; no code changes are
  needed for schedule apart from verifying per-task success/skip reporting.
- **Design note:** `archive --rm` is a destructive sub-mode of `archive` that
  only accepts already-archived task IDs. The base `archive <id>` command
  continues to soft-archive a single non-archived task.
- **Open question:** Should bulk IDs accept comma-separated values in addition
  to space-separated? This BRD limits it to space-separated positional IDs to
  match Commander variadic argument conventions.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`blockTask`, `scheduleTask`, `promoteTask`,
  `archiveTask`; new `archiveTaskHard`).
- `src/models/dependency.ts` (`isBlockedByDependencies`).
- `src/models/taskEvent.ts` (`addEvent`).
- `src/commands/tasks.ts` (`blockTaskCommand`, `scheduleTaskCommand`,
  `promoteTaskCommand`, `archiveTaskCommand`; board resolution).
- `src/flags.ts` (`FF_BULK_OPERATIONS`).
- `specs/feature-flags.md` (registry entry for `ff_bulk_operations`).
