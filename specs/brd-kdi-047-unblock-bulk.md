# BRD-KDI-047: Support Multiple Task IDs in `kdi unblock`

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Bring `kdi unblock` into parity with Hermes Kanban and the rest of KDI's bulk
lifecycle commands (`block`, `schedule`, `promote`). Operators often need to
unblock several tasks at once after an incident is resolved or a dependency
lands; requiring a separate command per task creates toil and slows triage.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can unblock several blocked tasks with one command:
   `kdi unblock 1 2 3 --reason "api recovered"`.
2. As an operator, I can ready several scheduled tasks at once:
   `kdi unblock 4 5 --reason "starting now"`.
3. As a script author, I can rely on per-task success/skip reporting and a
   non-zero exit code when any task could not be unblocked.
4. As an existing user, `kdi unblock <task_id>` continues to work exactly as
   it does today.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
Current KDI:

```
kdi unblock [options] <task_id>
```

- Accepts exactly one positional argument.
- Passing multiple IDs silently ignores all but the first.

Desired KDI:

```
kdi unblock [options] <task_ids...>
```

- Accepts one or more task IDs.
- Processes each task independently.
- Prints per-task success or skip reason.
- Prints a summary line when more than one ID is supplied.
- Exits `1` if any task is skipped.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi unblock <task_id>` (single ID) behaves exactly as today.
- `kdi unblock <id1> <id2>... [--reason <text>]` unblocks every listed
  non-archived task that is in `blocked` or `scheduled` status.
- Each successful unblock emits the existing `unblocked` or `ready` event
  (the latter for scheduled tasks).
- Tasks are skipped with a clear reason when they:
  - do not exist,
  - are archived,
  - are not in `blocked` or `scheduled` status.
- Processing is sequential and each task is committed independently; one
  failure does not roll back earlier successes.
- Output:
  - Single success: same messages as today (`Task N is now ready.` or
    `Unblocked task N.`).
  - Multiple successes: same per-task messages plus a summary line
    `Unblocked M/N tasks.`
  - Skipped tasks: `Skipped task N: <reason>` on stderr.
- Passing zero task IDs is an error: "At least one task ID is required."
- Board resolution follows the standard chain for all commands.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms per task in the bulk set.
- No breaking change to single-task `kdi unblock` behavior.
- Exit codes and output format match the existing bulk operations pattern
  established by `kdi block` and `kdi schedule`.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
No new feature flag is required. KDI-047 extends the existing `unblock`
command; the underlying scheduled-status behavior is already gated by
`FF_SCHEDULED_STATUS` where applicable. The bulk behavior itself is not
feature-flagged because it is a straightforward parity extension of an
existing command and matches the `kdi block` / `kdi schedule` / `kdi promote`
variadic-ID convention.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature uses the existing `tasks`,
`task_events`, and `comments` tables.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi unblock <task_id> [--reason <text>]` — single-task unblock (unchanged).
- `kdi unblock <id1> <id2>... [--reason <text>]` — bulk unblock / ready.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. The existing `unblockTask(id, reason?)` model helper in
   `src/models/task.ts` already handles single-task unblock, scheduled→ready
   transition, optional reason-as-comment, and goal-turn reset. It is reused
   without change.
2. The command layer iterates over the supplied IDs, calls `unblockTask` for
   each, and collects success/skip results.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
1. Change the argument registration from `.argument("<task_id>", ...)` to
   `.argument("<task_ids...>", "One or more task IDs")`.
2. Parse and validate all IDs with `parseTaskId`.
3. If zero IDs are supplied, exit with "At least one task ID is required."
4. For each ID:
   - Reject with a skip message if `FF_SCHEDULED_STATUS` is disabled and the
     task is in `scheduled` status (existing behavior, thrown by the model).
   - Call `unblockTask(id, options.reason)`.
   - Print the existing per-task success message.
5. Track skipped count. Print summary line when more than one ID is supplied.
6. Exit `1` if any task was skipped.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| `kdi unblock 1 2 3` on blocked tasks | All become `todo`; per-task messages; summary line. |
| `kdi unblock 4 5` on scheduled tasks | Both become `ready`; per-task "now ready" messages. |
| Mixed blocked and scheduled IDs | Each transitions to its appropriate target status. |
| One ID does not exist | Skipped with reason; other IDs succeed; exit 1. |
| One ID is already `todo` | Skipped with "not in 'blocked' or 'scheduled' status"; exit 1. |
| One ID is archived | Skipped with "not found or already archived"; exit 1. |
| `kdi unblock` with no IDs | Error: "At least one task ID is required." |
| `--reason "landed"` | Reason recorded as a comment before each unblock, as today. |

-------------------------------------------------------------------------------
Test Plan
-------------------------------------------------------------------------------
### Unit tests (`tests/task.test.ts`)
- Existing `unblockTask` tests remain unchanged and pass.

### CLI / integration tests (`tests/commands/tasks.test.ts`)
- `kdi unblock <id>` single blocked task → `todo`; message unchanged.
- `kdi unblock <id>` single scheduled task → `ready`; message unchanged.
- `kdi unblock <id1> <id2>` on two blocked tasks → both `todo`; summary line.
- `kdi unblock <id1> <id2>` on two scheduled tasks → both `ready`; summary line.
- `kdi unblock <id1> <id2>` where one is not blocked/scheduled → one
  succeeds, one skipped; exit 1.
- `kdi unblock <id1> <id2>` where one does not exist → one succeeds, one
  skipped; exit 1.
- `kdi unblock <id1> <id2>` where one is archived → one succeeds, one
  skipped; exit 1.
- `kdi unblock` with no IDs → error and exit 1.
- `--reason` is recorded as a comment for each successful unblock.

### Regression tests
- Single-task `kdi unblock` output and exit code are unchanged.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `kdi unblock 1` on a blocked task moves it to `todo` and prints
      `Unblocked task 1.`
- [ ] `kdi unblock 1` on a scheduled task moves it to `ready` and prints
      `Task 1 is now ready.`
- [ ] `kdi unblock 1 2 3` on blocked tasks unblocks all three and prints a
      summary line.
- [ ] `kdi unblock 1 2 3` where one task is not blocked/scheduled skips that
      task, processes the others, and exits 1.
- [ ] `kdi unblock 1 2 3 --reason "fixed"` records the reason as a comment
      on each successfully unblocked task.
- [ ] `kdi unblock` with no IDs exits with "At least one task ID is required."
- [ ] Single-task `kdi unblock` behavior is unchanged when only one ID is
      supplied.
- [ ] `bun run lint`, `bun run test`, and `bun run build` pass.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Scripts that previously passed extra positional arguments after
  the task ID (e.g. `kdi unblock 1 extra`) now receive those as additional
  task IDs instead of being ignored by the shell. **Mitigation:** This is
  the intended variadic behavior; it matches `kdi block`, `kdi schedule`,
  and `kdi promote`.
- **Open question:** Should bulk `unblock` be gated by `FF_BULK_OPERATIONS`?
  This BRD intentionally does not gate it, because bulk unblock is Hermes
  parity for a base command and the implementation is a minimal command-layer
  loop. If reviewers prefer gating, add `FF_BULK_OPERATIONS` rejection when
  more than one ID is supplied.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`unblockTask`, `parseTaskId` already exists in the
  command file).
- `src/commands/tasks.ts` (`unblockTaskCommand`).
- `src/flags.ts` (`FF_SCHEDULED_STATUS` for scheduled-task behavior).

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-047-unblock-bulk`

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a new section under the feature list:

```markdown
## Bulk `kdi unblock` (KDI-047) — In Progress
- [ ] `kdi unblock <id1> <id2>...` unblocks or readies multiple tasks at once
- [ ] Per-task success/skip reporting with summary line
- [ ] Exit 1 when any task is skipped
- [ ] Unit/CLI tests cover single-task, bulk, mixed-status, missing, and
      archived cases
- [ ] `bun run lint`, `bun run test`, `bun run build` pass
```

Update the `kdi unblock` line in the Task Lifecycle section to mention bulk:
```markdown
- [x] `kdi unblock <task_id>` — unblock a task (or immediately ready a
      scheduled task); supports multiple IDs (KDI-047)
```
