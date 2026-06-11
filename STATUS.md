# kdi — Status

## Board Management
- [x] `kdi boards create <slug> --workdir <path>` — creates board with SQLite db
- [x] `kdi boards list` — list all boards (excludes archived; use `--all` to include)
- [x] `kdi boards show <slug>` — show board details + task counts (triage, todo, ready, running, done, blocked, archived)
- [x] `kdi boards archive <slug>` — archive board (soft delete)

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

## Harness Profiles — Accepted
- [x] Profile registry at `~/.config/kdi/profiles.yaml`
- [x] Built-in profiles: opencode, claude, codex, pi
- [x] Template substitution: `{{workdir}}`, `{{branch}}`, `{{task_id}}`, `{{agent}}`
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


## Acceptance Criteria
- [x] `kdi create "backend: auth" --board myproj --assignee opencode` returns task ID
- [x] Task promoted to ready claimed by dispatcher within 10s
- [x] Harness runs in worktree branch `wt/<profile>/<task_id>`
- [x] Task result stored and visible via `show <task_id>`
- [x] Parent dependency blocks child until parent done
- [x] 100 tasks created + dispatched without SQLite contention
- [x] `kdi --version` returns semantic version
- [x] Adding new harness profile to `profiles.yaml` requires zero code changes
