# BRD-KDI-048: Fix Bulk Archive

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Restore Hermes parity for the `kdi archive` command. Hermes accepts multiple
task IDs in a single `archive` invocation and soft-archives each eligible task.
KDI's help text currently advertises `[task_ids...]`, but the command rejects
more than one ID. This BRD makes bulk soft-archive work and keeps the existing
`--rm` sub-mode for hard-deleting already-archived tasks.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can archive several done tasks at once with
   `kdi archive 1 2 3` instead of running three separate commands.
2. As an operator, I can still permanently delete already-archived tasks with
   `kdi archive --rm 10 11`.
3. As a script author, I can rely on `kdi archive` to process every supplied
   ID, report per-task results, and continue past IDs that are already
   archived or missing.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
Current behavior (broken):

```
$ kdi archive 1 2
Error: Archive only supports a single task ID (use --rm for bulk deletion of archived tasks)
```

The command help advertises `kdi archive [options] [task_ids...]`, so users
expect variadic IDs to work. Bulk `--rm` of already-archived tasks already
works, but bulk soft-archive does not.

Desired behavior:

```
$ kdi archive 1 2 3
Archived task 1
Archived task 2
Skipped task 3: already archived
```

- `kdi archive <id1> <id2>...` soft-archives every supplied non-archived task.
- `kdi archive --rm <id1> <id2>...` continues to hard-delete only already-archived tasks.
- Soft-archive and hard-delete are never mixed in one invocation (`--rm` switches modes).
- Each task is reported individually; exit `0` only when every ID is processed
  successfully (soft-archived or hard-deleted), exit `1` if any ID is skipped
  or errored.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi archive <id1> <id2>...` archives every listed task that exists, is
  non-archived, and has a status other than `archived`. Each successful
  archive updates `tasks.status` to `archived`, sets `tasks.archived_at`,
  updates `tasks.updated_at`, and emits an `archived` event.
- `kdi archive --rm <id1> <id2>...` permanently deletes every listed task that
  is already archived. Deletion order must remain foreign-key safe (events,
  runs, comments, attachments, dependencies, then the task row).
- Passing zero task IDs is an error: "At least one task ID is required."
- When `--rm` is absent and an ID refers to a task that is already archived,
  that ID is skipped and reported as `skipped: already archived`.
- When `--rm` is absent and an ID is not found, that ID is skipped and
  reported as `skipped: not found`.
- When `--rm` is present and an ID refers to a non-archived task, that ID is
  skipped and reported as `skipped: not archived`.
- Tasks are processed sequentially in the order supplied. Each task is
  committed independently so that one failure does not roll back earlier
  successes.
- The command emits a single `archived` event per successfully archived task.
- Hard-deleted tasks leave no events because their rows are removed.
- Board resolution follows the standard chain: `--board` flag → `KDI_BOARD`
  env → current-board file → `"default"`.

-------------------------------------------------------------------------------
CLI Syntax and Examples
-------------------------------------------------------------------------------
Soft-archive multiple tasks:

```bash
kdi archive 1 2 3
```

Soft-archive a single task (unchanged behavior):

```bash
kdi archive 5
```

Permanently delete already-archived tasks:

```bash
kdi archive --rm 10 11
```

With explicit board:

```bash
kdi archive 1 2 --board myproj
```

Example output for mixed results:

```
Archived task 1
Archived task 2
Skipped task 3: already archived
```

-------------------------------------------------------------------------------
Transaction / Safety Semantics
-------------------------------------------------------------------------------
- **Soft-archive vs hard-delete:** Without `--rm`, the command performs a soft
  archive (status transition + `archived_at` timestamp). With `--rm`, the
  command performs a hard delete of already-archived rows. The two modes are
  mutually exclusive; `--rm` changes the command's entire behavior.
- **Partial failure handling:** Each ID is processed in its own implicit
  transaction. A failure for one ID does not roll back prior successes. The
  command reports every ID and exits `1` if any ID was skipped or errored.
- **Idempotency:** Soft-archiving an already-archived task is a no-op skip,
  not an error. Hard-deleting a missing task is a skip with reason
  `not found`. Hard-deleting an already-deleted ID is therefore also a skip.
- **Foreign-key safety for hard-delete:** The hard-delete path must delete
  related rows before the task row in this order:
  1. `task_events`
  2. `task_runs`
  3. `comments`
  4. `task_attachments`
  5. `dependencies` (both `parent_id` and `child_id`)
  6. `tasks`
- **Active-task safety:** Soft-archiving a running/claimed task is allowed;
  the archive operation simply transitions the status to `archived`. The
  dispatcher already treats archived tasks as ineligible for claim. This
  matches Hermes behavior and avoids adding extra guardrails beyond the
  existing archive path.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- This BRD reuses the existing `ff_bulk_operations` / `FF_BULK_OPERATIONS`
  flag registered for KDI-032.
- The following are rejected when the flag is disabled:
  - `kdi archive <id1> <id2>...` with more than one ID
  - `kdi archive --rm <id>...` (any use of `--rm`)
- The base single-task soft-archive command (`kdi archive <id>`) remains
  available without the flag.
- When the flag is disabled and a rejected form is used, the CLI exits with
  the standard feature-disabled message: "Bulk operations feature is not
  enabled."

-------------------------------------------------------------------------------
Schema / Model Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature uses the existing `tasks`,
`task_events`, `task_runs`, `comments`, `task_attachments`, and `dependencies`
tables.

Model assumptions:
- `tasks.archived_at` is nullable and is set to the current Unix epoch on soft
  archive.
- `tasks.status` has an `archived` value in its CHECK constraint.
- The existing `archiveTask(id)` single-task helper performs the soft-archive
  UPDATE and event emission.
- The existing `archiveTaskHard(id)` helper performs the foreign-key-safe
  hard-delete transaction and validates that the task is already archived.
- The board is resolved by the command handler before task IDs are looked up,
  so task IDs are scoped to the resolved board.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. Add a new `archiveTaskBulk(ids: number[])` model helper that iterates over
   `ids`, calls the existing `archiveTask(id)` for each eligible task, and
   collects per-task results. Results include:
   - `archived` — task was found, non-archived, and soft-archived.
   - `skipped: already_archived` — task exists but is already archived.
   - `skipped: not_found` — task does not exist in the resolved board.
2. Reuse the existing `archiveTaskHard(id)` helper for the `--rm` path. The
   command layer iterates over IDs, calls `archiveTaskHard(id)` for each
   archived task, and collects results. Existing `archiveTaskHard` already
   throws for non-archived or missing tasks; the command layer catches these
   and converts them to `skipped: not_archived` / `skipped: not_found`
   results.
3. Board resolution happens in the command handler; model helpers receive a
   resolved `board_id` so that task IDs are scoped to the resolved board.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- An `archived` event is recorded per successfully soft-archived task via the
  existing `archiveTask` helper.
- Hard-deleted tasks leave no events because their rows are removed.

-------------------------------------------------------------------------------
Exit Codes
-------------------------------------------------------------------------------
- Exit `0` if every supplied ID is processed successfully (soft-archived or
  hard-deleted).
- Exit `1` if any ID is skipped or errored.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_BULK_OPERATIONS=true kdi archive 1 2 3` soft-archives tasks 1, 2,
      and 3 and emits an `archived` event for each.
- [ ] `FF_BULK_OPERATIONS=true kdi archive 1 2 3` skips any already-archived
      ID and reports `skipped: already archived`.
- [ ] `FF_BULK_OPERATIONS=true kdi archive 1 2 3` skips any missing ID and
      reports `skipped: not found`.
- [ ] `FF_BULK_OPERATIONS=true kdi archive --rm 10 11` permanently deletes
      the already-archived tasks and their related rows.
- [ ] `FF_BULK_OPERATIONS=true kdi archive --rm 10` rejects a non-archived
      task with `skipped: not archived` and exits `1`.
- [ ] `FF_BULK_OPERATIONS=true kdi archive 5` continues to soft-archive a
      single task.
- [ ] `FF_BULK_OPERATIONS=false kdi archive 1 2` exits with
      "Bulk operations feature is not enabled."
- [ ] `FF_BULK_OPERATIONS=false kdi archive --rm 10` exits with the same
      feature-disabled error.
- [ ] `FF_BULK_OPERATIONS=false kdi archive 5` continues to soft-archive a
      single task.
- [ ] `kdi archive` with no IDs exits with "At least one task ID is required."
- [ ] `kdi archive 1 2 --board myproj` resolves board `myproj` before
      archiving the tasks.
- [ ] Unit and CLI tests cover bulk soft-archive, bulk `--rm` safety, skip
      reporting, flag gating, and zero-ID error handling.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Bulk soft-archive of active/running tasks could orphan a worker.
  **Mitigation:** Matches Hermes behavior; archived tasks are ignored by the
  dispatcher's claim loop, and reclaim is not attempted automatically. The
  operator can `kdi reclaim` first if needed.
- **Risk:** Mixed success/skip output is human-readable only. **Mitigation:**
  Machine parsing is out of scope for KDI-048; a future `--json` mode could be
  added if needed.
- **Open question:** Should bulk archive support comma-separated IDs in
  addition to space-separated? This BRD limits it to space-separated
  positional IDs to match Commander variadic argument conventions and the
  existing `kdi complete <id1> <id2>...` pattern.

-------------------------------------------------------------------------------
Migration / Test Notes
-------------------------------------------------------------------------------
- No database migration is required.
- No new feature flag registration is required; `ff_bulk_operations` already
  exists in `src/flags.ts` and `specs/feature-flags.md`.
- Update the `archive` command registration in `src/commands/tasks.ts` so that
  it accepts variadic positional IDs and routes to `archiveTaskBulk` or the
  existing `archiveTaskHard` loop based on whether `--rm` is present.
- Update command help text to reflect that multiple task IDs are accepted for
  both soft-archive and `--rm`.
- Add unit tests for `archiveTaskBulk` covering:
  - all IDs archived successfully
  - already-archived ID skipped
  - missing ID skipped
  - mixed results
- Add CLI tests covering:
  - bulk soft-archive with flag enabled
  - bulk `--rm` with flag enabled
  - feature-disabled rejection for both forms
  - single-task archive unchanged behavior with flag disabled
  - zero-ID error
- Verify that the existing `archiveTaskHard` deletion order is preserved.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` (`FF_BULK_OPERATIONS`, already registered).
- `src/models/task.ts` (`archiveTask`, `archiveTaskHard`; new
  `archiveTaskBulk`).
- `src/commands/tasks.ts` (`archiveTaskCommand` command wiring).
- `specs/feature-flags.md` (already documents `ff_bulk_operations`).
