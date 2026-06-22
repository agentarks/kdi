# BRD-KDI-049: Non-Following `tail` Mode

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators a way to print a task's recent events and exit, without being
forced into the live-following loop. This makes `kdi tail` usable in scripts,
CI steps, and post-mortem workflows where a one-shot snapshot of the last N
events is enough.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can print the last N events for a task with
   `kdi tail <task_id> --lines N` and have the command exit.
2. As an operator, I can print all events for a task without following with
   `kdi tail <task_id> --no-follow`.
3. As a script author, I can rely on `kdi tail` returning exit code 0 after
   printing, instead of blocking forever.
4. As an operator, the default `kdi tail <task_id>` behavior remains
   unchanged: it still prints existing events and then follows new ones.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi tail <task_id>` without the new options behaves exactly as today:
  prints existing events in chronological order, then polls every second for
  new events and prints them until the process is interrupted.
- `kdi tail <task_id> --lines N` prints the N most recent events for the task
  in chronological order and exits with code 0.
- `kdi tail <task_id> --no-follow` prints all events for the task in
  chronological order and exits with code 0.
- `--lines N` and `--no-follow` may be used together; the result is the same
  as `--lines N` alone.
- Output format is unchanged:
  ```
  [2026-06-22T12:34:56.789Z] kind {"payload":"value"}
  ```
  The ISO 8601 timestamp is derived from `task_events.created_at`.
- `--lines` accepts only positive integers. Non-numeric, zero, and negative
  values are rejected with a clear error.
- When a task has no events, the command prints nothing and exits 0 in
  non-following mode.
- When a task has fewer than N events, `--lines N` prints all of them.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for `--lines` queries on tasks with up
  to 100,000 events.
- No breaking change to the default following behavior of `kdi tail`.
- New options are rejected when the feature flag is disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_tail_no_follow` registered in `src/flags.ts`:
  ```ts
  export const FF_TAIL_NO_FOLLOW = "FF_TAIL_NO_FOLLOW";
  registerFlag(FF_TAIL_NO_FOLLOW, false);
  ```
- Env var form: `FF_TAIL_NO_FOLLOW=false`.
- Defaults to `false` in every environment.
- `--lines` and `--no-follow` are rejected when the flag is disabled.
- Add the flag to the registry in `specs/feature-flags.md` with status
  `InDev`, scope `CLI / task observability`, and BRD link.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing
`task_events` table and uses the existing `idx_events_task` index.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi tail <task_id>` — existing behavior: print events and follow live.
- `kdi tail <task_id> --lines N` — print the last N events and exit.
- `kdi tail <task_id> --no-follow` — print all events and exit.
- `kdi tail <task_id> --lines N --no-follow` — equivalent to `--lines N`.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. Extend `getEvents(taskId: number)` in `src/models/taskEvent.ts` to accept
   an optional limit, or add a new helper `getRecentTaskEvents(taskId, limit)`.
   The query must use `ORDER BY created_at DESC LIMIT ?` so SQLite can satisfy
   it from the existing `idx_events_task(task_id, created_at)` index:
   ```sql
   SELECT id, task_id, run_id, kind, payload, created_at
   FROM task_events
   WHERE task_id = ?
   ORDER BY created_at DESC
   LIMIT ?
   ```
2. The command handler reverses the DESC result so events are printed in
   chronological order, matching the existing tail output order.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
1. Parse options with Commander:
   - `--lines <n>`: parse as a positive integer.
   - `--no-follow`: boolean flag.
2. If either option is supplied and `FF_TAIL_NO_FOLLOW` is disabled, exit
   with `"Tail no-follow feature is not enabled."`
3. Resolve and validate the task exactly as today via `parseTaskId` and
   `showTask`; exit 1 with a clear error if the task is missing.
4. Determine the event source:
   - `--lines N`: query the N most recent events for the task.
   - `--no-follow` without `--lines`: query all events for the task.
   - Neither option: use the existing following loop.
5. In non-following mode, reverse the query result and print each event in
   the existing `[timestamp] kind payload` format, then exit 0.
6. In following mode, preserve the existing logic: print existing events,
   then poll `tailEvents(id, maxId)` every second forever.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| `kdi tail 1 --lines 10` with 3 events | Prints all 3 events and exits. |
| `kdi tail 1 --lines 0` | Rejected: "--lines must be a positive integer." |
| `kdi tail 1 --lines -5` | Rejected: "--lines must be a positive integer." |
| `kdi tail 1 --lines abc` | Rejected: "--lines must be a positive integer." |
| `kdi tail 1 --no-follow` on a task with no events | Prints nothing, exits 0. |
| `kdi tail 1` (no options) | Existing follow behavior is unchanged. |
| `FF_TAIL_NO_FOLLOW=false kdi tail 1 --lines 5` | Exits with "Tail no-follow feature is not enabled." |
| Missing task | Exits with "Task <id> not found." and code 1. |

-------------------------------------------------------------------------------
Test Plan
-------------------------------------------------------------------------------
### Unit tests (`tests/taskEvent.test.ts`)
- `getEvents(taskId, limit)` returns the most recent N events ordered by
  `created_at DESC`.
- `getEvents(taskId)` without limit continues to return all events.

### CLI / integration tests (`tests/commands/tasks.test.ts`)
- `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --lines N` prints the last N
  events in chronological order and exits 0.
- `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --no-follow` prints all events
  and exits 0.
- `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --lines N --no-follow` behaves
  the same as `--lines N`.
- `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --lines 5` on a task with fewer
  than 5 events prints all events.
- `FF_TAIL_NO_FOLLOW=true kdi tail <missing_id> --lines 5` exits 1 with
  "Task <id> not found."
- `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --lines 0` exits with a clear
  validation error.
- `FF_TAIL_NO_FOLLOW=false kdi tail <task_id> --lines 5` exits with
  "Tail no-follow feature is not enabled."
- Default `kdi tail <task_id>` (with flag enabled or disabled) still enters
  the follow loop and must be terminated externally.

### Regression tests
- Existing `tailEvents` and `getEvents` behavior is preserved.
- Existing `kdi tail` following output format is unchanged.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --lines 10` prints the last
      10 events and exits 0.
- [ ] `FF_TAIL_NO_FOLLOW=true kdi tail <task_id> --no-follow` prints all
      events and exits 0.
- [ ] `--lines` and `--no-follow` may be combined without changing the result.
- [ ] `kdi tail <task_id>` without the new options continues to follow live
      events.
- [ ] `--lines` rejects non-numeric, zero, and negative values.
- [ ] `FF_TAIL_NO_FOLLOW=false kdi tail <task_id> --lines 5` exits with
      "Tail no-follow feature is not enabled."
- [ ] Missing task handling is unchanged.
- [ ] Unit and CLI tests cover the new options, validation, flag gating, and
      default behavior preservation.
- [ ] `bun run lint`, `bun run test`, and `bun run build` pass.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Scripts may parse the human-readable tail output, which is not a
  stable API.
  **Mitigation:** keep output format identical to today; a future BRD can add
  `--json` if a machine-readable interface is needed.
- **Risk:** Very large `--lines` values could dump excessive output.
  **Mitigation:** document reasonable values; no hard cap is required for
  KDI-049.
- **Open question:** Should `kdi tail` support a `--follow`/`--no-follow`
  long-form pair explicitly? This BRD uses `--no-follow` only; the default
  remains follow mode for backward compatibility.
- **Open question:** Should `--lines` be available in following mode to seed
  the live stream with the last N events? Out of scope for KDI-049;
  `--lines` implies exit.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/commands/tasks.ts` (`tailTaskCommand`).
- `src/models/taskEvent.ts` (`getEvents`, `tailEvents`).
- `src/flags.ts` (`FF_TAIL_NO_FOLLOW`).

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-049-tail-no-follow`

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a new section under the feature list:

```markdown
## Non-Following `tail` Mode (KDI-049) — In Progress
- [ ] BRD drafted at `specs/brd-kdi-049-tail-no-follow.md`
- [ ] Feature flag `ff_tail_no_follow` / `FF_TAIL_NO_FOLLOW` registered in
      `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [ ] `kdi tail <task_id> --lines N` prints the last N events and exits
- [ ] `kdi tail <task_id> --no-follow` prints all events and exits
- [ ] Default `kdi tail <task_id>` follow behavior preserved
- [ ] Unit/CLI tests cover `--lines`, `--no-follow`, validation, flag gating,
      and default behavior preservation
- [ ] `bun run lint`, `bun run test`, `bun run build` pass
```

Also update the Task Events line in the Task Lifecycle section to mention the
new options:
```markdown
- [x] `kdi tail <task_id>` — follow task events live, with optional
      `--lines N` / `--no-follow` non-following mode (KDI-049)
```
