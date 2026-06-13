# KDI Backlog — Hermes Kanban Feature Port

> Source: NousResearch/hermes-agent `hermes_cli/kanban.py` + `hermes_cli/kanban_db.py`
> Hermes Kanban is the SQLite-backed multi-profile task board built into Hermes Agent.
> Investigation date: 2026-06-10

---

## Hermes Kanban Feature Inventory (Actual)

### Core Board Management
- Create boards with metadata: slug, name, description, icon, color, default_workdir
- List all boards with task counts + current-board marker
- Show current board
- Switch active board
- Rename board display name
- Set default workdir per board
- Archive (soft delete) or hard-delete boards
- Board resolution: `--board` flag → `HERMES_KANBAN_BOARD` env → `~/.hermes/kanban/current` file → `default`

### Task Lifecycle (9 statuses)
- `triage` → `todo` → `scheduled` → `ready` → `running` → `blocked` → `review` → `done` → `archived`
- `triage`: parking lot for unrefined tasks (specify/decompose promote to todo)
- `scheduled`: waiting on time, not human input
- `review`: distinct from blocked — task output is under review
- Create with `--initial-status running|blocked`
- Promote with `--force` (skip parent dependency check) and `--dry-run`
- Bulk operations: block/unblock/promote/archive multiple tasks at once

### Task Metadata (Rich)
- `priority`: integer tiebreaker (not enum), default 0
- `tenant`: namespace for multi-tenant filtering
- `created_by`: author tracking
- `max_runtime_seconds`: per-task runtime cap (SIGTERM then SIGKILL)
- `skills`: JSON array of force-loaded skills
- `model_override`: per-task model override
- `max_retries`: per-task circuit breaker override
- `goal_mode` + `goal_max_turns`: Ralph-style goal loop
- `session_id`: originating chat/agent session
- `workflow_template_id` + `current_step_key`: v2 workflow routing
- `claim_lock` + `claim_expires`: CAS claim with TTL (default 15min)
- `last_heartbeat_at`: worker liveness signal
- `current_run_id`: pointer to active task_runs row
- `last_failure_error`: last spawn/execution error

### Task Runs (Per-Attempt History)
- Each claim creates a `task_runs` row
- Columns: profile, step_key, status, claim_lock, claim_expires, worker_pid, max_runtime_seconds, last_heartbeat_at, started_at, ended_at, outcome, summary, metadata, error
- Outcomes: completed | blocked | crashed | timed_out | spawn_failed | gave_up | reclaimed
- `runs` CLI command shows attempt history

### Task Events (Audit Stream)
- `task_events` table: task_id, run_id, kind, payload, created_at
- `tail` command follows event stream live
- `watch` command live-streams board-wide events
- Events drive notification delivery

### Task Comments
- Author-attached comments with timestamp
- Block reason recorded as comment

### Task Links (Dependencies)
- `task_links` table: parent_id → child_id
- Cycle detection on link creation
- Child inherits blocked state from non-done parents
- `link` / `unlink` CLI commands

### Task Attachments
- `task_attachments` table: filename, stored_path, content_type, size, uploaded_by
- Files stored on disk under `attachments_root/<task_id>/`

### Worker Lifecycle
- `claim`: atomically claim ready task (CAS: ready → running)
- `heartbeat`: worker liveness signal
- `complete`: mark done with result, summary, metadata
- `edit`: backfill recovery fields on done tasks
- `reclaim`: release active claim (operator recovery)
- `reassign`: change assignee, optionally reclaim first
- Claim TTL: 15min default, env override `HERMES_KANBAN_CLAIM_TTL_SECONDS`
- Crash grace: 30s before PID liveness check
- Rate-limit exit code: 75 (EX_TEMPFAIL) → requeue without failure count
- Stale claim detection: heartbeat older than 60min → auto-reclaim

### Dispatch & Execution
- `dispatch`: one-shot dispatcher pass (reclaim stale → promote ready → spawn workers)
- `daemon`: deprecated, dispatcher runs in gateway now
- Spawn failure circuit breaker: auto-block after N consecutive failures
- Dry-run mode for dispatch
- Max spawns per tick cap
- Worker stdout/stderr captured to `kanban/logs/<task_id>.log`
- `log` CLI command prints worker logs

### Notification Subscriptions
- `kanban_notify_subs` table: task-level subscriptions for gateway delivery
- Platform + chat_id + thread_id + user_id targeting
- `notify-subscribe` / `notify-list` / `notify-unsubscribe` CLI commands
- Gateway notifier watcher tails task_events and pushes to subscribers

### Board Health & Diagnostics
- `diagnostics` command: board-wide health checks
- Severity filtering: warning | error | critical
- Per-task diagnostic listing
- `stats` command: per-status + per-assignee counts + oldest-ready age

### Garbage Collection
- `gc` command: clean archived-task workspaces, old events, old logs
- Configurable retention: `--event-retention-days`, `--log-retention-days`

### Triage Automation
- `specify`: flesh out triage task via auxiliary LLM, promote to todo
- `decompose`: fan-out triage task into child task graph via auxiliary LLM
- `--all` sweep mode for both commands
- Tenant-restricted sweeps

### Swarm Mode
- `swarm` command: parallel workers → verifier → synthesizer graph
- Worker cards with profile:title:skill syntax
- Configurable verifier + synthesizer profiles

### Context Building
- `context` command: print full worker context (title + body + parent results + comments)
- Parent results concatenated into worker prompt

### Assignee Management
- `assignees` command: list known profiles + per-profile task counts
- Union of `~/.hermes/profiles/` and current board assignees

### Concurrency & Safety
- WAL mode + `BEGIN IMMEDIATE` for writes
- CAS updates on status and claim_lock
- Per-board isolation (separate DBs under `~/.hermes/kanban/boards/<slug>/kanban.db`)
- Cross-process init lock for schema setup (`kanban.db.init.lock`)
- Busy timeout: 120s default, env override

### Supplemental CLI Behaviors Discovered
- **`init`** command: idempotent DB creation
- **Global `--board` flag**: board resolution chain → `HERMES_KANBAN_BOARD` env → `~/.hermes/kanban/current` file → `default`
- **`boards list --all`**: include archived boards
- **`boards rm --delete`**: hard-delete board directory (default is soft-archive to `boards/_archived/`)
- **`boards create --switch`**: auto-switch to new board after creation
- **`boards set-default-workdir` with no path**: clears the default workdir
- **`create --idempotency-key`**: dedup key; returns existing non-archived task id if matched
- **`create --initial-status {blocked,running}`**: choose initial status (default running)
- **`list --mine`**: filter by `$HERMES_PROFILE` as assignee
- **`list --session`**: filter by originating chat/agent session id
- **`list --archived`**: include archived tasks in listing
- **`list --sort`**: `assignee`, `created`, `created-desc`, `priority`, `priority-desc`, `status`, `title`, `updated`
- **`list --workflow-template-id` / `--step-key`**: v2 workflow filtering
- **`show --state-type {status,outcome} --state-name VALUE`**: filter displayed runs
- **`block --ids IDS...`**: bulk block multiple tasks with same reason
- **`schedule --ids IDS...`**: bulk schedule multiple tasks with same reason
- **`unblock --reason`**: optional reason recorded as comment before unblocking
- **`promote --ids IDS...`**: bulk promote multiple tasks
- **`promote --force`**: promote even if parent dependencies not done
- **`promote --dry-run`**: validate promotion without mutating state
- **`archive --rm PURGE_IDS...`**: permanently delete already-archived tasks
- **`claim --ttl`**: custom claim TTL in seconds (default 900)
- **`comment --author`**: author name (default `$HERMES_PROFILE` or `user`)
- **`comment --max-len`**: trim stored comment body to N characters
- **`complete`**: accepts multiple `task_ids` (only `--result` applies to all)
- **`dispatch --max`**: cap number of spawns this pass
- **`dispatch --failure-limit`**: per-pass auto-block threshold override
- **`watch --assignee` / `--tenant` / `--kinds`**: filter event stream
- **`watch --interval`**: poll interval (default 0.5s)
- **`heartbeat --note`**: optional short note attached to heartbeat event
- **`log --tail N`**: only print last N bytes
- **`runs --state-type {status,outcome} --state-name VALUE`**: filter runs by column
- **`notify-subscribe --notifier-profile`**: profile gateway that owns/delivers subscription
- **`notify-list`**: optional `task_id` arg (lists all subs if omitted)
- **`notify-unsubscribe --thread-id`**: thread-scoped unsubscription
- **`assign` / `reassign`**: profile name `none` unassigns the task
- **`reassign --reason`**: human-readable reason recorded on reclaimed event
- **`reclaim --reason`**: human-readable reason recorded on reclaimed event
- **Rate-limit exit code**: `EX_TEMPFAIL` (75) → worker requeued to `ready` WITHOUT incrementing failure count
- **Crash grace**: 30s before PID liveness check after expected worker start
- **Dispatcher presence warning**: `hermes kanban create` warns if no gateway/dispatcher is running
- **`task_runs.status` column**: `running | done | blocked | crashed | timed_out | failed | released` (distinct from `outcome`)
- **`task_events` kinds**: `completed`, `blocked`, `gave_up`, `crashed`, `timed_out`, `spawn_auto_blocked`, `attached`, `reclaimed`, `heartbeat`, etc.
- **Diagnostic rules**: `hallucinated_cards`, `triage_aux_unavailable`, `prose_phantom_refs`, `repeated_failures`, `repeated_crashes`, `stuck_in_blocked`, `block_unblock_cycling`, `stranded_in_ready`
- **Diagnostic actions**: `reclaim`, `reassign`, `unblock`, `cli_hint`, `open_docs`, `comment`

---

## KDI Current State Gap Analysis

| Hermes Feature | KDI Status | Gap |
|---|---|---|
| Board metadata (name, desc, icon, color) | Missing entirely | KDI boards only have slug + workdir |
| `triage` status | **Done** (basic) | `kdi create --triage`, `kdi specify` |
| `scheduled` status | Missing | KDI has no time-waiting state |
| `review` status | Missing | KDI conflates review with blocked |
| Integer priority (tiebreaker) | Partial | KDI has enum low/medium/high |
| `tenant` namespace | Missing | No multi-tenant filtering |
| `created_by` | Missing | No author tracking |
| `max_runtime_seconds` | Missing | No per-task runtime cap |
| `skills` array | Missing | No force-loaded skills |
| `model_override` | Missing | No per-task model override |
| `max_retries` / circuit breaker | Missing | No failure limit |
| `goal_mode` / `goal_max_turns` | Missing | No goal loop |
| `session_id` | Missing | No session tracking |
| `workflow_template_id` | Missing | No workflow routing |
| `task_runs` table | **Done** | `kdi runs <task_id>` |
| `task_events` table | **Done** | `kdi tail`, `kdi watch` |
| `task_attachments` table | Missing | No file attachments |
| `claim_lock` + TTL | **Done** | `kdi claim`, `kdi reclaim` |
| `heartbeat` | **Done** | `kdi heartbeat` |
| `reclaim` command | **Done** | `kdi reclaim` |
| `reassign` command | Missing | No assignee change |
| `schedule` command/status | Missing | No scheduled state |
| `assign` command | Missing | No direct assignment |
| `complete` with metadata | Partial | KDI has no result/summary/metadata |
| `tail` / `watch` | **Done** | `kdi tail`, `kdi watch` |
| `stats` | Missing | No board stats |
| `log` | Missing | No worker log access |
| `runs` | **Done** | `kdi runs <task_id>` |
| `context` | Missing | No worker context builder |
| `assignees` | Missing | No profile listing |
| `gc` | Missing | No garbage collection |
| `diagnostics` | Missing | No health checks |
| `specify` / `decompose` | Missing | No triage automation |
| `swarm` | Missing | No swarm mode |
| Notification subscriptions | Missing | No notify subs |
| Cross-process init lock | Missing | SQLite init not serialized |
| `started_at` | Missing from schema | Added via migration in KDI |
| `init` command | Missing | No idempotent DB creation command |
| Global `--board` + env resolution | Missing | KDI has no board resolution chain |
| `boards list --all` | Missing | Cannot list archived boards |
| `boards rm --delete` | Missing | No hard-delete option |
| `boards create --switch` | Missing | No auto-switch after create |
| `create --idempotency-key` | Missing | No dedup key support |
| `create --initial-status` | Missing | KDI create always goes to `todo` |
| `list --mine` | Missing | No current-profile filter |
| `list --session` | Missing | No session filtering |
| `list --archived` | Missing | Cannot include archived in list |
| `list --sort` | Missing | No sort options (only created_at DESC) |
| `list --workflow-template-id` / `--step-key` | Missing | No v2 workflow filtering |
| `show --state-type` / `--state-name` | Missing | No run filtering on show |
| `block --ids` / `schedule --ids` / `promote --ids` | Missing | No bulk ops flags |
| `promote --force` / `--dry-run` | Missing | No skip-parent or validate-only |
| `archive --rm` | Missing | No permanent deletion of archived tasks |
| `claim --ttl` | Missing | No custom TTL param |
| `comment --author` / `--max-len` | Missing | No author tracking or trim |
| `unblock --reason` | Missing | No reason on unblock |
| `complete` multiple IDs | Missing | Only single-task complete |
| `dispatch --max` / `--failure-limit` | Missing | No spawn cap or per-pass limit |
| `watch --assignee` / `--tenant` / `--kinds` | Missing | No event stream filters |
| `heartbeat --note` | Missing | No heartbeat note |
| `log --tail` | Missing | No byte-limit on log read |
| `runs --state-type` / `--state-name` | Missing | No run filtering |
| `notify-subscribe --notifier-profile` | Missing | No notifier profile |
| `notify-list` without task_id | Missing | No global subscription list |
| `notify-unsubscribe --thread-id` | Missing | No thread-scoped unsub |
| `assign` / `reassign` → `none` | Missing | No unassign support |
| `reclaim --reason` / `reassign --reason` | Missing | No reason on recovery ops |
| Rate-limit exit code (EX_TEMPFAIL=75) | Missing | No rate-limit requeue path |
| Crash grace (30s) | Missing | No PID liveness grace |
| Dispatcher presence warning | Missing | No warning when dispatcher absent |
| `task_runs.status` column | Missing | Only `outcome` considered |
| Diagnostic rule engine (8 rules) | Missing | No automated health rules |
| `build_worker_context` caps/attachments | Missing | No bounded context builder |

---

## KDI Backlog: Features to Add

### Phase 0 — Schema Foundation (prerequisites for everything)
- [x] **KDI-000: Task runs table**
  - `task_runs` table with claim_lock, worker_pid, outcome, summary, metadata, error
  - Each dispatcher claim creates a run row
  - CLI: `kdi runs <task_id>`

- [x] **KDI-000b: Task events table**
  - `task_events` table: task_id, run_id, kind, payload, created_at
  - CLI: `kdi tail <task_id>` to follow events
  - CLI: `kdi watch` for board-wide event stream

- [x] **KDI-000c: CAS claim system**
  - `claim_lock` + `claim_expires` on tasks
  - `kdi claim <task_id>` — atomically claim ready task
  - `kdi reclaim <task_id>` — release active claim
  - `kdi heartbeat <task_id>` — worker liveness signal
  - Claim TTL default 15min, env override `KDI_CLAIM_TTL_SECONDS`
  - `kdi claim --ttl <seconds>` — per-claim TTL override

- [x] **KDI-000d: Cross-process init lock**
  - File-based lock (`<dbPath>.init.lock`) to serialize schema setup across concurrent processes
  - Stale lock detection via PID liveness check; released after migrations complete

- [x] **KDI-000e: `task_runs` status column**
  - `status` on `task_runs`: `running | done | blocked | crashed | timed_out | failed | released`
  - Distinct from `outcome` (which is terminal classification)
  - Indexed: `idx_runs_status`
  - `finishRun` maps each outcome to its corresponding status (e.g., `crashed` → `crashed`, `reclaimed` → `released`)

### Phase 1 — Task Lifecycle Expansion
- [x] **KDI-001: Triage status**
  - Add `triage` to status CHECK constraint
  - `kdi create --triage` parks in triage
  - `kdi specify <task_id>` promotes triage → todo (basic version, no LLM)
  - `kdi specify --all` — sweep entire triage column
  - `kdi specify --tenant <name>` — tenant-restricted sweep

- [x] **KDI-001b: `create --initial-status`**
  - `kdi create --initial-status <status>` (default: todo)
  - `blocked` skips the brief running→blocked transition for ops-gated tasks

- [x] **KDI-001c: Idempotency key**
  - `kdi create --idempotency-key <key>`
  - If non-archived task with key exists, return its id instead of creating duplicate
  - Index: `idx_tasks_idempotency`

- [x] **KDI-002: Scheduled status**
  - Add `scheduled` to status CHECK constraint
  - `kdi schedule <task_id> --reason "waiting on deploy"`
  - `kdi schedule --ids <id1> <id2>` — bulk schedule
  - `kdi unblock` returns scheduled → ready
  - `kdi unblock --reason "..."` — record reason as comment before unblocking

- [x] **KDI-003: Review status**
  - Add `review` to status CHECK constraint
  - Distinct from blocked — task output is under review
  - `kdi review <task_id>` or auto-transition on reviewer claim

- [x] **KDI-004: Integer priority**
  - Change `priority` from enum to INTEGER, default 0
  - Higher = more urgent
  - `kdi create --priority 5`

- [x] **KDI-005: Complete with metadata**
  - `kdi complete <task_id> --result "..." --summary "..." --metadata '{"tests": 12}'`
  - `kdi complete <id1> <id2> ...` — bulk complete (only `--result` applies to all)
  - Store result/summary on task, create task_runs row with outcome=completed

### Phase 2 — Task Metadata
- [x] **KDI-006: Tenant namespace**
  - Add `tenant TEXT` to tasks
  - `kdi create --tenant backend`
  - `kdi list --tenant backend`

- [x] **KDI-007: Created-by tracking**
  - Add `created_by TEXT NOT NULL DEFAULT 'unknown'`
  - `kdi create --created-by orchestrator`
  - Resolved conflict with backlog default `'user'`: BRD-KDI-007 specifies `"unknown"` for migration; implementation uses `"unknown"`. Backlog updated to match.

- [x] **KDI-008: Max runtime**
  - Add `max_runtime_seconds INTEGER`
  - Dispatcher SIGTERMs then SIGKILLs worker when exceeded
  - `kdi create --max-runtime 30m`

- [x] **KDI-009: Skills array**
  - Add `skills TEXT` (JSON array)
  - `kdi create --skill github --skill code-review`
  - Dispatcher passes skills to harness

- [x] **KDI-010: Model override**
  - Add `model_override TEXT`
  - `kdi create --model gpt-5.5`
  - Dispatcher passes `-m <model>` to harness

- [ ] **KDI-011: Max retries / circuit breaker**
  - Add `max_retries INTEGER`
  - Auto-block task after N consecutive spawn/execution failures
  - `kdi create --max-retries 3`

### Phase 3 — Board Management
- [ ] **KDI-012: Board metadata**
  - Add `name`, `description`, `icon`, `color` to boards
  - `kdi boards create myproj --name "My Project" --icon "🚀" --color "#8b5cf6"`
  - `kdi boards create --switch` — auto-switch to new board after creation

- [x] **KDI-012b: `kdi boards list --all`**
  - Include archived boards in listing

- [ ] **KDI-012c: `kdi boards rm --delete`**
  - Hard-delete board directory instead of soft-archive to `boards/_archived/`

- [ ] **KDI-013: Board switch / current**
  - `kdi boards switch <slug>` — write to `~/.local/share/kdi/current`
  - `kdi boards show` — print current board
  - `--board` flag on all commands
  - Env var `KDI_BOARD` overrides current file
  - Resolution chain: `--board` → `KDI_BOARD` env → `~/.local/share/kdi/current` → `default`

- [ ] **KDI-013b: `kdi init`**
  - Idempotent DB creation command (`kdi init`)
  - Separate from implicit init on first command

- [ ] **KDI-014: Rename board**
  - `kdi boards rename <slug> "New Name"`
  - Slug immutable, display name mutable

- [ ] **KDI-015: Default workdir**
  - `kdi boards set-default-workdir <slug> /path/to/project`
  - `kdi boards set-default-workdir <slug>` (no path) — clears default
  - Tasks created without `--workspace` inherit board default

### Phase 4 — Worker Lifecycle
- [ ] **KDI-016: Heartbeat**
  - `kdi heartbeat <task_id>` — worker liveness signal
  - `kdi heartbeat --note "..."` — optional note on heartbeat event
  - Updates `last_heartbeat_at` on task + active run
  - Stale heartbeat detection in dispatcher (older than 60min → auto-reclaim)

- [ ] **KDI-016b: Crash grace period**
  - 30s grace before PID liveness check after expected worker start
  - Prevents false crash detection on slow process startup

- [ ] **KDI-016c: Rate-limit exit code handling**
  - `EX_TEMPFAIL` (exit code 75) → requeue to `ready` WITHOUT incrementing `consecutive_failures`
  - Cooldown before respawn to avoid hammering rate-limited provider

- [ ] **KDI-017: Assign / reassign**
  - `kdi assign <task_id> <profile>`
  - `kdi assign <task_id> none` — unassign task
  - `kdi reassign <task_id> <profile> --reclaim`
  - `kdi reassign <task_id> none` — unassign
  - `kdi reassign --reason "..."` — record reason on reclaimed event
  - `kdi reclaim <task_id> --reason "..."` — record reason on reclaimed event

- [ ] **KDI-018: Worker log capture**
  - Capture stdout/stderr to `~/.local/share/kdi/logs/<board>/<task_id>.log`
  - `kdi log <task_id>` — print log
  - `kdi log <task_id> --tail 100` — last N bytes

### Phase 5 — Observability & Health
- [ ] **KDI-019: Stats**
  - `kdi stats` — per-status + per-assignee counts + oldest-ready age
  - `kdi stats --json`

- [ ] **KDI-020: Diagnostics**
  - `kdi diagnostics` — board-wide health checks
  - `kdi diagnostics --severity error`
  - `kdi diagnostics --task <task_id>`
  - 8 automated rules: `hallucinated_cards`, `triage_aux_unavailable`, `prose_phantom_refs`, `repeated_failures`, `repeated_crashes`, `stuck_in_blocked`, `block_unblock_cycling`, `stranded_in_ready`
  - Diagnostic actions: `reclaim`, `reassign`, `unblock`, `cli_hint`, `open_docs`, `comment`

- [ ] **KDI-021: GC**
  - `kdi gc --event-retention-days 30 --log-retention-days 30`
  - Clean archived workspaces, old events, old logs

### Phase 6 — Advanced Features
- [ ] **KDI-022: Task attachments**
  - `task_attachments` table + on-disk storage
  - `kdi attach <task_id> <file>`

- [ ] **KDI-023: Context builder**
  - `kdi context <task_id>` — print full worker context
  - Title + body + prior attempts + parent results + role history + comments
  - Bounded caps on all fields to prevent prompt overflow
  - Surfaces attachment absolute paths for file-tool access

- [ ] **KDI-024: Assignees listing**
  - `kdi assignees` — list known profiles + per-profile task counts
  - Union of `~/.config/kdi/profiles/` and current board assignees

- [ ] **KDI-025: Notification subscriptions**
  - `kdi notify-subscribe <task_id> --platform telegram --chat-id ...`
  - `kdi notify-subscribe --notifier-profile <profile>` — gateway that delivers
  - `kdi notify-list [<task_id>]` — global or per-task listing
  - `kdi notify-unsubscribe <task_id> --platform ... --chat-id ... --thread-id ...`

### Phase 7 — CLI Polish & Filtering
- [ ] **KDI-030: `kdi list` filters and sort**
  - `--mine` — filter by current profile assignee
  - `--session <session_id>` — filter by originating session
  - `--archived` — include archived tasks
  - `--sort` — `assignee`, `created`, `created-desc`, `priority`, `priority-desc`, `status`, `title`, `updated`
  - `--workflow-template-id` / `--step-key` — v2 workflow filtering

- [ ] **KDI-031: `kdi show` run filtering**
  - `--state-type {status,outcome} --state-name VALUE` — filter displayed runs

- [ ] **KDI-032: Bulk operations flags**
  - `kdi block --ids <id1> <id2>` — bulk block with same reason
  - `kdi schedule --ids <id1> <id2>` — bulk schedule with same reason
  - `kdi promote --ids <id1> <id2>` — bulk promote with same reason
  - `kdi promote --force` — skip parent dependency check
  - `kdi promote --dry-run` — validate without mutating
  - `kdi archive --rm <id1> <id2>` — permanently delete archived tasks

- [ ] **KDI-033: `kdi comment` enhancements**
  - `--author <name>` — author name (default `$KDI_PROFILE` or `user`)
  - `--max-len N` — trim stored comment to N characters

- [ ] **KDI-034: `kdi dispatch` controls**
  - `--max N` — cap spawns this pass
  - `--failure-limit N` — per-pass auto-block threshold

- [ ] **KDI-035: `kdi watch` filters**
  - `--assignee <profile>` — only events for tasks assigned to profile
  - `--tenant <name>` — only events from tasks in tenant
  - `--kinds <kind1>,<kind2>` — comma-separated event kind filter
  - `--interval <seconds>` — poll interval (default 0.5)

- [ ] **KDI-036: `kdi runs` filtering**
  - `--state-type {status,outcome} --state-name VALUE` — filter runs by column

- [ ] **KDI-037: Dispatcher presence warning**
  - `kdi create` warns if no dispatcher/gateway detected for the board
  - Defensive probe of dispatcher PID / config flag

### Phase 8 — v2 / Future
- [ ] **KDI-038: Goal mode**
  - `kdi create --goal --goal-max-turns 20`
  - Ralph-style goal loop (requires judge integration)

- [ ] **KDI-039: Workflow templates**
  - `workflow_template_id` + `current_step_key` on tasks
  - Step-key driven routing

- [ ] **KDI-040: Triage automation (LLM-powered)**
  - `kdi specify <task_id>` — LLM fleshes out triage → todo
  - `kdi decompose <task_id>` — LLM fans out into child graph

- [ ] **KDI-041: Swarm mode**
  - `kdi swarm --worker backend:auth --worker frontend:login --verifier qa --synthesizer pm`
  - Parallel workers → verifier → synthesizer graph

---

## Hermes → KDI Feature Mapping (Updated)

| Hermes Feature | KDI Equivalent | Status | Backlog Item |
|---|---|---|---|
| `hermes kanban boards create` | `kdi boards create` | **Done** (basic) | KDI-012, KDI-013, KDI-014, KDI-015 |
| `hermes kanban boards list` | `kdi boards list` | **Done** (basic) | KDI-012 |
| `hermes kanban boards show` | `kdi boards show` | **Done** (basic) | KDI-013 |
| `hermes kanban boards switch` | `kdi boards switch` | Missing | KDI-013 |
| `hermes kanban boards rename` | `kdi boards rename` | Missing | KDI-014 |
| `hermes kanban boards set-default-workdir` | `kdi boards set-default-workdir` | Missing | KDI-015 |
| `hermes kanban create` | `kdi create` | Partial | KDI-004, KDI-006, KDI-007, KDI-008, KDI-009, KDI-010, KDI-011 |
| `hermes kanban list` | `kdi list` | Partial | KDI-006 |
| `hermes kanban show` | `kdi show` | Exists | KDI-000b (events) |
| `hermes kanban assign` | `kdi assign` | Missing | KDI-017 |
| `hermes kanban reclaim` | `kdi reclaim` | **Done** | KDI-000c |
| `hermes kanban reassign` | `kdi reassign` | Missing | KDI-017 |
| `hermes kanban link` | `kdi link` | Planned | — |
| `hermes kanban unlink` | `kdi unlink` | Planned | — |
| `hermes kanban claim` | `kdi claim` | **Done** | KDI-000c |
| `hermes kanban comment` | `kdi comment` | Exists | — |
| `hermes kanban complete` | `kdi complete` | Missing | KDI-005 |
| `hermes kanban edit` | `kdi edit` | Partial | KDI-005 |
| `hermes kanban block` | `kdi block` | Exists | — |
| `hermes kanban schedule` | `kdi schedule` | Missing | KDI-002 |
| `hermes kanban unblock` | `kdi unblock` | Exists | — |
| `hermes kanban promote` | `kdi promote` | Exists | — |
| `hermes kanban archive` | `kdi archive` | Exists | — |
| `hermes kanban tail` | `kdi tail` | Exists | KDI-000b |
| `hermes kanban dispatch` | `kdi dispatch` | **Done** | KDI-000c, KDI-016 |
| `hermes kanban watch` | `kdi watch` | Exists | KDI-000b |
| `hermes kanban stats` | `kdi stats` | Missing | KDI-019 |
| `hermes kanban log` | `kdi log` | Missing | KDI-018 |
| `hermes kanban runs` | `kdi runs` | Exists | KDI-000 |
| `hermes kanban heartbeat` | `kdi heartbeat` | **Done** | KDI-000c |
| `hermes kanban assignees` | `kdi assignees` | Missing | KDI-024 |
| `hermes kanban context` | `kdi context` | Missing | KDI-023 |
| `hermes kanban specify` | `kdi specify` | **Done** | KDI-001 (basic) |
| `hermes kanban decompose` | `kdi decompose` | Missing | KDI-028 |
| `hermes kanban gc` | `kdi gc` | Missing | KDI-021 |
| `hermes kanban diagnostics` | `kdi diagnostics` | Missing | KDI-020 |
| `hermes kanban notify-subscribe` | `kdi notify-subscribe` | Missing | KDI-025 |
| `hermes kanban notify-unsubscribe` | `kdi notify-unsubscribe` | Missing | KDI-025 |
| `hermes kanban init` | `kdi init` | Missing | KDI-013b |
| `--board` flag + env resolution | `--board` + `KDI_BOARD` | Missing | KDI-013 |
| `boards list --all` | `kdi boards list --all` | **Done** | KDI-012b |
| `boards rm --delete` | `kdi boards rm --delete` | Missing | KDI-012c |
| `boards create --switch` | `kdi boards create --switch` | Missing | KDI-012 |
| `create --idempotency-key` | `kdi create --idempotency-key` | **Done** | KDI-001c |
| `create --initial-status` | `kdi create --initial-status` | **Done** | KDI-001b |
| `list --mine` | `kdi list --mine` | Missing | KDI-030 |
| `list --session` | `kdi list --session` | Missing | KDI-030 |
| `list --archived` | `kdi list --archived` | Missing | KDI-030 |
| `list --sort` | `kdi list --sort` | Missing | KDI-030 |
| `list --workflow-template-id` | `kdi list --workflow-template-id` | Missing | KDI-030 |
| `list --step-key` | `kdi list --step-key` | Missing | KDI-030 |
| `show --state-type/--state-name` | `kdi show --state-type/--state-name` | Missing | KDI-031 |
| `block --ids` | `kdi block --ids` | Missing | KDI-032 |
| `schedule --ids` | `kdi schedule --ids` | Missing | KDI-032 |
| `unblock --reason` | `kdi unblock --reason` | Missing | KDI-032 |
| `promote --ids/--force/--dry-run` | `kdi promote --ids/--force/--dry-run` | Missing | KDI-032 |
| `archive --rm` | `kdi archive --rm` | Missing | KDI-032 |
| `claim --ttl` | `kdi claim --ttl` | **Done** | KDI-000c |
| `comment --author/--max-len` | `kdi comment --author/--max-len` | Missing | KDI-033 |
| `complete` multiple IDs | `kdi complete` multiple IDs | Missing | KDI-005 |
| `dispatch --max/--failure-limit` | `kdi dispatch --max/--failure-limit` | Missing | KDI-034 |
| `watch --assignee/--tenant/--kinds` | `kdi watch --assignee/--tenant/--kinds` | Missing | KDI-035 |
| `heartbeat --note` | `kdi heartbeat --note` | **Done** | KDI-000c |
| `log --tail` | `kdi log --tail` | Missing | KDI-018 |
| `runs --state-type/--state-name` | `kdi runs --state-type/--state-name` | Missing | KDI-036 |
| `notify-subscribe --notifier-profile` | `kdi notify-subscribe --notifier-profile` | Missing | KDI-025 |
| `notify-list` without task_id | `kdi notify-list` without task_id | Missing | KDI-025 |
| `notify-unsubscribe --thread-id` | `kdi notify-unsubscribe --thread-id` | Missing | KDI-025 |
| `assign` → `none` | `kdi assign none` | Missing | KDI-017 |
| `reclaim --reason` | `kdi reclaim --reason` | Missing | KDI-017 |
| `reassign --reason` | `kdi reassign --reason` | Missing | KDI-017 |
| Rate-limit EX_TEMPFAIL=75 | Missing | Missing | KDI-016c |
| Crash grace 30s | Missing | Missing | KDI-016b |
| Dispatcher presence warning | Missing | Missing | KDI-037 |
| `task_runs.status` column | Exists | Exists | KDI-000e |
| Diagnostic rule engine | Missing | Missing | KDI-020 |
| `hermes kanban swarm` | `kdi swarm` | Missing | KDI-041 |
| Task runs table | **Done** | **Done** | KDI-000 |
| Task events table | **Done** | **Done** | KDI-000b |
| Task attachments | Missing | Missing | KDI-022 |
| CAS claim + TTL | **Done** | **Done** | KDI-000c |
| Stale claim reclamation | **Done** | **Done** | KDI-000c |
| Worker log capture | Missing | Missing | KDI-018 |

---

## Priority Recommendations

### P0 — Foundation (blocks everything else)
1. ~~KDI-000~~: Task runs table
2. ~~KDI-000b~~: Task events table
3. ~~KDI-000c~~: CAS claim system (claim_lock + TTL + reclaim)
4. **KDI-000d**: Cross-process init lock
5. ~~KDI-000e~~: `task_runs.status` column
6. ~~Board Management~~: `create`, `list`, `show`, `archive` (basic)
7. ~~Harness Profiles~~: Registry, built-ins, templates, validation
8. ~~Dispatcher~~: Tick function, CAS claim, profile resolution, worktree spawn, log capture
9. ~~Worktree Isolation~~: Auto branch `wt/<profile>/<task_id>`, configurable base ref, cleanup

### P1 — Core Lifecycle Gaps (high operational value)
6. ~~KDI-001~~: Triage status + specify command
7. **KDI-001b**: `create --initial-status`
8. **KDI-002**: Scheduled status
9. **KDI-004**: Integer priority
10. **KDI-005**: Complete with metadata + bulk complete
11. **KDI-016**: Heartbeat + stale detection
12. **KDI-016b**: Crash grace period
13. **KDI-016c**: Rate-limit exit code handling
14. **KDI-017**: Assign / reassign (including `none` unassign + reasons)
15. **KDI-018**: Worker log capture

### P2 — Board Management
16. **KDI-012**: Board metadata (name, icon, color)
17. ~~KDI-012b~~: `boards list --all`
18. **KDI-012c**: `boards rm --delete`
19. **KDI-013**: Board switch / current + resolution chain
20. **KDI-013b**: `kdi init` command
21. **KDI-014**: Rename board
22. **KDI-015**: Default workdir

### P3 — Observability
23. **KDI-019**: Stats
24. **KDI-020**: Diagnostics (8 rules + actions)
25. **KDI-021**: GC
26. ~~KDI-000b~~: Event streaming (tail/watch)

### P4 — Rich Metadata
27. **KDI-001c**: Idempotency key
28. **KDI-006**: Tenant
29. **KDI-007**: Created-by
30. **KDI-008**: Max runtime
31. **KDI-009**: Skills
32. **KDI-010**: Model override
33. **KDI-011**: Max retries / circuit breaker

### P5 — Advanced
34. **KDI-022**: Attachments
35. **KDI-023**: Context builder (bounded caps, prior attempts, role history)
36. **KDI-024**: Assignees listing
37. **KDI-025**: Notification subscriptions
38. **KDI-003**: Review status

### P6 — CLI Polish & Filtering
39. **KDI-030**: `list` filters and sort (`--mine`, `--session`, `--archived`, `--sort`)
40. **KDI-031**: `show` run filtering
41. **KDI-032**: Bulk operations (`--ids`, `--force`, `--dry-run`, `--rm`)
42. **KDI-033**: `comment` enhancements (`--author`, `--max-len`)
43. **KDI-034**: `dispatch` controls (`--max`, `--failure-limit`)
44. **KDI-035**: `watch` filters (`--assignee`, `--tenant`, `--kinds`)
45. **KDI-036**: `runs` filtering
46. **KDI-037**: Dispatcher presence warning

### P7 — v2 / Future
47. **KDI-038**: Goal mode
48. **KDI-039**: Workflow templates
49. **KDI-040**: Triage automation (LLM)
50. **KDI-041**: Swarm mode

---

*Investigated: 2026-06-10 (live CLI + source)*
*Source: NousResearch/hermes-agent hermes_cli/kanban.py (2830 lines), hermes_cli/kanban_db.py (7648 lines)*
*Previous GumbyEnder spec superseded by actual source investigation*

---

## Agent Batch — 2026-06-11

Dispatched 4 parallel `pi` agents via cmux. All 135 tests pass. Work committed to working tree (not yet committed to git).

### Completed
- **Board Management** (KDI-012b): `boards create`, `list`, `show`, `archive`; `--all` flag; `base_ref` support
- **Harness Profiles**: `~/.config/kdi/profiles.yaml` registry with built-ins (opencode, claude, codex, pi); template substitution (`{{workdir}}`, `{{branch}}`, `{{task_id}}`, `{{agent}}`); profile validation on load
- **Dispatcher**: Tick function with CAS claim, profile resolution, worktree spawn, stdout/stderr/exit capture, per-task log files, status update (done/failed), max spawns per tick
- **Worktree Isolation**: Auto branch `wt/<profile>/<task_id>`, configurable `base_ref` per board (default `origin/main`, fallback `HEAD`), cleanup on completion

### Known Gaps from Agent Work
- Board metadata (name, icon, color) — not implemented
- Board switch / resolution chain (`--board`, `KDI_BOARD`, `~/.local/share/kdi/current`) — not implemented
- `kdi dispatch` is a tick function, not a long-running daemon
- `kdi log <task_id>` CLI missing (logs written to disk but no read command)
- ~~`task_runs.status` column missing (only `outcome` exists)~~ — implemented in KDI-000e
- ~~Cross-process init lock missing~~ — implemented in KDI-000d

### Spec Conflicts (resolved silently — documented here for audit trail)

1. **`kdi schedule --ids <id1> <id2>` (backlog) vs `<task_ids...>` (implementation)**  
   Backlog specified `--ids` flag syntax. Implementation uses Commander positional `<task_ids...>` argument which is more idiomatic (no flag needed, just `kdi schedule 1 2 3 --at ...`). Behavior is equivalent; the `--ids` flag was dropped as a design decision.

2. **`complete --metadata` part of KDI-005 (backlog) vs gated behind `FF_COMPLETE_METADATA` (implementation)**  
   Backlog treats `--metadata` as unconditionally part of KDI-005. Implementation gates it behind a feature flag (`FF_COMPLETE_METADATA`, default `false`) for staged rollout. The flag only gates the `--metadata` option; `--result` and `--summary` are always available.

3. **`kdi schedule <task_id> --reason ...` (backlog) vs `--at <timestamp>` required (implementation)**  
   Backlog shows schedule as taking a reason without mentioning `--at`. Implementation correctly requires `--at <timestamp>` (a scheduled task needs a future time) and makes `--reason` optional. This is the correct behavior — the spec was incomplete.
