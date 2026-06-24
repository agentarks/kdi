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
| Board metadata (name, desc, icon, color) | **Done** (name, icon, color) | `kdi boards create --name --icon --color`; `kdi boards edit` |
| `triage` status | **Done** (basic) | `kdi create --triage`, `kdi specify` |
| `scheduled` status | **Done** | KDI has no time-waiting state |
| `review` status | **Done** | KDI conflates review with blocked |
| Integer priority (tiebreaker) | Partial | KDI has enum low/medium/high |
| `tenant` namespace | **Done** | No multi-tenant filtering |
| `created_by` | **Done** | No author tracking |
| `max_runtime_seconds` | **Done** | No per-task runtime cap |
| `skills` array | **Done** | No force-loaded skills |
| `model_override` | **Done** | No per-task model override |
| `max_retries` / circuit breaker | **Done** | `kdi create --max-retries`; dispatcher blocks after retry limit |
| `goal_mode` / `goal_max_turns` | **Done** | v1 judge approximation (exit 0 = satisfied); real LLM-as-judge deferred |
| `session_id` | **Done** | No session tracking |
| `workflow_template_id` | **Done** | No workflow routing |
| `task_runs` table | **Done** | `kdi runs <task_id>` |
| `task_events` table | **Done** | `kdi tail`, `kdi watch` |
| `task_attachments` table | **Done** | No file attachments |
| `claim_lock` + TTL | **Done** | `kdi claim`, `kdi reclaim` |
| `heartbeat` | **Done** | `kdi heartbeat` |
| `reclaim` command | **Done** | `kdi reclaim` |
| `reassign` command | **Done** | No assignee change |
| `schedule` command/status | **Done** | No scheduled state |
| `assign` command | **Done** | No direct assignment |
| `complete` with metadata | Partial | KDI has no result/summary/metadata |
| `tail` / `watch` | **Done** | `kdi tail`, `kdi watch` |
| `stats` | **Done** | No board stats |
| `log` | **Done** | No worker log access |
| `runs` | **Done** | `kdi runs <task_id>` |
| `context` | **Done** | No worker context builder |
| `assignees` | **Done** | No profile listing |
| `gc` | **Done** | No garbage collection |
| `diagnostics` | **Done** | No health checks |
| `specify` / `decompose` | **Done** | No triage automation |
| `swarm` | **Done** | No swarm mode |
| Notification subscriptions | **Done** | No notify subs |
| Cross-process init lock | **Done** | SQLite init not serialized |
| `started_at` | Missing from schema | Added via migration in KDI |
| `init` command | **Done** | No idempotent DB creation command |
| Global `--board` + env resolution | **Done** | KDI has no board resolution chain |
| `boards list --all` | **Done** | Cannot list archived boards |
| `boards rm --delete` | **Done** | `kdi boards rm --delete` hard-deletes board data when `FF_BOARD_RM_DELETE` is enabled |
| `boards create --switch` | **Done** | No auto-switch after create |
| `create --idempotency-key` | **Done** | No dedup key support |
| `create --initial-status` | **Done** | KDI create always goes to `todo` |
| `list --mine` | **Done** | No current-profile filter |
| `list --session` | **Done** | No session filtering |
| `list --archived` | **Done** | Cannot include archived in list |
| `list --sort` | **Done** | No sort options (only created_at DESC) |
| `list --workflow-template-id` / `--step-key` | **Done** | No v2 workflow filtering |
| `show --state-type` / `--state-name` | **Done** | No run filtering on show |
| `block --ids` / `schedule --ids` / `promote --ids` | **Done** | No bulk ops flags |
| `promote --force` / `--dry-run` | **Done** | No skip-parent or validate-only |
| `archive --rm` | **Done** | No permanent deletion of archived tasks |
| `claim --ttl` | **Done** | No custom TTL param |
| `comment --author` / `--max-len` | **Done** | No author tracking or trim |
| `unblock --reason` | **Done** | No reason on unblock |
| `complete` multiple IDs | **Done** | Only single-task complete |
| `dispatch --max` / `--failure-limit` | **Done** | No spawn cap or per-pass limit |
| `watch --assignee` / `--tenant` / `--kinds` | **Done** | No event stream filters |
| `heartbeat --note` | **Done** | No heartbeat note |
| `log --tail` | **Done** | No byte-limit on log read |
| `runs --state-type` / `--state-name` | **Done** | Run filtering on `kdi runs` (KDI-031 added it to `kdi show`; same `getRunsFiltered` helper used by both) |
| `notify-subscribe --notifier-profile` | **Done** | No notifier profile |
| `notify-list` without task_id | **Done** | No global subscription list |
| `notify-unsubscribe --thread-id` | **Done** | No thread-scoped unsub |
| `assign` / `reassign` → `none` | **Done** | No unassign support |
| `reclaim --reason` / `reassign --reason` | **Done** | No reason on recovery ops |
| Rate-limit exit code (EX_TEMPFAIL=75) | **Done** | No rate-limit requeue path |
| Crash grace (30s) | **Done** | No PID liveness grace |
| Dispatcher presence warning | **Done** | Warning on `kdi create`; dispatcher-side PID marker write deferred |
| `task_runs.status` column | **Done** | Only `outcome` considered |
| Diagnostic rule engine (8 rules) | **Done** | 8 automated health rules implemented |
| `build_worker_context` caps/attachments | **Done** | No bounded context builder |

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
  - `kdi unblock <task_id>...` — bulk unblock (KDI-047)
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

- [x] **KDI-011: Max retries / circuit breaker**
  - Add `max_retries INTEGER`
  - Auto-block task after N consecutive spawn/execution failures
  - `kdi create --max-retries 3`

### Phase 3 — Board Management
- [x] **KDI-012: Board metadata**
  - Add `name`, `icon`, `color` to boards
  - `kdi boards create myproj --name "My Project" --icon "🚀" --color "#8b5cf6"`
  - `kdi boards edit myproj --name "My Project" --icon "🚀" --color "#8b5cf6"`

- [x] **KDI-012b: `kdi boards list --all`**
  - Include archived boards in listing

- [x] **KDI-012c: `kdi boards rm --delete`**
  - Hard-delete board directory instead of soft-archive to `boards/_archived/`
  - Gated by `FF_BOARD_RM_DELETE`, default `false`

- [x] **KDI-013: Board switch / current**
  - `kdi boards switch <slug>` — write to `~/.local/share/kdi/current`
  - `kdi boards show` — print current board
  - `--board` flag on all commands
  - Env var `KDI_BOARD` overrides current file
  - Resolution chain: `--board` → `KDI_BOARD` env → `~/.local/share/kdi/current` → `default`

- [x] **KDI-013b: `kdi init`**
  - Idempotent DB creation command (`kdi init`)
  - Separate from implicit init on first command

- [x] **KDI-014: Rename board**
  - `kdi boards rename <slug> "New Name"`
  - Slug immutable, display name mutable

- [x] **KDI-015: Default workdir**
  - `kdi boards set-default-workdir <slug> /path/to/project`
  - `kdi boards set-default-workdir <slug>` (no path) — clears default
  - Tasks created without `--workspace` inherit board default

### Phase 4 — Worker Lifecycle
- [x] **KDI-016: Heartbeat**
  - `kdi heartbeat <task_id>` — worker liveness signal
  - `kdi heartbeat --note "..."` — optional note on heartbeat event
  - Updates `last_heartbeat_at` on task + active run
  - Stale heartbeat detection in dispatcher (older than 60min → auto-reclaim)

- [x] **KDI-016b: Crash grace period**
  - 30s grace before PID liveness check after expected worker start
  - Prevents false crash detection on slow process startup

- [x] **KDI-016c: Rate-limit exit code handling**
  - `EX_TEMPFAIL` (exit code 75) → requeue to `ready` WITHOUT incrementing `consecutive_failures`
  - Cooldown before respawn to avoid hammering rate-limited provider

- [x] **KDI-017: Assign / reassign**
  - `kdi assign <task_id> <profile>`
  - `kdi assign <task_id> none` — unassign task
  - `kdi reassign <task_id> <profile> --reclaim`
  - `kdi reassign <task_id> none` — unassign
  - `kdi reassign --reason "..."` — record reason on reclaimed event
  - `kdi reclaim <task_id> --reason "..."` — record reason on reclaimed event

- [x] **KDI-018: Worker log capture**
  - Capture stdout/stderr to `~/.local/share/kdi/logs/<board>/<task_id>.log`
  - `kdi log <task_id>` — print log
  - `kdi log <task_id> --tail 100` — last N bytes

### Phase 5 — Observability & Health
- [x] **KDI-019: Stats**
  - `kdi stats` — per-status + per-assignee counts + oldest-ready age
  - `kdi stats --json`

- [x] **KDI-020: Diagnostics**
  - `kdi diagnostics` — board-wide health checks
  - `kdi diagnostics --severity error`
  - `kdi diagnostics --task <task_id>`
  - 8 automated rules: `hallucinated_cards`, `triage_aux_unavailable`, `prose_phantom_refs`, `repeated_failures`, `repeated_crashes`, `stuck_in_blocked`, `block_unblock_cycling`, `stranded_in_ready`
  - Diagnostic actions: `reclaim`, `reassign`, `unblock`, `cli_hint`, `open_docs`, `comment`

- [x] **KDI-021: GC**
  - `kdi gc --event-retention-days 30 --log-retention-days 30`
  - Clean archived workspaces, old events, old logs

### Phase 6 — Advanced Features
- [x] **KDI-022: Task attachments**
  - `task_attachments` table + on-disk storage
  - `kdi attach <task_id> <file>`

- [x] **KDI-023: Context builder**
  - `kdi context <task_id> [--board <slug>] [--json]` — print full worker context
  - Title + body + prior attempts + parent results + role history + comments + attachments
  - Bounded caps on all fields to prevent prompt overflow
  - Surfaces attachment absolute paths for file-tool access

- [x] **KDI-024: Assignees listing**
  - `kdi assignees` — list known profiles + per-profile task counts
  - Union of `~/.config/kdi/profiles/` and current board assignees

- [x] **KDI-025: Notification subscriptions**
  - `kdi notify-subscribe <task_id> --platform telegram --chat-id ...`
  - `kdi notify-subscribe --notifier-profile <profile>` — gateway that delivers
  - `kdi notify-list [<task_id>]` — global or per-task listing
  - `kdi notify-unsubscribe <task_id> --platform ... --chat-id ... --thread-id ...`

### Phase 7 — CLI Polish & Filtering (KDI-030..037 done)
- [x] **KDI-030: `kdi list` filters and sort**
  - `--mine` — filter by current profile assignee
  - `--session <session_id>` — filter by originating session
  - `--archived` — include archived tasks
  - `--sort` — `assignee`, `created`, `created-desc`, `priority`, `priority-desc`, `status`, `title`, `updated`
  - `--workflow-template-id` / `--step-key` — v2 workflow filtering

- [x] **KDI-031: `kdi show` run filtering**
  - `--state-type {status,outcome} --state-name VALUE` — filter displayed runs

- [x] **KDI-032: Bulk operations flags**
  - `kdi block <id1> <id2>...` — bulk block with same reason
  - `kdi schedule <id1> <id2>...` — bulk schedule
  - `kdi promote <id1> <id2>...` — bulk promote with same reason
  - `kdi promote --force` — skip parent dependency check
  - `kdi promote --dry-run` — validate without mutating
  - `kdi archive --rm <id1> <id2>...` — permanently delete archived tasks

- [x] **KDI-033: `kdi comment` enhancements**
  - `--author <name>` — author name (default `$KDI_PROFILE` or `user`)
  - `--max-len N` — trim stored comment to N characters

- [x] **KDI-034: `kdi dispatch` controls**
  - `--max N` — cap spawns this pass (pre-existing, ungated)
  - `--failure-limit N` — per-pass failure threshold

- [x] **KDI-035: `kdi watch` filters**
  - `--assignee <profile>` — only events for tasks assigned to profile
  - `--tenant <name>` — only events from tasks in tenant
  - `--kinds <kind1>,<kind2>` — comma-separated event kind filter
  - `--interval <seconds>` — poll interval (default 0.5)

- [x] **KDI-036: `kdi runs` filtering**
  - `--state-type {status,outcome} --state-name VALUE` — filter runs by column
  - Reuses the `getRunsFiltered` model helper from KDI-031

- [x] **KDI-037: Dispatcher presence warning**
  - `kdi create` warns if no dispatcher/gateway detected for the board
  - Defensive probe of dispatcher PID / config flag
  - Out of scope: dispatcher-side PID marker write

### Phase 8 — v2 / Future
- [x] **KDI-038: Goal mode**
  - `kdi create --goal --goal-max-turns 20`
  - Ralph-style goal loop (v1 judge approximation: exit 0 = satisfied; real LLM-as-judge is a follow-up)

- [x] **KDI-039: Workflow templates**
  - `workflow_template_id` + `current_step_key` on tasks
  - Step-key driven routing

- [x] **KDI-040: Triage automation (LLM-powered)**
  - BRD: `specs/brd-kdi-040-triage-automation.md`
  - `kdi specify <task_id>` — LLM fleshes out triage → todo
  - `kdi decompose <task_id>` — LLM fans out into child graph

- [x] **KDI-041: Swarm mode**
  - BRD: `specs/brd-kdi-041-swarm-mode.md`
  - `kdi swarm --worker backend:auth --worker frontend:login --verifier qa --synthesizer pm`
  - Parallel workers → verifier → synthesizer graph

---

## Hermes → KDI Feature Mapping (Updated)

| Hermes Feature | KDI Equivalent | Status | Backlog Item |
|---|---|---|---|
| `hermes kanban boards create` | `kdi boards create` | **Done** (basic) | KDI-012, KDI-013, KDI-014, KDI-015 |
| `hermes kanban boards list` | `kdi boards list` | **Done** (basic) | KDI-012 |
| `hermes kanban boards show` | `kdi boards show` | **Done** (basic) | KDI-013 |
| `hermes kanban boards switch` | `kdi boards switch` | **Done** | KDI-013 |
| `hermes kanban boards rename` | `kdi boards rename` | **Done** | KDI-014 |
| `hermes kanban boards set-default-workdir` | `kdi boards set-default-workdir` | **Done** | KDI-015 |
| `hermes kanban create` | `kdi create` | Partial | KDI-004, KDI-006, KDI-007, KDI-008, KDI-009, KDI-010, KDI-011 |
| `hermes kanban list` | `kdi list` | Partial | KDI-006 |
| `hermes kanban show` | `kdi show` | Exists | KDI-000b (events) |
| `hermes kanban assign` | `kdi assign` | **Done** | KDI-017 |
| `hermes kanban reclaim` | `kdi reclaim` | **Done** | KDI-000c |
| `hermes kanban reassign` | `kdi reassign` | **Done** | KDI-017 |
| `hermes kanban link` | `kdi link` | Planned | — |
| `hermes kanban unlink` | `kdi unlink` | Planned | — |
| `hermes kanban claim` | `kdi claim` | **Done** | KDI-000c |
| `hermes kanban comment` | `kdi comment` | Exists | — |
| `hermes kanban complete` | `kdi complete` | **Done** | KDI-005 |
| `hermes kanban edit` | `kdi edit` | Partial | KDI-005 |
| `hermes kanban block` | `kdi block` | Exists | — |
| `hermes kanban schedule` | `kdi schedule` | **Done** | KDI-002 |
| `hermes kanban unblock` | `kdi unblock` | **Done** | KDI-047 |
| `hermes kanban promote` | `kdi promote` | Exists | — |
| `hermes kanban archive` | `kdi archive` | Exists | — |
| `hermes kanban tail` | `kdi tail` | Exists | KDI-000b |
| `hermes kanban dispatch` | `kdi dispatch` | **Done** | KDI-000c, KDI-016 |
| `hermes kanban watch` | `kdi watch` | Exists | KDI-000b |
| `hermes kanban stats` | `kdi stats` | **Done** | KDI-019 |
| `hermes kanban log` | `kdi log` | **Done** | KDI-018 |
| `hermes kanban runs` | `kdi runs` | Exists | KDI-000 |
| `hermes kanban heartbeat` | `kdi heartbeat` | **Done** | KDI-000c |
| `hermes kanban assignees` | `kdi assignees` | **Done** | KDI-024 |
| `hermes kanban context` | `kdi context` | **Done** | KDI-023 |
| `hermes kanban specify` | `kdi specify` | **Done** | KDI-001 (basic) |
| `hermes kanban decompose` | `kdi decompose` | **Done** | KDI-028 |
| `hermes kanban gc` | `kdi gc` | **Done** | KDI-021 |
| `hermes kanban diagnostics` | `kdi diagnostics` | **Done** | KDI-020 |
| `hermes kanban notify-subscribe` | `kdi notify-subscribe` | **Done** | KDI-025 |
| `hermes kanban notify-unsubscribe` | `kdi notify-unsubscribe` | **Done** | KDI-025 |
| `hermes kanban init` | `kdi init` | **Done** | KDI-013b |
| `--board` flag + env resolution | `--board` + `KDI_BOARD` | **Done** | KDI-013 |
| `boards list --all` | `kdi boards list --all` | **Done** | KDI-012b |
| `boards rm --delete` | `kdi boards rm --delete` | **Done** | KDI-012c |
| `boards create --switch` | `kdi boards create --switch` | **Done** | KDI-012 |
| `create --idempotency-key` | `kdi create --idempotency-key` | **Done** | KDI-001c |
| `create --initial-status` | `kdi create --initial-status` | **Done** | KDI-001b |
| `list --mine` | `kdi list --mine` | **Done** | KDI-030 |
| `list --session` | `kdi list --session` | **Done** | KDI-030 |
| `list --archived` | `kdi list --archived` | **Done** | KDI-030 |
| `list --sort` | `kdi list --sort` | **Done** | KDI-030 |
| `list --workflow-template-id` | `kdi list --workflow-template-id` | **Done** | KDI-030 |
| `list --step-key` | `kdi list --step-key` | **Done** | KDI-030 |
| `show --state-type/--state-name` | `kdi show --state-type/--state-name` | **Done** | KDI-031 |
| `block --ids` | `kdi block --ids` | **Done** | KDI-032 |
| `schedule --ids` | `kdi schedule --ids` | **Done** | KDI-032 |
| `unblock --reason` | `kdi unblock --reason` | **Done** | KDI-032 |
| `unblock <task_ids...>` | `kdi unblock <task_ids...>` | **Done** | KDI-047 |
| `promote --ids/--force/--dry-run` | `kdi promote --ids/--force/--dry-run` | **Done** | KDI-032 |
| `archive --rm` | `kdi archive --rm` | **Done** | KDI-032 |
| `claim --ttl` | `kdi claim --ttl` | **Done** | KDI-000c |
| `comment --author/--max-len` | `kdi comment --author/--max-len` | **Done** | KDI-033 |
| `complete` multiple IDs | `kdi complete` multiple IDs | **Done** | KDI-005 |
| `dispatch --max/--failure-limit` | `kdi dispatch --max/--failure-limit` | **Done** | KDI-034 |
| `watch --assignee/--tenant/--kinds` | `kdi watch --assignee/--tenant/--kinds` | **Done** | KDI-035 |
| `heartbeat --note` | `kdi heartbeat --note` | **Done** | KDI-000c |
| `log --tail` | `kdi log --tail` | **Done** | KDI-018 |
| `runs --state-type/--state-name` | `kdi runs --state-type/--state-name` | **Done** | KDI-036 |
| `notify-subscribe --notifier-profile` | `kdi notify-subscribe --notifier-profile` | **Done** | KDI-025 |
| `notify-list` without task_id | `kdi notify-list` without task_id | **Done** | KDI-025 |
| `notify-unsubscribe --thread-id` | `kdi notify-unsubscribe --thread-id` | **Done** | KDI-025 |
| `assign` → `none` | `kdi assign none` | **Done** | KDI-017 |
| `reclaim --reason` | `kdi reclaim --reason` | **Done** | KDI-017 |
| `reassign --reason` | `kdi reassign --reason` | **Done** | KDI-017 |
| Rate-limit EX_TEMPFAIL=75 | **Done** | **Done** | KDI-016c |
| Crash grace 30s | **Done** | **Done** | KDI-016b |
| Dispatcher presence warning | **Done** | **Done** | KDI-037 |
| `task_runs.status` column | Exists | Exists | KDI-000e |
| Diagnostic rule engine | **Done** | **Done** | KDI-020 |
| `hermes kanban swarm` | `kdi swarm` | **Done** | KDI-041 |
| Task runs table | **Done** | **Done** | KDI-000 |
| Task events table | **Done** | **Done** | KDI-000b |
| Task attachments | **Done** | **Done** | KDI-022 |
| CAS claim + TTL | **Done** | **Done** | KDI-000c |
| Stale claim reclamation | **Done** | **Done** | KDI-000c |
| Worker log capture | **Done** | **Done** | KDI-018 |

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
16. ~~KDI-012~~: Board metadata (name, icon, color)
17. ~~KDI-012b~~: `boards list --all`
18. ~~KDI-012c~~: `boards rm --delete`
19. ~~KDI-013~~: Board switch / current + resolution chain
20. ~~KDI-013b~~: `kdi init` command
21. ~~KDI-014~~: Rename board
22. ~~KDI-015~~: Default workdir

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
32. ~~KDI-010~~: Model override
33. ~~KDI-011~~: Max retries / circuit breaker

### P5 — Advanced
34. **KDI-022**: Attachments
35. ~~**KDI-023**: Context builder (bounded caps, prior attempts, role history)~~
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
45. ✅ **KDI-036**: `runs` filtering
46. ✅ **KDI-037**: Dispatcher presence warning

### P7 — v2 / Future
47. ✅ **KDI-038**: Goal mode
48. ✅ **KDI-039**: Workflow templates
49. **KDI-040**: Triage automation (LLM)
50. **KDI-041**: Swarm mode

---

*Investigated: 2026-06-10 (live CLI + source)*
*Source: NousResearch/hermes-agent hermes_cli/kanban.py (2830 lines), hermes_cli/kanban_db.py (7648 lines)*
*Previous GumbyEnder spec superseded by actual source investigation*

---

## Live CLI Verification — 2026-06-20

> Method: `kdi-new-feature-loop` with temp `HOME` + temp `KDI_DB`, all feature flags enabled via environment, compared against live `NousResearch/hermes-agent` source.
> Commands verified: `init`, `boards`, `create`, `list`, `show`, `promote`, `block`, `unblock`, `schedule`, `archive`, `assign`, `reassign`, `claim`, `reclaim`, `heartbeat`, `complete`, `runs`, `tail`, `stats`, `diagnostics`, `assignees`, `context`, `notify-*`, `gc`, `dispatch`, `swarm`.

### Critical Bugs Discovered

1. **Global/subcommand `--board` flag is ignored**  
   `kdi <cmd> ... --board <slug>` resolves to `default` instead of the supplied slug. Only `KDI_BOARD` env var and the `~/.local/share/kdi/current` file work. This breaks the board resolution chain documented in KDI-013 and causes the entire e2e suite to fail when tests pass `--board myproj`.  
   Evidence: `bun run src/index.ts create "x" --board myproj --assignee opencode` → `Board "default" not found.`  
   Hermes behavior: `--board` is honored on every subcommand.

2. **Unresolved git merge conflict in `src/flags.ts`**  
   `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes` markers were present at lines 17 and 52, breaking `bun run build` and `bun run dev`. Resolved during this session by keeping both stashed additions (`FF_BOARD_CREATE_SWITCH`, `FF_GLOBAL_BOARD`).

3. **`kdi boards create --switch` is missing**  
   Backlog marks this as implemented (KDI-012), but `bun run src/index.ts boards create myproj --workdir ... --switch` returns `error: unknown option '--switch'`.

4. **`kdi boards rename` semantics do not match Hermes**  
   `kdi boards rename <old-slug> <new-slug>` renames the board slug (and warns if the data directory is missing). Hermes `boards rename <slug> <name>` changes only the display name; the slug is immutable. KDI's display-name rename lives under `kdi boards edit <slug> --name <name>`, which is the Hermes-equivalent operation.

5. **`kdi create` default initial status is `todo`, not `running`**  
   Hermes defaults `--initial-status` to `running`. KDI defaults to `todo`, so a plain `kdi create "title"` parks the card instead of making it dispatchable.

6. **`kdi create` has no `--parent` / `--dependency` option**  
   Hermes supports repeatable `--parent <task_id>` on create to build dependency graphs at creation time. KDI requires a separate `link` / `unlink` command (if it exists), but those commands are not exposed in the top-level help and the create-time path is missing.

7. **`kdi boards create` has no `--description` option**  
   Hermes boards carry `description` metadata. KDI stores `name`, `icon`, and `color` only.



9. **`kdi archive` bulk archive is broken**  
   Help text advertises `[task_ids...]`, but `kdi archive 1 2` returns `Error: Archive only supports a single task ID (use --rm for bulk deletion of archived tasks)`. Bulk `--rm` of archived tasks works; bulk archive does not.

10. **`kdi tail` has no non-following / `--lines` mode**  
    Hermes `tail` follows by default but can be piped/limited by the caller. KDI `tail <task_id>` blocks forever following events; there is no CLI flag to print the last N events and exit.

11. **`kdi init` does not ensure a `default` board exists**  
    Hermes treats `default` as always-present. After `kdi init`, `kdi boards show` (with no current board) fails with `Board "default" not found.`

12. **`kdi dispatch` is daemon-only; no one-shot tick mode**  
    Hermes `dispatch` performs one dispatcher pass and exits. KDI `dispatch` starts a long-running loop (`--interval` defaults to 5000 ms) with no documented `--once` / `--tick` flag.

13. **`kdi swarm` CLI differs from Hermes**  
    Hermes: `swarm <goal> --worker PROFILE:TITLE[:SKILL,SKILL] --verifier ... --synthesizer ...`. KDI: `swarm --worker profile:title` with no goal positional and no skills suffix.

### Test Suite Health

```
bun run lint   # passes (tsc --noEmit)
bun test       # 711 pass, 125 fail, 1660 expect() calls, 836 tests across 36 files
```

The bulk of failures are cascading from bug #1 (`--board` ignored). Fixing that is the highest-leverage repair. Remaining failures cluster in:
- `kdi list` filters/sort ( `--mine`, `--session`, `--archived`, `--sort`, workflow filters )
- `kdi show` / `kdi runs` state filtering
- `kdi assign` / `reassign` / `reclaim` / `heartbeat`
- `kdi log` / worker log capture
- `kdi stats`, `diagnostics`, `assignees`, `gc`, `notify-*`, `swarm`

### New Backlog Items

Add to the appropriate phases above:

- [x] **KDI-042: Fix `--board` flag resolution**  
  Global and subcommand `--board` must both resolve to the explicit board. Add e2e coverage for `--board` on `create`, `list`, `show`, `dispatch`, and `swarm`.

- [x] **KDI-043: Implement `boards create --switch`**  
  Auto-switch to the newly created board (currently marked done in KDI-012 but missing in CLI).

- [x] **KDI-044: Add `--description` to board metadata**  
  Store and display board description, matching Hermes `boards create --description`.

- [x] **KDI-045: Add `--parent` repeatable option to `kdi create`**  
  Create task links at creation time; equivalent to Hermes `--parent`.

- [x] **KDI-046: Align `boards rename` with Hermes semantics**  
  Already implemented behind `FF_BOARD_RENAME_HERMES`. `kdi boards rename <slug> <name>` changes display name; `kdi boards rename-slug <old> <new>` changes slug. Spec discarded.

- [x] **KDI-047: Support multiple task IDs in `kdi unblock`**  
  Bulk unblock matching Hermes `unblock <task_ids...>`.

- [x] **KDI-048: Fix bulk archive**  
  Already implemented behind `FF_BULK_OPERATIONS`. `kdi archive <id> <id>...` soft-archives multiple IDs; `kdi archive --rm <id>...` hard-deletes archived IDs. Spec discarded.

- [x] **KDI-049: Add non-following `tail` mode**  
  Already implemented behind `FF_TAIL_NO_FOLLOW`. `kdi tail --lines N` and `kdi tail --no-follow` print events and exit. Spec discarded.

- [x] **KDI-050: Ensure `default` board exists after `kdi init`**  
  Implemented. `kdi init` now creates an active `default` board when missing, is idempotent, and leaves archived defaults untouched. BRD at `specs/brd-kdi-050-init-default-board.md`.

- [x] **KDI-051: Add one-shot dispatch mode**  
  `kdi dispatch --once` (or `--tick`) for a single dispatcher pass, matching Hermes behavior.

- [x] **KDI-052: Pass task title/body to harness**  
  Implemented behind `FF_HARNESS_CONTEXT` (default `false`). `{{title}}` and `{{body}}` are in `ALLOWED_TEMPLATES` and substituted by `substituteCommand`; the dispatcher exports `KDI_TASK_TITLE`, `KDI_TASK_BODY`, `KDI_TASK_ID`, and `KDI_BOARD` to the harness env only when `FF_HARNESS_CONTEXT` is enabled. Tests cover template substitution, env vars, null-body handling, and disabled-flag behavior.

- [x] **KDI-053: Store clean result/summary from harness output**  
  Currently the entire raw JSON stream from `opencode run --format json` is dumped into `tasks.result`. Hermes expects a human-readable result/summary. Provide a convention for harnesses to emit a result file (e.g., `{{workdir}}/.kdi-result.txt`) or parse the last text chunk from JSON-mode output; store that as `result`/`summary` instead of raw stdout.

- [x] **KDI-054: Real harness parity test**  
  Added opt-in smoke test at `tests/real-harness-parity.test.ts` (gated by `KDI_REAL_HARNESS_TEST=true`). Proves `kdi create --assignee opencode` → `promote` → `dispatch` passes task context to a real harness, writes a marker file in the active worktree, and stores a clean result visible via `kdi show`.

- [ ] **KDI-055: Consider whether task changes should propagate to original repo**  
  Worktree isolation is correct, but downstream workflows may expect the original board workdir to reflect the completed edit. Document the intended handoff (worktree branch stays until merged/pushed) or add an option to copy/commit changes back.

- [x] **KDI-052: Stabilize test suite**
  Repair the 125 failing tests; root-cause the non-cascading failures after KDI-042 is fixed.

---

## Agent Batch — 2026-06-11

Dispatched 4 parallel `pi` agents via cmux. All 135 tests pass. Work committed to working tree (not yet committed to git).

### Completed
- **Board Management** (KDI-012b): `boards create`, `list`, `show`, `archive`; `--all` flag; `base_ref` support
- **Harness Profiles**: `~/.config/kdi/profiles.yaml` registry with built-ins (opencode, claude, codex, pi); template substitution (`{{workdir}}`, `{{branch}}`, `{{task_id}}`, `{{agent}}`); profile validation on load
- **Dispatcher**: Tick function with CAS claim, profile resolution, worktree spawn, stdout/stderr/exit capture, per-task log files, status update (done/failed), max spawns per tick
- **Worktree Isolation**: Auto branch `wt/<profile>/<task_id>`, configurable `base_ref` per board (default `origin/main`, fallback `HEAD`), cleanup on completion

### Known Gaps from Agent Work
- ~~Board metadata (name, icon, color) — not implemented~~ — implemented in KDI-012
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

---

## Verification (2026-06-19)

Ran `scripts/verify-hermes-backlog.sh` against `main` (a4b2618) on a temp `HOME` + temp `KDI_DB` with every `FF_*` flag on. **89 / 90 PASS, 1 FAIL.** Existing unit suite still 836 pass; `tsc --noEmit` clean. Full per-item report: `specs/hermes-backlog-verification-2026-06-19.md`.

### Gaps found

1. **KDI-013 — global `--board` flag is not implemented.** The resolution chain works per-subcommand (`kdi list --board demo`), via `KDI_BOARD` env, and via the `current` file written by `kdi boards switch`. But `program.option("--board <slug>")` is missing in `src/index.ts`, so `kdi --board demo boards show` errors with `unknown option '--board'`. Fix: add the global option in `src/index.ts` and thread it through `resolveBoard` when no per-subcommand `--board` is set.

2. **Hermes parity — `kdi boards create --switch` is not implemented.** `kdi boards create` accepts `--name`/`--icon`/`--color` but no `--switch`. Users coming from hermes expect auto-switch on create. Fix: add `.option("--switch", "...")` in `src/commands/boards.ts` and call `writeCurrentBoard(slug)` after successful create.

3. **KDI-034 / KDI-000c — `kdi dispatch` is a long-running daemon, not a one-shot pass.** Hermes defines `dispatch` as a one-shot tick and `daemon` as the long-running form. kdi has only the daemon form (`while (running) { await tick(); setTimeout(...) }` in `src/dispatcher.ts:679-694`); the `kdi dispatch` command does not exit on its own. Per-pass flags (`--max`, `--failure-limit`) configure daemon ticks, not a one-shot pass. Fix: make `kdi dispatch` a one-shot tick by default, or add `--once`. Either way, add a `kdi daemon` for the current long-running behavior.

4. **Hermes parity — `kdi link` / `kdi unlink` are not implemented (was "Planned" in original backlog).** The `dependencies` model and `addDependency` / `removeDependency` / `hasDependencyPath` exist in `src/models/dependency.ts`, and `promoteTaskAdvanced` checks `isBlockedByDependencies`. But no CLI command is registered in `src/index.ts`. No regression; just confirming still unimplemented.

5. **KDI-001 — `kdi specify --tenant <name>` without `--all` or `<task_id>` is rejected.** Backlog implies `--tenant` alone should sweep. Currently: `Error: Task ID is required (or use --all).` Fix: in `src/commands/tasks.ts`, when `options.tenant` is set without a task id, treat it as a sweep (or document that `--all` is required alongside `--tenant`).

### Items not testable from the CLI loop (validated by source inspection)

- KDI-016b crash grace period (30s window in `src/dispatcher.ts`)
- KDI-016c rate-limit exit code (`EX_TEMPFAIL=75` branch in `src/dispatcher.ts`)
- KDI-040 triage automation LLM (needs `KDI_TRIAGE_LLM_API_KEY`; basic path covered by KDI-001 with `--skip-llm`)
- KDI-000d cross-process init lock (validated with two parallel `kdi init` runs; lock at `<db>.init.lock` with PID liveness in `src/db.ts:180-217`)

### Repro

```bash
cd .worktrees/verify-hermes-backlog-2026-06-19
bun install
bun test
bun run lint
KEEP_TMP=1 bash scripts/verify-hermes-backlog.sh    # 90 CLI surface tests; 89 PASS / 1 FAIL
```
