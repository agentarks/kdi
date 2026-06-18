# BRD-KDI-041: Swarm Mode

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Coordinate a multi-agent task graph from a single CLI invocation. A swarm
spawns parallel specialist workers, feeds their results into a verifier, and
finally feeds the verifier result into a synthesizer that produces a unified
output. The orchestrator task captures the overall request and final outcome,
so the board shows one named swarm job instead of a loose collection of tasks.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a team lead, I can run `kdi swarm --worker backend:auth --worker
   frontend:login --verifier qa --synthesizer pm` so the board receives a
   ready-to-run graph of related agent tasks.
2. As an operator, I can inspect the orchestrator task to see the swarm
   composition and current state without opening every child task.
3. As a reviewer, I can trace how worker results were presented to the
   verifier and how the verifier result was presented to the synthesizer.
4. As a user, I can run `kdi swarm --dry-run ...` to preview the planned
   task graph before committing it to the database.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi swarm` creates one orchestrator task, N worker tasks, one verifier task,
  and one synthesizer task on the resolved board in a single transaction.
- Dependency edges use the existing `dependencies(parent_id, child_id)` table:
  - Each worker task is a parent of the verifier task.
  - The verifier task is the parent of the synthesizer task.
- Worker tasks are created in `ready` status and run in parallel.
- The verifier task is created in `ready` status but is blocked by the worker
  dependencies; the dispatcher will not claim it until every worker is `done`.
- The synthesizer task is created in `ready` status but is blocked by the
  verifier dependency; the dispatcher will not claim it until the verifier is
  `done`.
- The orchestrator task is created in `triage` status and is not dispatched.
  It is a synthetic container that tracks the overall swarm state.
- All child tasks share the same `board_id`, `body`, `workspace_kind`,
  `workspace`, `session_id`, and `priority` copied from CLI options.
- Each child task stores `swarm_parent_id = orchestrator.id` so the graph can
  be reconstructed and the dispatcher can watch the orchestrator.
- Worker titles must be unique within a single swarm invocation to keep result
  references unambiguous in verifier context. Duplicate profiles are allowed
  (e.g. `--worker backend:auth --worker backend:oauth`).
- When the synthesizer task completes, the orchestrator task is automatically
  transitioned to `done` with `result` and `summary` copied from the
  synthesizer, and a `swarm_completed` event is emitted.
- If any swarm child task reaches a terminal non-done status (`blocked` or
  `archived`), the orchestrator task is transitioned to `blocked` with a reason
  naming the failed child, and a `swarm_failed` event is emitted. The verifier
  and synthesizer are never dispatched.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for swarms with up to 20 workers.
- Graph creation is atomic: a failure after some inserts rolls back the entire
  swarm.
- No breaking change to existing `kdi create`, `kdi dispatch`, or dependency
  behavior when the flag is disabled.
- Result propagation reuses the existing KDI-023 context builder instead of
  introducing a separate data pipeline.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_swarm_mode` registered in `src/flags.ts`:
  ```ts
  export const FF_SWARM_MODE = "FF_SWARM_MODE";
  registerFlag(FF_SWARM_MODE, false);
  ```
- Env var form: `FF_SWARM_MODE=false`.
- Defaults to `false` in every environment.
- Gated surfaces:
  - `kdi swarm` command and all its options.
  - Dispatcher swarm completion/failure watcher.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
The existing `dependencies` table already provides the required ordering
semantics and requires no changes.

Add one nullable column to `tasks` for swarm membership:

```ts
const tableInfo = dbInstance.query("PRAGMA table_info(tasks)").all() as any[];
if (!tableInfo.some((col) => col.name === "swarm_parent_id")) {
  dbInstance.exec("ALTER TABLE tasks ADD COLUMN swarm_parent_id INTEGER");
}
dbInstance.exec(
  "CREATE INDEX IF NOT EXISTS idx_tasks_swarm_parent ON tasks(board_id, swarm_parent_id)"
);
```

Also add `swarm_parent_id INTEGER` to the `tasks` table in `SCHEMA` and to any
`tasks_new` recreation migration so new databases include it from the start.
The column is nullable and ignored when `FF_SWARM_MODE=false`.

No other tables are added or altered.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
```
kdi swarm --worker <profile>:<title> [--worker ...] \
          --verifier <profile> --synthesizer <profile> \
          [--board <slug>] [--body <text>] [--workspace <path>] \
          [--session <id>] [--priority <n>] [--kind <kind>] [--dry-run]
```

| Option | Cardinality | Meaning |
|---|---|---|
| `--worker <profile>:<title>` | 1..N | Repeatable. Creates a child task titled `<title>` assigned to harness profile `<profile>`. |
| `--verifier <profile>` | 1 | Harness profile that reviews all worker results. |
| `--synthesizer <profile>` | 1 | Harness profile that produces the final answer from the verifier result. |
| `--board <slug>` | 0..1 | Target board. Resolves via `--board` → `KDI_BOARD` → current-board file → `"default"`. |
| `--body <text>` | 0..1 | Shared description stored on the orchestrator task body and copied to every child task body. |
| `--workspace <path>` | 0..1 | Workspace path stored on every swarm task. |
| `--session <id>` | 0..1 | Session id stored on every swarm task (`session_id`). |
| `--priority <n>` | 0..1 | Integer priority stored on every swarm task (default `0`). |
| `--kind <kind>` | 0..1 | Workspace kind (`dir`, `worktree`, `scratch`; default `worktree`). |
| `--dry-run` | 0..1 | Print the planned task graph and exit without mutating state. |

Validation rules:
- At least one `--worker` is required.
- Both `--verifier` and `--synthesizer` are required.
- Each `--worker` value must match `^[^:]+:.+$` (profile, colon, non-empty title).
- Duplicate worker titles within one swarm invocation are rejected. Duplicate
  profiles are allowed.
- `--priority`, if given, must be an integer.
- `--kind`, if given, must be one of `dir`, `worktree`, `scratch`.
- When `FF_SWARM_MODE=false`, the command exits with "Swarm mode is not enabled."

`--dry-run` behavior:
- Resolve the board, validate all inputs, and print a structured
  representation of the orchestrator task and the planned child tasks with
  dependency edges.
- Do not write to `tasks`, `dependencies`, or `task_events`.
- Exit `0` on success.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `src/models/swarm.ts`
   ```ts
   export interface SwarmInput {
     board_id: number;
     workers: { profile: string; title: string }[];
     verifier: string;
     synthesizer: string;
     body?: string;
     workspace_kind?: "dir" | "worktree" | "scratch";
     workspace?: string;
     session_id?: string;
     priority?: number;
   }

   export interface SwarmGraph {
     orchestrator_id: number;
     worker_ids: number[];
     verifier_id: number;
     synthesizer_id: number;
   }

   export function createSwarmGraph(input: SwarmInput): SwarmGraph;
   ```
   - Validates inputs: at least one worker, non-empty verifier/synthesizer,
     valid worker format, no duplicate worker titles.
   - Creates the orchestrator, worker, verifier, and synthesizer task rows and
     the dependency rows inside a single transaction.
   - Emits `swarm_created`, `swarm_worker_created`,
     `swarm_verifier_created`, and `swarm_synthesizer_created` events.
   - Throws on validation errors or database failure; the transaction rolls
     back the entire graph.

2. Orchestrator task creation:
   - `title`: `"swarm: "` + a short generated slug based on the first worker
     title plus a timestamp.
   - `status`: `triage`.
   - `assignee`: `null`.
   - `body`, `priority`, `workspace_kind`, `workspace`, `session_id`: copied
     from CLI options.
   - `swarm_parent_id`: `null`.

3. Worker task creation (one per `--worker`):
   - `title`: worker `<title>`.
   - `assignee`: worker `<profile>`.
   - `status`: `ready`.
   - `body`, `priority`, `workspace_kind`, `workspace`, `session_id`: copied
     from CLI options.
   - `swarm_parent_id`: orchestrator task id.

4. Verifier task creation:
   - `title`: `"verify: "` + orchestrator title suffix.
   - `assignee`: `--verifier` profile.
   - `status`: `ready`.
   - `body`, `priority`, `workspace_kind`, `workspace`, `session_id`: copied
     from CLI options.
   - `swarm_parent_id`: orchestrator task id.
   - Dependencies: one row per worker task (`parent_id = worker_id`,
     `child_id = verifier_id`).

5. Synthesizer task creation:
   - `title`: `"synthesize: "` + orchestrator title suffix.
   - `assignee`: `--synthesizer` profile.
   - `status`: `ready`.
   - `body`, `priority`, `workspace_kind`, `workspace`, `session_id`: copied
     from CLI options.
   - `swarm_parent_id`: orchestrator task id.
   - Dependency: `parent_id = verifier_id`, `child_id = synthesizer_id`.

6. Dispatcher swarm watcher:
   - The dispatcher already checks `isBlockedByDependencies(task.id)` before
     claiming a `ready` task; this guarantees verifier and synthesizer ordering.
   - After a synthesizer task is finalized with `outcome = 'completed'`, if the
     task has `swarm_parent_id` set, load the orchestrator and transition it to
     `done` with `result`/`summary` copied from the synthesizer. Emit a
     `swarm_completed` event on the orchestrator.
   - During each tick, scan orchestrator tasks in `triage` status. If any child
     with `swarm_parent_id = orchestrator.id` is `blocked` or `archived`,
     transition the orchestrator to `blocked` with a reason naming the child
     task, and emit a `swarm_failed` event.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
New `task_events` kinds:
- `swarm_created` — on the orchestrator task when the swarm graph is created.
- `swarm_worker_created` — on each worker task at creation.
- `swarm_verifier_created` — on the verifier task at creation.
- `swarm_synthesizer_created` — on the synthesizer task at creation.
- `swarm_completed` — on the orchestrator task when the synthesizer completes
  and the orchestrator is auto-completed.
- `swarm_failed` — on the orchestrator task when a swarm child is blocked or
  archived.

Payloads include the relevant swarm member ids so the graph can be
reconstructed from events.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] `FF_SWARM_MODE=true kdi swarm --worker backend:auth --worker frontend:login
      --verifier qa --synthesizer pm --board myproj` creates one orchestrator
      task in `triage`, two worker tasks in `ready`, one verifier task in
      `ready`, and one synthesizer task in `ready`.
- [x] The verifier task has `dependencies` rows pointing to both worker tasks;
      the synthesizer task has a dependency row pointing to the verifier task.
- [x] All child tasks have `swarm_parent_id` set to the orchestrator task id;
      the orchestrator task has `swarm_parent_id = null`.
- [x] `FF_SWARM_MODE=false kdi swarm ...` exits with "Swarm mode is not enabled."
- [x] `kdi swarm --verifier qa --synthesizer pm` (no `--worker`) exits with a
      clear error requiring at least one worker.
- [x] `kdi swarm --worker backend:auth --synthesizer pm` (no `--verifier`)
      exits with a clear error requiring `--verifier`.
- [x] `kdi swarm --worker backend:auth --verifier qa` (no `--synthesizer`)
      exits with a clear error requiring `--synthesizer`.
- [x] `kdi swarm --worker backend:auth --worker backend:auth --verifier qa
      --synthesizer pm` exits with a clear error because the worker title
      `auth` is duplicated.
- [x] `kdi swarm --worker backend --verifier qa --synthesizer pm` exits with a
      clear error because the worker value is missing the `:title` suffix.
- [x] `kdi swarm --worker backend:auth --worker frontend:login --verifier qa
      --synthesizer pm --dry-run` prints the planned orchestrator, workers,
      verifier, and synthesizer with dependency edges and creates zero tasks.
- [x] After both worker tasks complete, the dispatcher claims and runs the
      verifier task. The verifier context (via KDI-023) includes both worker
      results as parent results.
- [x] After the verifier completes, the dispatcher claims and runs the
      synthesizer task. The synthesizer context includes the verifier result as
      a parent result.
- [x] After the synthesizer completes, the orchestrator task transitions to
      `done` with `result`/`summary` copied from the synthesizer task, and a
      `swarm_completed` event is emitted.
- [x] If any worker task is blocked, the orchestrator task transitions to
      `blocked`, the verifier and synthesizer are never dispatched, and a
      `swarm_failed` event is emitted.
- [x] `bun run lint`, `bun run test`, and `bun run build` pass.

-------------------------------------------------------------------------------
Risks / Mitigations
-------------------------------------------------------------------------------
- **Risk:** The orchestrator task starts in `triage` and is only visible to
  `kdi list --status triage` or `kdi show <id>`. Operators may expect it to
  appear in `kdi list --status ready` while running.
  **Mitigation:** Document that the orchestrator is a synthetic container and
  point operators to `kdi show <orchestrator_id>` for swarm status.
- **Risk:** A worker title that is very long could make verifier context
  labels unwieldy.
  **Mitigation:** Cap worker titles at the existing task title length or
  truncate them in event payloads; this is an implementation detail.
- **Risk:** A manually moved orchestrator task could conflict with the swarm
  watcher.
  **Mitigation:** The dispatcher watcher only transitions orchestrator tasks
  that are still in `triage` status.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` (`FF_SWARM_MODE` registration).
- `src/db.ts` (`swarm_parent_id` column migration and index).
- `src/models/dependency.ts` (`addDependency`, `isBlockedByDependencies`).
- `src/models/context.ts` (KDI-023 context builder for parent results).
- `src/models/task.ts` (`createTask`, `completeTask`, `blockTask`).
- `src/models/taskEvent.ts` (`addEvent`).
- `src/commands/swarm.ts` (new CLI command).
- `src/index.ts` (command wiring).
- `src/dispatcher.ts` (swarm completion/failure watcher).
