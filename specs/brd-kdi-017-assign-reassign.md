# BRD-KDI-017: Assign / Reassign

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow operators to change which harness profile is responsible for a task at
any point in its lifecycle. This supports load balancing, re-routing work when
an agent is misconfigured, and clearing assignments when a task should return
to the unassigned pool.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can assign a task to a profile with
   `kdi assign <task_id> <profile>`.
2. As an operator, I can unassign a task with `kdi assign <task_id> none`.
3. As an operator, I can reassign a running task to another profile and have
   its active claim released atomically with `kdi reassign ... --reclaim`.
4. As an operator, I can record a reason when reclaiming during reassignment or
   via `kdi reclaim`.
5. As a reviewer, I can see the current assignee on `kdi show <id>`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi assign <task_id> <profile>` sets `tasks.assignee` to `<profile>`.
  - Valid for any non-archived task regardless of status.
  - Empty `<profile>` values are rejected.
  - Profile existence is **not** validated at assignment time (profiles may be
    added later or may be optional for manually managed tasks).
- `kdi assign <task_id> none` sets `tasks.assignee` to `NULL` (unassign).
- `kdi reassign <task_id> <profile>` is a convenience alias that behaves like
  `kdi assign` when the task is not `running`.
- `kdi reassign <task_id> <profile> --reclaim` first releases the active claim
  on a `running` task (recording a `reclaimed` event), then updates the
  assignee and returns the task to `ready`.
- `kdi reassign <task_id> none` unassigns the task. With `--reclaim`, it
  releases an active claim first and then clears the assignee, leaving the task
  `ready` and unassigned.
- `kdi reassign --reason "..."` records the reason on the `reclaimed` event
  when `--reclaim` is used.
- `kdi reclaim <task_id> --reason "..."` records the reason on the `reclaimed`
  event (overriding any default reason).
- All reassign/reclaim operations update `tasks.updated_at`.
- `kdi show <id>` always displays `Assignee:` when an assignee is set,
  regardless of feature flag state.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- Reassignment of a running task with `--reclaim` is atomic within a database
  transaction.
- No breaking change to `kdi show` output.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_assign_reassign` registered in `src/flags.ts`:
  ```ts
  export const FF_ASSIGN_REASSIGN = "FF_ASSIGN_REASSIGN";
  registerFlag(FF_ASSIGN_REASSIGN, false);
  ```
- Env var form: `FF_ASSIGN_REASSIGN=false`.
- Defaults to `false` in every environment.
- `kdi assign`, `kdi reassign`, and the `--reason` option on `kdi reclaim` are
  rejected when the flag is disabled.
- The base `kdi reclaim <task_id>` command (without `--reason`) remains
  available because it is part of the foundational CAS claim system.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The existing `tasks.assignee TEXT` column is
used.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi assign <task_id> <profile>` — set or change assignee.
- `kdi assign <task_id> none` — remove assignee.
- `kdi reassign <task_id> <profile> [--reclaim] [--reason <text>]` — assign,
  optionally reclaiming a running task.
- `kdi reassign <task_id> none [--reclaim] [--reason <text>]` — unassign,
  optionally reclaiming first.
- `kdi reclaim <task_id> [--reason <text>]` — release active claim, with
  optional reason (reason gated by `ff_assign_reassign`).

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `assignTask(taskId, profile)`:
   - Verify the task exists and is not archived.
   - Update `assignee = profile`, `updated_at = unixepoch()`.
   - Emit an `assigned` event with payload `{ assignee: profile }`.
2. `unassignTask(taskId)`:
   - Verify the task exists and is not archived.
   - Update `assignee = NULL`, `updated_at = unixepoch()`.
   - Emit an `unassigned` event.
3. `reassignTask(taskId, profile, options)`:
   - If the task is `running` and `options.reclaim` is true, call
     `reclaimTask(taskId, options.reason)` inside the same transaction.
   - Then call `assignTask(taskId, profile)` or `unassignTask(taskId)`.
   - If `options.reclaim` is omitted and the task is `running`, the assignee is
     updated but the active claim remains (the running worker keeps working).

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- New event kind: `assigned`.
- Payload shape:
  ```json
  { "assignee": "opencode" }
  ```
- New event kind: `unassigned`.
- Payload shape:
  ```json
  {}
  ```
- Existing event kind: `reclaimed`.
- Payload shape when reason is provided:
  ```json
  { "reason": "rerouting to codex profile" }
  ```

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_ASSIGN_REASSIGN=true kdi assign 42 opencode` sets `assignee` to
      `opencode` and emits an `assigned` event.
- [ ] `FF_ASSIGN_REASSIGN=true kdi assign 42 none` sets `assignee` to `NULL`
      and emits an `unassigned` event.
- [ ] `FF_ASSIGN_REASSIGN=true kdi reassign 42 codex --reclaim` releases the
      active claim on a running task, records the `reclaimed` event, sets
      `assignee = codex`, and returns the task to `ready`.
- [ ] `FF_ASSIGN_REASSIGN=true kdi reassign 42 codex --reclaim --reason "slow"`
      records the `reclaimed` event with reason `"slow"`.
- [ ] `FF_ASSIGN_REASSIGN=true kdi reassign 42 none --reclaim --reason "abort"`
      reclaims the running task, clears the assignee, and leaves it `ready`.
- [ ] `FF_ASSIGN_REASSIGN=true kdi reclaim 42 --reason "manual"` records a
      `reclaimed` event with reason `"manual"`.
- [ ] `FF_ASSIGN_REASSIGN=false kdi assign 42 opencode` exits with
      "Assign/reassign feature is not enabled."
- [ ] `FF_ASSIGN_REASSIGN=false kdi reassign 42 codex` exits with the same
      gating error.
- [ ] `FF_ASSIGN_REASSIGN=false kdi reclaim 42 --reason "manual"` exits with
      a clear error that the `--reason` option requires the feature flag.
- [ ] `kdi assign` and `kdi reassign` reject empty profile values.
- [ ] Unit and CLI tests cover assignment, unassignment, reclaim-then-assign,
      reason propagation, and flag gating.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Reclaiming and reassigning a running task in two steps creates a
  window where another dispatcher tick could claim the task before the assignee
  is updated.
  **Mitigation:** wrap the reclaim and assignee update in a single database
  transaction in `reassignTask`.
- **Risk:** `kdi reclaim` already exists without `--reason`; adding a gated
  `--reason` option may confuse users.
  **Mitigation:** keep the base command available; only reject `--reason` when
  the flag is disabled, with a clear message.
- **Open question:** Should assignment validate that the profile exists in
  `profiles.yaml`? This BRD intentionally does not validate, so tasks can be
  assigned to profiles that will be created before dispatch.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`assignee` updates, event emission helpers).
- `src/models/claim.ts` (`reclaimTask`).
- `src/commands/tasks.ts` (`kdi assign`, `kdi reassign`, `--reason` on reclaim).
- `src/flags.ts` (`FF_ASSIGN_REASSIGN`).
