# BRD-KDI-038: Goal Mode

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow a task to run as a goal-directed, multi-turn agent loop instead of a
single harness invocation. A goal task declares a target outcome, a maximum
number of autonomous turns, and a required judge profile. After each turn the
judge profile evaluates the harness output and decides whether the goal is
satisfied. If the goal is not yet satisfied, the dispatcher records the turn,
decrements the remaining budget, and requeues the task with accumulated context.
This maps the Hermes Kanban `goal_mode` / `goal_max_turns` pattern (the
"Ralph-style" goal loop) onto kdi's existing claim-run-event model without
changing normal task behavior when the feature is disabled.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can create a goal-mode task with
   `kdi create "Refactor auth" --board myproj --goal --goal-max-turns 20 --goal-judge ralph`.
2. As a harness author, I receive `KDI_GOAL_*` environment variables and a
   verdict file path so my agent knows which turn it is, how many turns remain,
   and where to write intermediate results for the judge to inspect.
3. As a judge profile author, I can emit a structured verdict (`done` or
   `continue`) so the dispatcher decides whether to finish the task or run
   another turn.
4. As an operator, I can configure the default judge profile via
   `KDI_GOAL_JUDGE_PROFILE`; the `--goal-judge` CLI option overrides it.
5. As an operator, I want a goal task that exhausts its turn budget without
   reaching `done` to be automatically blocked with reason
   "Goal max turns exhausted".
6. As an operator, I can inspect goal-mode state via `kdi show <id>` when the
   flag is enabled.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Human-in-the-loop pause between turns.
- Human-in-the-loop pause between turns.
- Cross-turn workspace persistence; each turn still runs in a fresh worktree.
- Changing the dispatcher poll interval or claim TTL specifically for goal
  tasks.
- Goal-mode support for tasks that are not dispatched through the normal
  `ready` → `running` claim flow.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi create <title> --goal --goal-max-turns <n> --goal-judge <profile>`
  stores a task with `goal_mode = 1`, `goal_max_turns = n`,
  `goal_remaining_turns = n`, and `goal_judge_profile = <profile>`.
- `--goal` requires `--goal-max-turns` and a judge profile (`--goal-judge` or
  `KDI_GOAL_JUDGE_PROFILE`); passing `--goal` without both is rejected with a
  clear error.
- `--goal-max-turns` must be a positive integer.
- `--goal-judge` must name a known profile; unknown profiles are rejected at
  creation time.
- Goal-mode options are rejected with "Goal mode feature is not enabled." when
  `FF_GOAL_MODE` is `false`.
- `kdi show <id>` displays the following lines when the flag is enabled and the
  task is goal-mode:
  - `Goal mode: yes`
  - `Goal max turns: <n>`
  - `Goal remaining turns: <r>`
  - `Goal judge profile: <profile>`
- `kdi show` hides all goal-mode lines when the flag is disabled, even if the
  columns are populated.
- The dispatcher treats goal-mode tasks like any other ready task for claiming,
  worktree creation, and profile resolution.
- When a goal-mode task is claimed, the dispatcher passes these extra env vars
  to the harness process:
  - `KDI_GOAL_MODE=true`
  - `KDI_GOAL_MAX_TURNS=<n>`
  - `KDI_GOAL_REMAINING_TURNS=<r>` (before the current turn)
  - `KDI_GOAL_TURN=<t>` (1-indexed)
  - `KDI_GOAL_CONTEXT=<current task result>` (empty string if null)
  - `KDI_GOAL_VERDICT_FILE=<absolute path>` (dispatcher-created temp file)
- The harness may write intermediate results to `KDI_GOAL_VERDICT_FILE` for the
  judge to inspect, but the judge profile is the sole decision-maker for the
  Ralph-style goal loop.
- After the harness exits, the dispatcher spawns the task's judge profile
  (`task.goal_judge_profile`, falling back to `KDI_GOAL_JUDGE_PROFILE` env var),
  passing the same `KDI_GOAL_*` env vars and `KDI_GOAL_VERDICT_FILE`. The judge
  process writes (or prints) a decision using this schema:
  ```json
  {
    "verdict": "done" | "continue",
    "result": "optional result text",
    "summary": "optional summary",
    "note": "optional note for the next turn"
  }
  ```
  The `verdict` field is required; all other fields are optional.
- The judge verdict is authoritative. If the judge produces an invalid verdict
  or exits non-zero, the dispatcher treats the turn as a normal harness failure
  via the existing failure path.
- When the effective verdict is `done`:
  - The task transitions to `done`.
  - `task.result` is set to `verdict.result` if provided, otherwise the harness
    stdout is used (matching the existing `finishTask` behavior).
  - `task.summary` is set to `verdict.summary` if provided.
  - A `goal_turn` event is recorded with `{ turn, max_turns,
    remaining_after, verdict: "done", note? }`.
  - `consecutive_failures` is reset to `0`.
- When the effective verdict is `continue`:
  - `goal_remaining_turns` is decremented by 1.
  - If remaining turns are still greater than `0`:
    - The active `task_runs` row is finalized with `outcome = 'goal_continue'`
      and `status = 'released'`.
    - The task is returned to `ready` with claim cleared, preserving context:
      `task.result` is set to `verdict.result` if provided, otherwise the
      existing result is concatenated with `verdict.note` (capped at 64 KiB).
    - A `goal_turn` event is recorded with `{ turn, max_turns,
      remaining_after, verdict: "continue", note? }`.
    - `consecutive_failures` is reset to `0`.
  - If remaining turns reach `0` after decrementing:
    - The task is blocked with `block_reason = "Goal max turns exhausted"`.
    - The active run is finalized with `outcome = 'blocked'`.
    - A `goal_turn` event is recorded with `{ turn, max_turns,
      remaining_after: 0, verdict: "exhausted" }`.
- Unblocking a task whose `block_reason` is "Goal max turns exhausted" resets
  `goal_remaining_turns` to `goal_max_turns`, allowing the goal loop to run
  again.
- When `FF_GOAL_MODE` is `false`, the dispatcher ignores `goal_mode` columns and
  goal-mode tasks behave exactly like normal tasks.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No breaking change to `kdi create`, `kdi show`, or dispatcher behavior when
  the feature flag is disabled.
- Goal-mode context accumulation is capped at 64 KiB on `tasks.result` to avoid
  unbounded row growth.
- Each turn runs in a fresh worktree and claim, keeping the existing isolation
  model intact.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_goal_mode` registered in `src/flags.ts`:
  ```ts
  export const FF_GOAL_MODE = "FF_GOAL_MODE";
  registerFlag(FF_GOAL_MODE, false);
  ```
- Env var form: `FF_GOAL_MODE=false`.
- Defaults to `false` in every environment.
- `kdi create --goal`, `--goal-max-turns`, and `--goal-judge` are rejected
  when the flag is disabled.
- `kdi show` hides goal-mode fields when the flag is disabled.
- Dispatcher goal-loop behavior is skipped when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
- Add to `tasks` table:
  - `goal_mode INTEGER NOT NULL DEFAULT 0`
  - `goal_max_turns INTEGER`
  - `goal_remaining_turns INTEGER`
  - `goal_judge_profile TEXT`
- Migrations in `src/db.ts` guard each new column with `PRAGMA table_info(tasks)`.
- Add index:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_tasks_goal_mode ON tasks(status, goal_mode);
  ```
- Extend `task_runs.outcome` CHECK to include `goal_continue`:
  ```sql
  outcome TEXT CHECK (outcome IN ('completed', 'blocked', 'crashed', 'timed_out',
  'spawn_failed', 'gave_up', 'reclaimed', 'goal_continue'))
  ```
  The migration must recreate `task_runs` if the existing CHECK does not
  contain `'goal_continue'` (mirroring the existing `tasks_new` migration
  pattern).

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi create <title> --board <slug> --goal --goal-max-turns <n> --goal-judge <profile>` — create a
  goal-mode task with a required judge profile.
- `kdi show <task_id>` — displays goal-mode fields when the flag is enabled and
  the task is goal-mode.

-------------------------------------------------------------------------------
Model / API Changes
-------------------------------------------------------------------------------
1. `Task` interface in `src/models/task.ts` gains:
   - `goal_mode: boolean`
   - `goal_max_turns: number | null`
   - `goal_remaining_turns: number | null`
   - `goal_judge_profile: string | null`
2. `TASK_COLUMNS` is updated to include the four new columns.
3. `CreateTaskInput` gains:
   - `goal_mode?: boolean`
   - `goal_max_turns?: number`
   - `goal_judge_profile?: string`
4. `createTask()` initializes `goal_remaining_turns = goal_max_turns` when
   `goal_mode` is true, otherwise `null`.
5. `hydrateTask()` converts `goal_mode` from integer `0/1` to boolean.
6. `TaskRun["outcome"]` gains `'goal_continue'`.
7. Add helper in `src/models/task.ts`:
   - `decrementGoalTurns(id): Task` — decrements `goal_remaining_turns` and
     returns the updated task.
   - `resetGoalTurns(id): Task` — resets `goal_remaining_turns` to
     `goal_max_turns` (used on unblock after exhaustion).
8. `src/models/taskEvent.ts` `addEvent()` is used directly with kind
   `"goal_turn"` and the payload described above.

-------------------------------------------------------------------------------
Dispatcher Behavior
-------------------------------------------------------------------------------
1. In `tick()`, after a successful `atomicClaim`, if `FF_GOAL_MODE` is enabled
   and `task.goal_mode` is true, compute `currentTurn =
   goal_max_turns - goal_remaining_turns + 1` and build the extra env vars.
2. Spawn the harness as usual, passing the goal env vars.
3. After the harness exits, spawn the task's judge profile with the same
   `KDI_GOAL_*` env vars and `KDI_GOAL_VERDICT_FILE`.
4. Parse the judge verdict. If the judge profile is missing or produces invalid
   output, treat the turn as a normal harness failure via the existing
   `handleFailure` path.
5. Apply the judge verdict:
   - `done` → call `finishTask`-equivalent logic with the optional verdict
     result/summary.
   - `continue` → call a new `handleGoalContinue(task, runId, verdict)` helper
     that decrements remaining turns and either requeues the task or blocks it
     when exhausted.
6. Worktree cleanup runs in `finally`, preserving existing behavior.
7. Non-goal tasks continue to use the existing single-turn path unchanged.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- Existing `task_events` table is reused.
- New event kind: `goal_turn`.
- Payload shape for a `continue` verdict:
  ```json
  { "turn": 1, "max_turns": 20, "remaining_after": 19,
    "verdict": "continue", "note": "..." }
  ```
- Payload shape for a `done` verdict:
  ```json
  { "turn": 3, "max_turns": 20, "remaining_after": 17,
    "verdict": "done", "summary": "..." }
  ```
- Payload shape when turns are exhausted:
  ```json
  { "turn": 20, "max_turns": 20, "remaining_after": 0,
    "verdict": "exhausted" }
  ```
- Existing `blocked` event is emitted when max turns are exhausted, with
  `{ reason: "Goal max turns exhausted" }`.

-------------------------------------------------------------------------------
Error Handling
-------------------------------------------------------------------------------
- `kdi create --goal` without `--goal-max-turns` exits with
  "--goal requires --goal-max-turns <n>.".
- `kdi create --goal-max-turns 20` without `--goal` exits with
  "--goal-max-turns requires --goal.".
- `kdi create --goal --goal-max-turns 20` without `--goal-judge` and without
  `KDI_GOAL_JUDGE_PROFILE` exits with a clear error that a judge profile is
  required.
- `kdi create --goal --goal-max-turns 20 --goal-judge unknown` exits with
  "Unknown judge profile \"unknown\".".
- Non-positive or non-integer `--goal-max-turns` exits with a clear error.
- Goal-mode options when `FF_GOAL_MODE=false` exit with
  "Goal mode feature is not enabled.".
- Invalid judge verdict or judge profile failure causes the dispatcher to treat
  the turn as a normal harness failure via the existing failure path.

-------------------------------------------------------------------------------
Testing Requirements
-------------------------------------------------------------------------------
- Unit tests for `createTask` with `--goal` / `--goal-max-turns` /
  `--goal-judge`.
- Unit tests for `showTask` / `kdi show` goal-mode display and flag-disabled
  hiding.
- Unit tests for `decrementGoalTurns` and `resetGoalTurns`.
- Dispatcher integration tests (with injected `spawnHarness`):
  - judge emits `done` verdict → task becomes `done`.
  - judge emits `continue` verdict → task returns to `ready` with decremented
    remaining turns and a `goal_turn` event.
  - judge exhausts budget → task becomes `blocked` with the expected reason.
  - missing or invalid judge profile / verdict → turn treated as harness
    failure.
  - non-goal tasks are unaffected when the flag is enabled.
  - goal-mode tasks behave as normal tasks when the flag is disabled.
- E2E CLI tests for the `create` and `show` acceptance criteria.
- All existing tests continue to pass with `FF_GOAL_MODE=false`.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] AC-01: `FF_GOAL_MODE=true kdi create "Refactor auth" --board myproj
      --goal --goal-max-turns 20 --goal-judge ralph` creates a task with
      `goal_mode = true`, `goal_max_turns = 20`, `goal_remaining_turns = 20`,
      `goal_judge_profile = "ralph"`, and prints the task ID.
- [ ] AC-02: `FF_GOAL_MODE=true kdi create "Refactor auth" --goal` exits with
      "--goal requires --goal-max-turns <n>.".
- [ ] AC-03: `FF_GOAL_MODE=true kdi create "Refactor auth" --goal-max-turns 20`
      exits with "--goal-max-turns requires --goal.".
- [ ] AC-04: `FF_GOAL_MODE=true kdi create "Refactor auth" --goal
      --goal-max-turns 0` exits with a clear error that max turns must be a
      positive integer.
- [ ] AC-05: `FF_GOAL_MODE=false kdi create "Refactor auth" --goal
      --goal-max-turns 20 --goal-judge ralph` exits with
      "Goal mode feature is not enabled.".
- [ ] AC-06: `FF_GOAL_MODE=true kdi show <id>` on a goal-mode task prints
      `Goal mode: yes`, `Goal max turns: 20`, `Goal remaining turns: 20`, and
      `Goal judge profile: ralph`.
- [ ] AC-07: `FF_GOAL_MODE=false kdi show <id>` on a goal-mode task does not
      print any goal-mode lines.
- [ ] AC-08: With `FF_GOAL_MODE=true`, a goal-mode task whose judge emits
      `verdict: "done"` transitions to `done`, records a `goal_turn` event with
      `verdict: "done"`, and resets `consecutive_failures` to `0`.
- [ ] AC-09: With `FF_GOAL_MODE=true`, a goal-mode task whose judge emits
      `verdict: "continue"` on turn 1 returns to `ready` with
      `goal_remaining_turns = 19`, records a `goal_turn` event with
      `verdict: "continue"`, and finalizes the run with
      `outcome = 'goal_continue'`.
- [ ] AC-10: With `FF_GOAL_MODE=true`, a goal-mode task whose judge emits
      `verdict: "continue"` when `goal_remaining_turns = 1` becomes `blocked`
      with reason "Goal max turns exhausted", records a `goal_turn` event with
      `verdict: "exhausted"`, and finalizes the run with
      `outcome = 'blocked'`.
- [ ] AC-11: With `FF_GOAL_MODE=true`, non-goal tasks continue to use the
      existing single-turn path and are unaffected by the goal loop.
- [ ] AC-12: With `FF_GOAL_MODE=false`, a task created with `goal_mode = true`
      in the database is dispatched as a normal single-turn task.
- [ ] AC-13: With `FF_GOAL_MODE=true`, a goal-mode task without a judge profile
      (no `--goal-judge` and no `KDI_GOAL_JUDGE_PROFILE`) is blocked by the
      dispatcher with reason "Goal-mode task missing required judge profile".
- [ ] AC-14: With `FF_GOAL_MODE=true`, an invalid judge verdict or judge
      profile failure is treated as a normal harness failure.
- [ ] AC-15: `bun run lint`, `bun run test`, and `bun run build` pass with the
      new tests added.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Extending the `task_runs.outcome` CHECK constraint to include
  `goal_continue` requires recreating `task_runs` on existing databases.
  **Mitigation:** follow the existing `tasks_new` migration pattern: inspect
  `sqlite_master.sql`, and only recreate when the CHECK does not already
  contain the new value.
- **Risk:** Each turn creates and tears down a worktree, so file-system churn
  is proportional to the number of turns.
  **Mitigation:** keep each turn short and context-driven; future work may
  persist workspace state across turns if needed.
- **Risk:** A chatty harness could write a very large verdict `result` or
  `note`, causing `tasks.result` to grow without bound.
  **Mitigation:** cap concatenated context at 64 KiB; consider future
  attachment-based context for long histories.
- **Risk:** A misconfigured judge profile can block the dispatcher loop.
  **Mitigation:** judge failures are non-fatal; the dispatcher treats the turn
  as a normal harness failure so `max_retries` applies.
- **Risk:** Requiring a judge profile makes goal-mode tasks unusable in
  environments without one. **Mitigation:** the default judge can be supplied
  via `KDI_GOAL_JUDGE_PROFILE`, and the CLI accepts `--goal-judge` to override
  it per task.
- **Open question:** Should `--max-runtime` apply per-turn or across the entire
  goal loop? Out of scope; KDI-008's per-task cap continues to apply to each
  individual harness invocation.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` — register `FF_GOAL_MODE`.
- `src/db.ts` — schema and migrations for new `tasks` columns, index, and
  `task_runs` outcome enum update.
- `src/models/task.ts` — `Task`, `TASK_COLUMNS`, `CreateTaskInput`,
  `createTask`, `hydrateTask`, and turn helpers.
- `src/models/taskRun.ts` — `TaskRun["outcome"]` and `finishRun` mapping.
- `src/models/taskEvent.ts` — `addEvent("goal_turn", ...)`.
- `src/profiles.ts` — judge profile lookup and command substitution.
- `src/dispatcher.ts` — goal-loop orchestration in `tick()`.
- `src/commands/tasks.ts` — `createTaskCommand` and `showTaskCommand` option
  wiring.
