# kdi — Status

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
- [x] `kdi boards rename <old-slug> <new-slug>` — rename a board (slug, data directory, current-board)

## Board Metadata (KDI-012) — Done
- [x] `name`, `icon`, `color` columns added to `boards` table (schema + migration)
- [x] Feature flag `ff_board_metadata` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards create <slug> --workdir <path> [--name <name>] [--icon <icon>] [--color <color>]` — stores board metadata when flag enabled
- [x] `kdi boards edit <slug> [--name <name>] [--icon <icon>] [--color <color>]` — updates board metadata when flag enabled
- [x] `kdi boards show <slug>` displays Name, Icon, Color when set and flag enabled
- [x] `kdi boards list` shows metadata compactly when flag enabled
- [x] Board name defaults to slug when omitted; icon and color default to null

## Board Rename (KDI-014) — Done
- [x] `FF_BOARD_RENAME` flag registered in `src/flags.ts`, defaults to `false`
- [x] `kdi boards rename <old-slug> <new-slug>` command added to `src/commands/boards.ts`
- [x] `renameBoard()` model function in `src/models/board.ts` handles DB slug update and directory rename
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

## Task Lifecycle
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
- [x] `kdi runs <task_id>` — show attempt history

## Task Runs Status (KDI-000e)
- [x] `status` column on `task_runs`: `running | done | blocked | crashed | timed_out | failed | released`
- [x] Distinct from `outcome` (terminal classification)
- [x] Indexed: `idx_runs_status`
- [x] `finishRun` maps outcome → status (e.g. `reclaimed` → `released`, `crashed` → `crashed`)

## Task Events (KDI-000b)
- [x] `task_events` table with task_id, run_id, kind, payload, created_at
- [x] `kdi tail <task_id>` — follow events live (poll 1s)
- [x] `kdi watch` — board-wide event stream (poll 0.5s)
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
- [ ] Parent/child task blocking
- [ ] Child waits until parent is `done`
- [ ] Dependency chain resolution

## Notifications
- [ ] Terminal delivery on task completion
- [ ] Webhook support (v2)

## Feature Flags
- [ ] `FF_ENABLE_KANBAN_DISPATCH` — gates dispatcher loop
- [ ] Defaults to `false` everywhere

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
- [ ] **SQLite monolithic migration** — The single `CREATE TABLE tasks_new ... DROP TABLE ... RENAME TO` migration handles schema changes for KDI-001 (triage), KDI-002 (scheduled), KDI-003 (review), and KDI-004 (integer priority) in one pass. This is technically required by SQLite (can't `ALTER TABLE` CHECK constraints or change column types), but it mixes feature boundaries. If versioned migration files are ever introduced, this should be split into per-feature steps with intermediate schema versions.

## Acceptance Criteria
- [x] `kdi create "backend: auth" --board myproj --assignee opencode` returns task ID
- [x] Task promoted to ready claimed by dispatcher within 10s
- [x] Harness runs in worktree branch `wt/<profile>/<task_id>`
- [x] Task result stored and visible via `show <task_id>`
- [x] Parent dependency blocks child until parent done
- [x] 100 tasks created + dispatched without SQLite contention
- [x] `kdi --version` returns semantic version
- [x] Adding new harness profile to `profiles.yaml` requires zero code changes
