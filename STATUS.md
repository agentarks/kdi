# kdi — Status

## Board Management
- [ ] `kdi boards create <slug> --workdir <path>` — creates board with SQLite db
- [ ] `kdi boards list` — list all boards
- [ ] `kdi boards show <slug>` — show board details + task counts
- [ ] `kdi boards archive <slug>` — archive board (soft delete)

## Task Lifecycle
- [x] `kdi create <title> --board <slug> --assignee <profile>` — create task
- [x] `kdi create <title> --board <slug> --triage` — create task in triage
- [x] `kdi specify <task_id> --board <slug>` — promote triage → todo
- [x] `kdi specify --all --board <slug>` — promote all triage tasks
- [x] `kdi list --board <slug> --status <status>` — list tasks filtered
- [x] `kdi show <task_id>` — show task details
- [x] `kdi edit <task_id> --body <text>` — edit task body
- [x] `kdi comment <task_id> <text>` — add comment
- [x] `kdi promote <task_id>` — move todo → ready
- [x] `kdi block <task_id> --reason <text>` — mark blocked
- [x] `kdi unblock <task_id>` — unblock task
- [x] `kdi archive <task_id>` — archive task
- [x] `kdi tail <task_id>` — tail events for a task
- [x] `kdi watch` — watch board-wide events

## Triage Status (KDI-001) — Done
- [x] `triage` status added to tasks CHECK constraint (with migration via table recreation)
- [x] `kdi create --triage` parks new tasks in `triage` instead of `todo`
- [x] `kdi specify <task_id>` promotes `triage` → `todo` (requires non-empty body)
- [x] `kdi specify --all` sweeps all triage tasks on a board
- [x] `specified` event emitted on promotion

## Task Runs (KDI-000)
- [x] `task_runs` table with per-attempt history (profile, step_key, status, claim_lock, worker_pid, started_at, ended_at, outcome, summary, metadata, error)
- [x] Dispatcher creates a `task_runs` row on claim and finalizes it on finish/fail
- [x] `kdi runs <task_id>` — show attempt history

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

## Harness Profiles
- [ ] Profile registry at `~/.config/kdi/profiles.yaml`
- [ ] Built-in profiles: opencode, claude, codex, pi
- [ ] Template substitution: `{{workdir}}`, `{{branch}}`, `{{task_id}}`, `{{agent}}`
- [ ] Profile validation on load

## Dispatcher
- [ ] `kdi dispatch` — background polling daemon
- [ ] Poll interval configurable (default 5s)
- [ ] Claim ready tasks (CAS: ready → running)
- [ ] Resolve assignee → harness profile → command
- [ ] Spawn in isolated git worktree
- [ ] Capture stdout/stderr/exit code
- [ ] Update task status: done / failed
- [x] Task runs table (per-attempt history)

## Worktree Isolation
- [ ] Auto-create worktree branch `wt/<profile>/<task_id>`
- [ ] Configurable base ref (default `origin/main`)
- [ ] Cleanup on completion

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

## Known Bugs (2026-06-10)

### BUG-001: `kdi claim` CLI does not create `task_runs` row
- **File**: `src/models/claim.ts:15` (`atomicClaim`)
- **Issue**: `atomicClaim()` only updates the `tasks` table (sets `claim_lock`, `claim_expires`, `status=running`). It does **not** insert a row into `task_runs`.
- **Impact**: Manually claimed tasks (via `kdi claim`) show no run history in `kdi runs <task_id>`. The dispatcher's `claimTask()` in `src/dispatcher.ts:137` correctly creates a run, but the standalone CLI command bypasses this.
- **Fix needed**: `atomicClaim` should either (a) create a `task_runs` row itself, or (b) the CLI command should call a unified claim function that creates the run.

### BUG-002: `kdi reclaim` CLI does not finalize active `task_runs` row
- **File**: `src/models/claim.ts:39` (`reclaimTask`)
- **Issue**: `reclaimTask()` clears `claim_lock`, `claim_expires`, and sets `status=ready` on the `tasks` table, but it does **not** call `finishRun()` on `task.current_run_id`.
- **Impact**: Reclaimed runs remain with `status='running'` in `task_runs` forever. The dispatcher's `reapStaleClaims()` in `src/dispatcher.ts:202` correctly calls `finishRun()`, but the manual CLI reclaim does not.
- **Fix needed**: `reclaimTask()` should look up `task.current_run_id`, call `finishRun(runId, 'reclaimed', ...)` if present, and emit a `reclaimed` event.

## Acceptance Criteria
- [x] `kdi create "backend: auth" --board myproj --assignee opencode` returns task ID
- [x] Task promoted to ready claimed by dispatcher within 10s
- [x] Harness runs in worktree branch `wt/<profile>/<task_id>`
- [x] Task result stored and visible via `show <task_id>`
- [x] Parent dependency blocks child until parent done
- [x] 100 tasks created + dispatched without SQLite contention
- [x] `kdi --version` returns semantic version
- [x] Adding new harness profile to `profiles.yaml` requires zero code changes
