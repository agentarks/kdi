# kdi — Status

## Hermes Kanban Parity — KDI-046 (Done)
- [x] BRD drafted at `specs/brd-kdi-046-boards-rename-semantics.md`
- [x] Feature flag `ff_board_rename_hermes` / `FF_BOARD_RENAME_HERMES` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `kdi boards rename <slug> <name>` implemented: updates `boards.name` only; slug, data directory, and current-board file untouched
- [x] `kdi boards rename-slug <old-slug> <new-slug>` implemented: preserves existing slug-rename behavior
- [x] Model function `renameBoard` renamed to `renameBoardSlug`
- [x] Unit/e2e tests and user-loop smoke pass
- [x] `bun run lint`, `bun test` (863 pass), `bun run build` pass

## KDI-047..049 Consolidated — Done
- [x] KDI-047: Bulk `kdi unblock <id>...` implemented with per-task reporting and tests
- [x] KDI-048: Bulk `kdi archive <id>...` implemented behind `FF_BULK_OPERATIONS` with tests
- [x] KDI-049: Non-following `kdi tail --lines N` / `--no-follow` implemented behind `FF_TAIL_NO_FOLLOW` with tests
- [x] `bun run lint`, `bun run test` (873 pass), and `bun run build` pass on consolidated branch
- [x] Verified KDI-046, KDI-048, KDI-049 are already implemented in `main` behind their respective flags; discarded redundant specs.

## KDI-050: Ensure `default` Board Exists After `kdi init` — Done
- [x] BRD drafted at `specs/brd-kdi-050-init-default-board.md`
- [x] Reviewed BRD against `src/commands/init.ts`, `src/models/board.ts`, `src/db.ts`, and `src/resolveBoard.ts`
- [x] `kdi init` creates active `default` board when missing
- [x] Idempotency: repeated `kdi init` does not error or duplicate
- [x] Default board workdir set to `<kdi_data_dir>/boards/default`
- [x] `kdi boards show` and `kdi create` work immediately after `kdi init`
- [x] Unit/e2e tests and user-loop smoke pass
- [x] `bun run lint`, `bun run test` (910 pass), `bun run build` pass

## KDI-052: Pass Task Title/Body to Harness — Done
- [x] Feature flag `ff_harness_context` / `FF_HARNESS_CONTEXT` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] Added `title` and `body` to `ALLOWED_TEMPLATES` in `src/profiles.ts`
- [x] Updated `substituteCommand` in `src/profiles.ts` to accept and substitute `{{title}}` and `{{body}}`
- [x] Updated `src/dispatcher.ts` `tick` to pass `title` and `body` into `substituteCommand` only when `FF_HARNESS_CONTEXT` is enabled
- [x] Updated `src/dispatcher.ts` `harnessEnv` to set `KDI_TASK_TITLE`, `KDI_TASK_BODY`, `KDI_TASK_ID`, and `KDI_BOARD` only when `FF_HARNESS_CONTEXT` is enabled
- [x] Added tests in `tests/profiles.test.ts` for `{{title}}`/`{{body}}` validation and substitution
- [x] Added tests in `tests/dispatcher.test.ts` for `{{title}}`/`{{body}}` command substitution and `KDI_TASK_*` env vars, including null-body handling and disabled-flag behavior
- [x] Updated existing dispatcher tests that previously expected an undefined env object when no optional env vars were set
- [x] `bun run lint`, `bun run test`, and `bun run build` pass

## Hermes Kanban Parity Verification — 2026-06-20/21 (in progress)
- [x] Live CLI verification run via `kdi-new-feature-loop` with temp `HOME`/`KDI_DB` and all feature flags enabled.
- [x] ~~Critical bug: global/subcommand `--board` flag is ignored; only `KDI_BOARD` env and current-board file resolve correctly.~~ **Fixed by KDI-042.**
- [x] Critical bug: `src/flags.ts` contained unresolved git merge conflict markers that broke `bun run build`/`dev`; resolved during verification.
- [x] Additional verified gaps documented in `specs/hermes-kanban-backlog.md` (KDI-042 through KDI-052); **KDI-043 is done**.
- [x] Test suite health: `bun run lint` passes; `bun test` reports **867 pass / 0 fail** (867 tests, 41 files) when run with isolated `KDI_DB`.
- [x] **Real harness end-to-end test with opencode**: dispatcher creates worktree `wt/opencode/1`, spawns `opencode run`, agent edits `README.md`, task moves to `done`. Verified worktree isolation, log capture, and run recording.
- [x] KDI-052: Pass task title/body/context to harnesses implemented.
- [x] KDI-053: Clean result/summary capture from harness output implemented.
- [x] KDI-054: Real harness parity test added (opt-in via `KDI_REAL_HARNESS_TEST=true`).

## KDI-052 / KDI-053 / KDI-054: Hermes Parity Bundle — Done
- [x] Feature flags `ff_harness_context` / `FF_HARNESS_CONTEXT` and `ff_result_summary` / `FF_RESULT_SUMMARY` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `ALLOWED_TEMPLATES` and `substituteCommand` support `{{title}}`, `{{body}}`, and `{{result_file}}`
- [x] Dispatcher exports `KDI_TASK_TITLE`, `KDI_TASK_BODY`, `KDI_TASK_ID`, `KDI_BOARD`, and `KDI_RESULT_FILE` to harnesses when flags are enabled
- [x] Pure helper `extractHarnessResult()` in `src/harnessResult.ts` reads `.kdi-result.txt` or parses the last JSON text chunk from stdout
- [x] Dispatcher stores clean result/summary on successful harness runs when `FF_RESULT_SUMMARY` is enabled
- [x] Opt-in real harness parity test at `tests/real-harness-parity.test.ts` (gated by `KDI_REAL_HARNESS_TEST=true`); test creates a fake `opencode` harness, a real git repo, a KDI board, task, and dispatcher daemon; asserts the harness receives expected task context env vars and writes a marker file in the active worktree; asserts the task transitions to `running`, then `done` after a sentinel file is written, and `kdi show` contains the clean result
- [x] `bun run lint`, `bun run build`, and targeted tests pass

## KDI-045: `kdi create --parent` — Done
- [x] BRD drafted at `specs/brd-kdi-045-create-parent.md`
- [x] Feature flag `ff_create_parent` / `FF_CREATE_PARENT` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi create <title> --parent <task_id>` repeatable option added to `src/commands/tasks.ts`
- [x] Each `--parent` value creates a parent-\u003echild dependency via `addDependency`
- [x] Missing parents, self-dependencies, and circular dependencies rejected with clear errors
- [x] Duplicate parent links are idempotent (ignored on UNIQUE constraint)
- [x] Unit tests in `tests/create-parent.test.ts` cover single parent, multiple parents, flag gating, missing parent, self-dependency, circular dependency, and idempotency with `--idempotency-key`
- [x] `bun run lint`, `bun test tests/create-parent.test.ts`, and `bun run build` pass

## Bulk `kdi unblock` (KDI-047) — In Progress
- [x] BRD drafted at `specs/brd-kdi-047-unblock-bulk.md`
- [x] `kdi unblock <id1> <id2>...` unblocks or readies multiple tasks at once
- [x] Per-task success/skip reporting with summary line
- [x] Exit 1 when any task is skipped
- [x] Single-task behavior preserved
- [x] Update `specs/hermes-kanban-backlog.md` KDI-047 status and feature mapping
- [x] Unit/CLI tests cover single-task, bulk, mixed-status, missing, and archived cases
- [x] `bun run lint`, `bun run test`, `bun run build` pass
- [x] User-loop smoke proven with temp `HOME` and temp `KDI_DB`

## Dispatcher Presence Warning (KDI-037) — Done
- [x] BRD drafted at `specs/brd-kdi-037-dispatcher-presence-warning.md`
- [x] Feature flag `ff_dispatcher_presence_warning` / `FF_DISPATCHER_PRESENCE_WARNING` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `src/dispatcherPresence.ts` exposes `getDispatcherPidPath(slug)` and `isDispatcherPresent(slug)`; `isDispatcherPresent` returns `true` only when the PID file exists, is readable, contains a single positive integer, and `process.kill(pid, 0)` succeeds — any other condition returns `false`
- [x] `kdi create <title> [--no-dispatcher-warning]` option added to `src/commands/tasks.ts`; warning is printed to stderr (single line via `console.warn`) after the board is resolved and before the task is created, only when the flag is on AND `--no-dispatcher-warning` is not set
- [x] Warning is non-blocking: task ID is still printed to stdout and the command exits `0`
- [x] Unit tests in `tests/dispatcherPresence.test.ts` cover missing, empty, non-numeric, negative, zero, dead-PID, live-PID, and non-existent-board-slug cases
- [x] CLI tests in `tests/commands/tasks.test.ts` (KDI-037 describe block) cover flag-on/live, flag-on/missing, flag-on/dead, flag-on/malformed, `--no-dispatcher-warning` suppression, and flag-off/option-accepted
- [x] User-loop smoke proven with temp `HOME` and temp `KDI_DB`: warning appears on no-PID/dead-PID, suppressed on live-PID, suppressed by `--no-dispatcher-warning`, and absent when flag is off
- [x] `bun run lint`, `bun test tests/dispatcherPresence.test.ts tests/commands/tasks.test.ts`, and `bun run build` pass; full suite (807 tests) passes
- [x] Out of scope (deferred): dispatcher writes per-board PID marker at startup and removes it on clean shutdown (separate scope)

## Global `--board` Flag Resolution (KDI-042) — Done
- [x] Root Commander program registers `--board <slug>` as a global option in `src/index.ts`
- [x] `preAction` hook copies the global `--board` value into `KDI_BOARD` when the subcommand does not provide its own `--board`; gated by `FF_GLOBAL_BOARD`
- [x] Subcommand `--board` continues to take precedence over the global `--board`
- [x] Resolution chain honored: explicit `--board` flag (global or subcommand) → `KDI_BOARD` env → current-board file → `"default"`
- [x] `kdi dispatch` accepts `--board <slug>` and filters the one-shot/daemon tick to that board
- [x] E2e coverage in `tests/global-board.test.ts` proves global `--board` works for `create`, `list`, `show`, `dispatch`, and `swarm`
- [x] Feature flag `FF_GLOBAL_BOARD` remains registered and defaults to `false`
- [x] `bun run lint`, `bun run test`, and `bun run build` pass in the worktree with isolated `KDI_DB`

## Triage Automation (KDI-040) — Done
- [x] BRD drafted at `specs/brd-kdi-040-triage-automation.md` to match LLM-powered triage automation semantics
- [x] Feature flag `ff_triage_automation` / `FF_TRIAGE_AUTOMATION` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `kdi specify` LLM path and `kdi decompose` command in `src/commands/tasks.ts`; `kdi decompose` wired into `src/index.ts`
- [x] `specifyTaskWithLlm()` / `decomposeTask()` model helpers in `src/models/task.ts`
- [x] OpenAI-compatible LLM client and prompt builders in `src/llm.ts`
- [x] `--all` and `--tenant` sweep modes for both commands
- [x] `--skip-llm` escape hatch preserves manual `kdi specify` behavior
- [x] Invalid LLM responses block tasks with clear reasons; invalid decomposition blocks parent with no children created
- [x] `specified` event gains `{ llm: true }` payload; new `decomposed` event kind
- [x] Unit and CLI tests covering flag gating, LLM success/failure paths, `--all`, `--tenant`, decomposition validation, and `--skip-llm`
- [x] `bun run lint` and `bun run build` pass; new tests pass; full suite matches existing flaky baseline

## Swarm Mode (KDI-041) — Done
- [x] BRD revised at `specs/brd-kdi-041-swarm-mode.md` to match multi-agent task graph semantics
- [x] Feature flag `ff_swarm_mode` / `FF_SWARM_MODE` registered in `specs/feature-flags.md`, defaults to `false`
- [x] Feature flag constant `FF_SWARM_MODE` registered in `src/flags.ts`
- [x] Schema migration for `tasks.swarm_parent_id INTEGER` column and `idx_tasks_swarm_parent` index
- [x] `createSwarmGraph()` model helper in `src/models/swarm.ts`
- [x] `kdi swarm` command in `src/commands/swarm.ts` wired into `src/index.ts`
- [x] CLI parsing for repeatable `--worker <profile>:<title>` plus `--verifier` and `--synthesizer`
- [x] Input validation: at least one worker, required verifier/synthesizer, worker format, duplicate titles
- [x] `--dry-run` prints planned graph without mutating state
- [x] Dispatcher honors dependency ordering for verifier and synthesizer
- [x] Dispatcher swarm watcher: auto-complete orchestrator on synthesizer success, block on child failure
- [x] Result propagation via KDI-023 context builder (parent results)
- [x] Events: `swarm_created`, `swarm_worker_created`, `swarm_verifier_created`, `swarm_synthesizer_created`, `swarm_completed`, `swarm_failed`
- [x] Unit and CLI tests covering happy path, dry-run, validation errors, dependency ordering, result propagation, and failure handling
- [x] `bun run lint`, `bun run test`, `bun run build` pass

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
- [x] `kdi boards rename-slug <old-slug> <new-slug>` — rename a board slug (data directory, current-board)

## Board Metadata (KDI-012) — Done
- [x] `name`, `icon`, `color` columns added to `boards` table (schema + migration)
- [x] Feature flag `ff_board_metadata` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards create <slug> --workdir <path> [--name <name>] [--icon <icon>] [--color <color>]` — stores board metadata when flag enabled
- [x] `kdi boards edit <slug> [--name <name>] [--icon <icon>] [--color <color>]` — updates board metadata when flag enabled
- [x] `kdi boards show <slug>` displays Name, Icon, Color when set and flag enabled
- [x] `kdi boards list` shows metadata compactly when flag enabled
- [x] Board name defaults to slug when omitted; icon and color default to null

## Board Description (KDI-044) — Done
- [x] `description` column added to `boards` table (schema + migration)
- [x] `kdi boards create <slug> --workdir <path> [--description <description>]` — stores board description when `ff_board_metadata` enabled
- [x] `kdi boards edit <slug> [--description <description>]` — updates board description when `ff_board_metadata` enabled
- [x] `kdi boards show <slug>` displays Description when set and `ff_board_metadata` enabled
- [x] `--description` is rejected when `ff_board_metadata` is disabled
- [x] Empty/whitespace-only descriptions are rejected
- [x] Description defaults to null when omitted
- [x] Existing databases are migrated to include the `description` column
- [x] Unit tests in `tests/board.test.ts` and CLI/e2e tests in `tests/e2e.test.ts` cover create, edit, show, flag gating, trimming, and migration
- [x] `bun run lint`, `bun run test tests/board.test.ts tests/e2e.test.ts`, `bun run build` pass
- [x] User-loop smoke proven with temp `HOME` and temp `KDI_DB`

## Board Rename (KDI-014) — Done
- [x] `FF_BOARD_RENAME` flag registered in `src/flags.ts`, defaults to `false`
- [x] `kdi boards rename-slug <old-slug> <new-slug>` command added to `src/commands/boards.ts`
- [x] `renameBoardSlug()` model function in `src/models/board.ts` handles DB slug update and directory rename
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

## Default Workdir (KDI-015) — Done
- [x] `default_workdir` column added to `boards` table (schema + migration)
- [x] `workspace` column added to `tasks` so explicit/inherited task workspace paths persist
- [x] Feature flag `ff_default_workdir` / `FF_DEFAULT_WORKDIR` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards set-default-workdir <slug> <path>` stores and displays a board default workdir when the flag is enabled
- [x] `kdi boards set-default-workdir <slug>` clears the board default workdir when the flag is enabled
- [x] `kdi create <title> --board <slug>` inherits the board default when `--workspace` is omitted and the flag is enabled
- [x] `kdi create <title> --board <slug> --workspace <path>` overrides the board default when the flag is enabled
- [x] When `FF_DEFAULT_WORKDIR=false`, the command/`--workspace` option are rejected and default inheritance is skipped

## `kdi boards create --switch` (KDI-043) — Done
- [x] Feature flag `ff_board_create_switch` / `FF_BOARD_CREATE_SWITCH` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] `kdi boards create <slug> --workdir <path> --switch` auto-switches to the newly created board when `FF_BOARD_CREATE_SWITCH=true`
- [x] `--switch` is gated solely by `FF_BOARD_CREATE_SWITCH` (does not require `FF_BOARD_SWITCH`)
- [x] Without `--switch`, the current-board file is left unchanged
- [x] With `--switch` and `FF_BOARD_CREATE_SWITCH=false`, the command errors with a clear message and does not touch the current-board file
- [x] Invalid slugs are rejected before any current-board file mutation
- [x] Tests in `tests/board.test.ts` cover flag-on + `--switch`, flag-on + no `--switch`, flag-off + `--switch`, and invalid slug + `--switch`
- [x] User-loop smoke verified with temp `HOME` and temp `KDI_DB`: `--switch` switches to new board, no-switch leaves current board unchanged, flag-off errors cleanly
- [x] `bun run lint`, `bun run test`, and `bun run build` pass

## Heartbeat (KDI-016) — Done
- [x] BRD drafted at `specs/brd-kdi-016-heartbeat.md`
- [x] Feature flag `ff_heartbeat` / `FF_HEARTBEAT` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_HEARTBEAT` constant added to `src/flags.ts`
- [x] `kdi heartbeat <task_id> [--note <text>]` command gated by `FF_HEARTBEAT`
- [x] Heartbeat updates `last_heartbeat_at` on task and active `task_runs` row
- [x] Heartbeat records a `heartbeat` event with optional note payload
- [x] Dispatcher reclaims `running` tasks whose `last_heartbeat_at` is older than 60 minutes
- [x] `kdi show <id>` displays `Last heartbeat:` when flag enabled and task is running
- [x] Unit/e2e tests added and passing
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Crash Grace Period (KDI-016b) — Done
- [x] BRD drafted at `specs/brd-kdi-016b-crash-grace.md`
- [x] Feature flag `ff_crash_grace_period` / `FF_CRASH_GRACE_PERIOD` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `spawned_at INTEGER` column added to `task_runs` via schema + migration in `src/db.ts`
- [x] `TaskRun` interface, column list, `createRun`, and `updateRun` updated to include `spawned_at`
- [x] Dispatcher records `spawned_at` on active runs at claim time and checks running runs for dead PIDs
- [x] Dispatcher skips dead-PID crash detection for 30 seconds after `spawned_at` when flag enabled
- [x] Dispatcher finalizes post-grace dead-PID runs as `outcome=crashed` and blocks/requeues per `max_retries`
- [x] `kdi runs <task_id>` displays `spawned_at` when flag enabled
- [x] Unit/dispatcher integration tests cover grace-period protection, post-grace crash detection, flag-disabled fallback, and `runs` display
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Rate-Limit Exit Code Handling (KDI-016c) — Done
- [x] BRD drafted at `specs/brd-kdi-016c-rate-limit-exit-code.md`
- [x] Feature flag `ff_rate_limit_exit_code` / `FF_RATE_LIMIT_EXIT_CODE` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_RATE_LIMIT_EXIT_CODE` constant added to `src/flags.ts`
- [x] `tasks.rate_limited_until INTEGER` column and `idx_tasks_rate_limited_until` index added via migration in `src/db.ts`
- [x] `Task` model, `TASK_COLUMNS`, and `hydrateTask` updated to include `rate_limited_until`
- [x] Dispatcher treats harness exit code 75 as transient rate limit when flag enabled
- [x] Rate-limited tasks return to `ready` without incrementing `consecutive_failures`
- [x] Dispatcher ready-task query and `atomicClaim` skip tasks whose `rate_limited_until` is in the future
- [x] Cooldown default 60s, overridable via `KDI_RATE_LIMIT_COOLDOWN_SECONDS` and `kdi dispatch --rate-limit-cooldown <duration>`
- [x] `kdi show <id>` displays `Rate limited until:` when flag enabled and cooldown is set
- [x] `rate_limited` event recorded with exit code, cooldown timestamp, and reason
- [x] Unit/dispatcher integration tests cover EX_TEMPFAIL requeue, cooldown suppression, override, flag-disabled fallback, and `kdi show` display
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Assign / Reassign (KDI-017) — Done
- [x] BRD drafted at `specs/brd-kdi-017-assign-reassign.md`
- [x] Feature flag `ff_assign_reassign` / `FF_ASSIGN_REASSIGN` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_ASSIGN_REASSIGN` constant added to `src/flags.ts`
- [x] `assignTask()` / `unassignTask()` / `reassignTask()` model functions in `src/models/task.ts`
- [x] `kdi assign <task_id> <profile>` and `kdi assign <task_id> none` commands
- [x] `kdi reassign <task_id> <profile> [--reclaim] [--reason <text>]` command
- [x] `kdi reclaim <task_id> --reason <text>` option gated by `FF_ASSIGN_REASSIGN`
- [x] `assigned`, `unassigned`, and `reclaimed` event emissions covered by tests
- [x] Unit/e2e tests added and passing
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Worker Log Capture (KDI-018) — Done
- [x] BRD drafted at `specs/brd-kdi-018-worker-log-capture.md`
- [x] Feature flag `ff_worker_log_capture` / `FF_WORKER_LOG_CAPTURE` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_WORKER_LOG_CAPTURE` constant added to `src/flags.ts`
- [x] Dispatcher writes harness stdout/stderr to `~/.local/share/kdi/logs/<board>/<task_id>.log` when flag enabled
- [x] `kdi log <task_id>` command prints the captured log
- [x] `kdi log <task_id> --tail <bytes>` prints only trailing bytes
- [x] Log-write failures do not cause the dispatcher to fail the task
- [x] Unit/dispatcher integration tests cover log creation, `--tail`, missing log handling, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Board Stats (KDI-019) — Done
- [x] BRD drafted at `specs/brd-019-stats.md`
- [x] Feature flag `ff_stats` / `FF_STATS` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_STATS` constant added to `src/flags.ts`
- [x] `kdi stats [--board <slug>]` command gated by `FF_STATS`
- [x] `kdi stats` prints per-status counts, per-assignee counts, and oldest-ready age
- [x] `kdi stats --json` emits stable JSON document
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover counts, JSON output, board resolution, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Diagnostics (KDI-020) — Done
- [x] BRD drafted at `specs/brd-kdi-020-diagnostics.md`
- [x] Feature flag `ff_diagnostics` / `FF_DIAGNOSTICS` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_DIAGNOSTICS` constant added to `src/flags.ts`
- [x] `kdi diagnostics [--board <slug>]` command gated by `FF_DIAGNOSTICS`
- [x] `kdi diagnostics --severity {warning|error|critical}` filters by minimum severity
- [x] `kdi diagnostics --task <task_id>` restricts findings to a single task
- [x] `kdi diagnostics --json` emits stable JSON array
- [x] 8 diagnostic rules implemented: `stranded_in_ready`, `stuck_in_blocked`, `repeated_failures`, `repeated_crashes`, `block_unblock_cycling`, `hallucinated_cards`, `prose_phantom_refs`, `triage_aux_unavailable`
- [x] Each finding includes rule, severity, task_id, message, and suggested actions
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover each rule, severity filtering, per-task mode, JSON output, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Garbage Collection (KDI-021) — Done
- [x] BRD drafted at `specs/brd-kdi-021-gc.md`
- [x] Feature flag `ff_gc` / `FF_GC` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `FF_GC` constant added to `src/flags.ts`
- [x] `kdi gc [--board <slug>] [--event-retention-days <n>] [--log-retention-days <n>]` command gated by `FF_GC`
- [x] `kdi gc` deletes task events older than `--event-retention-days`
- [x] `kdi gc` deletes worker logs older than `--log-retention-days`
- [x] `kdi gc` cleans KDI-owned workspaces for archived tasks (board data dir or temp `kdi-*` paths)
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover event deletion, log deletion, workspace cleanup, board resolution, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Assignees Listing (KDI-024) — Done
- [x] Feature flag `ff_assignees_listing` / `FF_ASSIGNEES_LISTING` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `getAssigneeCounts()` model helper in `src/models/task.ts` counts non-archived tasks per assignee for a board
- [x] `kdi assignees [--board <slug>]` command in `src/commands/assignees.ts`, wired into `src/index.ts`
- [x] Listing merges known profiles from the profile registry with assignees present on the resolved board
- [x] Each profile shows the count of non-archived tasks assigned to it on the board
- [x] `kdi assignees --json` emits a stable JSON document (`{ board, assignees: [{ profile, count }] }`)
- [x] Board resolved via standard chain; errors clearly when board is missing or archived
- [x] Unit/CLI tests cover counts, JSON output, board resolution, archived exclusion, and flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Task Attachments (KDI-022) — Done
- [x] BRD drafted at `specs/brd-kdi-022-task-attachments.md`
- [x] Feature flag `ff_task_attachments` / `FF_TASK_ATTACHMENTS` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `task_attachments` table + index added via schema + migration in `src/db.ts`
- [x] `kdi attach <task_id> <file>` command copies file to board storage and records metadata
- [x] `kdi show <id>` displays attachments when flag enabled
- [x] Board hard-delete cascade-deletes attachment rows and on-disk `attachments/` directory
- [x] Unit/CLI tests cover storage, flag gating, duplicate-name rejection, and hard-delete cascade
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Context Builder (KDI-023) — Done
- [x] BRD drafted at `specs/brd-kdi-023-context-builder.md`
- [x] Feature flag `ff_context_builder` / `FF_CONTEXT_BUILDER` registered in `specs/feature-flags.md`, defaults to `false`
- [x] `FF_CONTEXT_BUILDER` constant added to `src/flags.ts`
- [x] `kdi context <task_id> [--board <slug>] [--json]` command gated by `FF_CONTEXT_BUILDER`
- [x] Context builder composes 7 sections: header, body, parent results, prior attempts, role history, comments, attachments
- [x] All free-text/count fields capped per BRD to prevent prompt overflow
- [x] Parent results only include done parents; ordered by insertion order
- [x] Role history derives actors and notes from task events
- [x] Comments fallback to `"user"` when `author` column is absent
- [x] Attachment paths resolved to absolute; tolerated when `task_attachments` table missing
- [x] Board resolved via standard chain
- [x] Unit/CLI tests cover happy path, truncation, caps, missing task, flag gating, JSON output
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## Notification Subscriptions (KDI-025) — Done
- [x] BRD drafted at `specs/brd-kdi-025-notification-subscriptions.md`
- [x] Feature flag `ff_notify_subs` / `FF_NOTIFY_SUBS` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `kanban_notify_subs` table schema and migration in `src/db.ts`
- [x] `subscribe()` / `listSubscriptions()` / `unsubscribe()` model functions in `src/models/notifySub.ts`
- [x] `kdi notify-subscribe <task_id> --platform <name> --chat-id <id>` command
- [x] `kdi notify-list [<task_id>] [--archived] [--json]` command
- [x] `kdi notify-unsubscribe <task_id> --platform <name> --chat-id <id>` command
- [x] Notifier profiles registry `~/.config/kdi/notifiers.yaml` with built-in `log` profile
- [x] Notifier watcher in dispatcher tick loop gated by `FF_NOTIFY_SUBS`
- [x] Transport handlers: telegram, slack, discord, webhook, log
- [x] Unit/CLI tests for all CLI commands and notifier watcher
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## CLI Polish Specs (KDI-030 through KDI-035) — Done
- [x] BRDs drafted:
  - `specs/brd-kdi-030-list-filters-sort.md`
  - `specs/brd-kdi-031-show-run-filtering.md`
  - `specs/brd-kdi-032-bulk-operations.md`
  - `specs/brd-kdi-033-comment-enhancements.md`
  - `specs/brd-kdi-034-dispatch-controls.md`
  - `specs/brd-kdi-035-watch-filters.md`
- [x] Feature flags registered in `specs/feature-flags.md`:
  - `ff_list_filters_sort` / `FF_LIST_FILTERS_SORT`
  - `ff_show_run_filtering` / `FF_SHOW_RUN_FILTERING`
  - `ff_bulk_operations` / `FF_BULK_OPERATIONS`
  - `ff_comment_enhancements` / `FF_COMMENT_ENHANCEMENTS`
  - `ff_dispatch_controls` / `FF_DISPATCH_CONTROLS`
  - `ff_watch_filters` / `FF_WATCH_FILTERS`
- [x] Feature flags registered in `src/flags.ts`

## KDI-030: `kdi list` Filters and Sort — Done
- [x] `session_id`, `workflow_template_id`, `current_step_key` columns added to `tasks` (schema + migrations)
- [x] Supporting indexes: `idx_tasks_session`, `idx_tasks_workflow_template`, `idx_tasks_step_key`
- [x] `kdi list --mine` — filter by current profile assignee (resolved from `KDI_PROFILE` → `HERMES_PROFILE` → `"user"`)
- [x] `kdi list --session <session_id>` — filter by originating session
- [x] `kdi list --archived` — include archived tasks in listing
- [x] `kdi list --sort <key>` — sort by `assignee`, `created`, `created-desc`, `priority`, `priority-desc`, `status`, `title`, `updated`
- [x] `kdi list --workflow-template-id <id>` — filter by workflow template
- [x] `kdi list --step-key <key>` — filter by current step key
- [x] `kdi create --session <session_id>` — store originating session on task
- [x] `--mine` and `--assignee` mutually exclusive; clear error when used together
- [x] New filters compose with existing `--status`, `--assignee`, `--tenant`, `--created-by`
- [x] All new options gated by `FF_LIST_FILTERS_SORT` (defaults to `false`)
- [x] Invalid sort keys rejected with a list of valid values
- [x] Unit tests cover each filter, sort key, archived inclusion, and flag gating
- [x] CLI/e2e tests cover all acceptance criteria from the BRD
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-031: `kdi show` Run Filtering — Done
- [x] `kdi show <task_id>` displays a "Runs:" section after comments and attachments when flag enabled
- [x] `--state-type status --state-name <value>` filters runs by status
- [x] `--state-type outcome --state-name <value>` filters runs by outcome
- [x] Only passing both `--state-type` and `--state-name` is valid; partial pairs rejected
- [x] Invalid `--state-type` rejected with clear error listing valid values
- [x] "No runs found for this task." when task has no runs
- [x] "No runs match the filter." when filter matches nothing
- [x] All new options gated by `FF_SHOW_RUN_FILTERING` (defaults to `false`)
- [x] `kdi runs` and default `kdi show` output unchanged when flag disabled
- [x] Unit tests for `getRunsFiltered` — validation, filter matching, empty states
- [x] CLI/e2e tests cover acceptance criteria
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-036: `kdi runs` Filtering — Done
- [x] `kdi runs <task_id>` lists all runs for the task, newest first, format unchanged
- [x] `--state-type status --state-name <value>` filters runs by status
- [x] `--state-type outcome --state-name <value>` filters runs by outcome
- [x] Only passing both `--state-type` and `--state-name` is valid; partial pairs rejected
- [x] Invalid `--state-type` rejected with clear error listing valid values
- [x] "No runs found for this task." when task has no runs
- [x] "No runs match the filter." when filter matches nothing
- [x] All new options gated by `FF_RUNS_FILTERING` (defaults to `false`)
- [x] Unfiltered `kdi runs` output byte-for-byte unchanged when flag disabled
- [x] Reuses the `getRunsFiltered` model helper from KDI-031 as the single source of truth
- [x] Unit tests for `getRunsFiltered` cover filter matching, validation, empty states
- [x] CLI/e2e tests cover flag gating, both/neither validation, invalid type, status/outcome match, empty filter, no-runs baseline
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-032: Bulk Operations — Done
- [x] `kdi block <id1> <id2>... --reason <text>` — bulk block with pre-checks for already-blocked
- [x] `kdi schedule <id1> <id2>... --at <timestamp> [--reason <text>]` — bulk schedule with per-task try/catch
- [x] `kdi promote <id1> <id2>... [--force] [--dry-run]` — bulk promote with dependency override
- [x] `kdi promote --force` bypasses parent dependency checks
- [x] `kdi promote --dry-run` prints verdicts without mutating state
- [x] `kdi archive --rm <id1> <id2>...` — permanently delete archived tasks (FK-safe cascade)
- [x] Already-blocked tasks skipped with clear "already blocked" message
- [x] Already-archived tasks skipped during block operations
- [x] `archive --rm` rejects non-archived tasks with clear error
- [x] Bulk operations gated by `FF_BULK_OPERATIONS` (defaults to `false`)
- [x] Single-task `block`/`promote`/`archive` work when flag disabled
- [x] Unit tests cover `promoteTaskAdvanced`, `archiveTaskHard`, flag gating
- [x] CLI/e2e tests cover acceptance criteria
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-033: Comment Enhancements — Done
- [x] `kdi comment <task_id> <text> --author <name>` — stores author on comment
- [x] Default author resolved from `KDI_PROFILE` → `HERMES_PROFILE` → `"user"`
- [x] `kdi comment <task_id> <text> --max-len <n>` — trims stored text to n characters
- [x] Empty `--author` rejected with clear error
- [x] Invalid `--max-len` (0, -1, non-numeric) rejected with clear error
- [x] `kdi show <task_id>` displays author with each comment when flag enabled
- [x] `author` column added to `comments` table (migration guarded by `PRAGMA table_info`)
- [x] All new options gated by `FF_COMMENT_ENHANCEMENTS` (defaults to `false`)
- [x] Preserve backward compatibility: existing comments show "user" as fallback author
- [x] Unit/CLI tests cover author resolution, max-len trimming, flag gating, show display
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-034: Dispatch Controls — Done
- [x] `kdi dispatch --failure-limit <n>` — per-pass failure threshold
- [x] Failure counter increments for: crash, spawn-fail, board not found, unknown profile, worktree failure, harness failure
- [x] Rate-limited tasks (exit code 75) excluded from failure counter
- [x] Dependency-skipped tasks excluded from failure counter
- [x] Warning emitted to stderr + board log when limit reached
- [x] `--failure-limit` combines independently with `--max`
- [x] `--max <n>` behavior preserved unchanged (ungated)
- [x] `parseFailureLimit()` pure function extracted, unit-tested
- [x] `--failure-limit` gated by `FF_DISPATCH_CONTROLS` (defaults to `false`)
- [x] Unit/dispatcher tests cover happy-path, early-exit, zero/invalid inputs, flag gating
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-035: Watch Filters — Done
- [x] `kdi watch --assignee <profile>` — filter by task assignee
- [x] `kdi watch --tenant <name>` — filter by task tenant (also gated by `FF_TENANT_NAMESPACE`)
- [x] `kdi watch --kinds <kind1>,<kind2>` — filter by event kinds
- [x] `kdi watch --interval <seconds>` — custom poll interval (min 0.1s)
- [x] Filters compose with AND semantics
- [x] Empty `--assignee`, `--tenant`, `--kinds` rejected with clear errors
- [x] Invalid `--interval` rejected with clear error
- [x] Unfiltered `kdi watch` behavior unchanged
- [x] `getRecentEvents` and `getEventsAfter` accept optional `WatchFilters`
- [x] Filtered queries use parameterized SQL; no string interpolation of user input
- [x] Combined assignee + tenant AND filtering tested
- [x] All new options gated by `FF_WATCH_FILTERS` (defaults to `false`)
- [x] Unit/CLI tests cover filters, combinations, flag gating, edge cases
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-038: Goal Mode — Done
- [x] BRD drafted at `specs/brd-kdi-038-goal-mode.md` to match Ralph-style multi-turn goal loop semantics
- [x] Feature flag `ff_goal_mode` / `FF_GOAL_MODE` registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [x] Additive schema migration adds `goal_mode`, `goal_max_turns`, `goal_remaining_turns`, `goal_judge_profile` columns to `tasks` and `idx_tasks_goal_mode` index; `task_runs.outcome` CHECK extended to include `'goal_continue'` via the same `tasks_new`-style table-recreate pattern
- [x] `Task` interface, `TASK_COLUMNS`, `CreateTaskInput`, `createTask`, `hydrateTask` updated in `src/models/task.ts`
- [x] `decrementGoalTurns(id)` and `resetGoalTurns(id)` helpers exported from `src/models/task.ts`; `unblockTask` resets `goal_remaining_turns` when unblocking a `"Goal max turns exhausted"` task
- [x] `kdi create --goal --goal-max-turns <n> --goal-judge <profile>` command in `src/commands/tasks.ts` with validation: `--goal` requires `--goal-max-turns` (positive int) and a known judge profile (CLI flag or `KDI_GOAL_JUDGE_PROFILE` env); rejects unknown profiles and disabled flag with clear errors
- [x] `kdi show <id>` displays `Goal: <remaining>/<max> turns, judge=<profile>` line when `FF_GOAL_MODE` is enabled and the task is goal-mode
- [x] Dispatcher goal-loop integration in `src/dispatcher.ts` (gated by `FF_GOAL_MODE`): passes `KDI_GOAL_*` env vars to the harness, and on a non-zero exit decrements `goal_remaining_turns` and requeues the task with a `goal_turn` event, or blocks with `"Goal max turns exhausted"` when the budget hits 0
- [x] Judge approximation: `isGoalSatisfied()` treats a `exit 0` harness as a satisfied goal; a `ponytail:` comment in `src/dispatcher.ts` names the upgrade path (spawn `task.goal_judge_profile` with the same env vars, parse verdict from `KDI_GOAL_VERDICT_FILE`)
- [x] Unit, CLI, and dispatcher tests covering schema round-trip, `--goal` validation, `kdi show` goal-mode display, requeue on no-satisfy, exhaustion blocking, flag-disabled behavior, and env-var pass-through
- [x] `bun run lint`, `bun run test`, `bun run build` pass

## KDI-039: Workflow Templates — Done
- [x] BRD finalized at `specs/brd-kdi-039-workflow-templates.md`
- [x] Feature flag `ff_workflow_templates` / `FF_WORKFLOW_TEMPLATES` registered in `specs/feature-flags.md` and `src/flags.ts`, defaults to `false`
- [x] `workflow_templates` table schema and migration in `src/db.ts`; cascade-deleted on board hard-delete
- [x] `defineWorkflowTemplate()` / `listWorkflowTemplates()` / `getWorkflowTemplate()` / `validateStepKey()` / `advanceTaskStep()` / `setTaskStep()` model functions in `src/models/workflowTemplate.ts`
- [x] `kdi workflows define <id> --name <name> --steps <json>` command
- [x] `kdi workflows list [--board <slug>] [--json]` command
- [x] `kdi create <title> --workflow-template-id <id> [--step-key <key>]` command; validates template exists and step key is valid
- [x] `kdi step <task_id> [--to <key>] [--reason <text>]` command; advances to next step or jumps to arbitrary step
- [x] `kdi show <task_id>` displays workflow template and current step when flag enabled
- [x] Step advancement emits `stepped` event; terminal step transitions task to `done` and emits `completed`
- [x] Step-key driven routing: dispatcher records `current_step_key` on `task_runs`, substitutes `{{step_key}}` in profile commands, and sets `KDI_CURRENT_STEP_KEY` env var for harnesses
- [x] `kdi runs <task_id>` displays `step=<key>` when the run has a step key
- [x] Unit/CLI tests cover template CRUD, step advancement, terminal completion, validation, dispatcher routing, runs display, and flag gating
- [x] E2E verified: define template → create bound task → step through workflow → terminal completion
- [x] `bun run lint` and `bun run build` pass
- [x] Code-review fixes: duplicate BRD files removed, missing imports in `tests/task.test.ts` restored, template name length capped at 255 in `defineWorkflowTemplate()`, event payloads no longer use `Record<string, any>`

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
- [x] `kdi runs <task_id>` — show attempt history with optional `--state-type`/`--state-name` filters (KDI-036)

## Task Runs Status (KDI-000e)
- [x] `status` column on `task_runs`: `running | done | blocked | crashed | timed_out | failed | released`
- [x] Distinct from `outcome` (terminal classification)
- [x] Indexed: `idx_runs_status`
- [x] `finishRun` maps outcome → status (e.g. `reclaimed` → `released`, `crashed` → `crashed`)

## Task Events (KDI-000b)
- [x] `task_events` table with task_id, run_id, kind, payload, created_at
- [x] `kdi tail <task_id>` — follow events live (poll 1s), with optional `--lines N` / `--no-follow` non-following mode (KDI-049)
- [x] `kdi watch` — board-wide event stream (poll 0.5s) with optional `--assignee`, `--tenant`, `--kinds`, and `--interval` filters (KDI-035)
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
- [ ] Dispatcher writes per-board PID markers and `kdi create` warns when no live dispatcher is detected (KDI-037)

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
- [x] **`bun run test` exits 1 despite all tests passing** — Fixed by switching `createTaskCommand` and `listTasksCommand` error handling to `this.error()` (Commander's internal exit path) and updating KDI-030/KDI-039 tests to use `exitOverride()` instead of mocking `process.exit`. Added `resetCommandOptions()` helper to clear stale Commander singleton option state between tests.
- [ ] **Worker log capture test flaky in full-suite runs** — `worker log capture > spawnHarness writes combined stdout/stderr to log file` (and the matching e2e dispatcher log test) occasionally fail when the full suite runs but pass in isolation. Likely an ordering/timing interaction between tests sharing `HOME`/`KDI_DB` defaults. Documented by reviewer for KDI-022; investigate and fix if it persists on `main`.
- [ ] **SQLite monolithic migration** — The single `CREATE TABLE tasks_new ... DROP TABLE ... RENAME TO` migration handles schema changes for KDI-001 (triage), KDI-002 (scheduled), KDI-003 (review), and KDI-004 (integer priority) in one pass. This is technically required by SQLite (can't `ALTER TABLE` CHECK constraints or change column types), but it mixes feature boundaries. If versioned migration files are ever introduced, this should be split into per-feature steps with intermediate schema versions.
- [ ] **`tests/init.test.ts` fails when `KDI_DB` is set** — `defaultDbPath()` honors the `KDI_DB`/`KDI_DB_PATH` environment variables, but `tests/init.test.ts` asserts that `defaultDbPath()` ends with `.db`. When the parent environment sets `KDI_DB` to a path without that suffix (e.g. `.../kdi.sqlite`), the assertion fails. The implementation is correct; the test is environment-sensitive. Run the suite with `env -u KDI_DB bun test` for a clean baseline.
- [ ] **Import-path convention conflict** — `AGENTS.md` prescribes the `~/*` alias for `src/*` imports, but the entire existing codebase uses relative imports (e.g. `../models/board`). KDI-024 followed the existing relative-import convention to stay consistent with surrounding code. The project should either migrate all imports to `~/*` or update `AGENTS.md` to reflect the actual convention.

### Review nits (from KDI-036/037/038 reviews)

- [ ] **KDI-036: `validTypes` constant duplicated in three places** — `["status", "outcome"]` is defined in `src/models/taskRun.ts:117` (model), `src/commands/tasks.ts:1448` (`listRunsCommand`, KDI-036), and `src/commands/tasks.ts:464` (`showTaskCommand`, KDI-031). Extract a single `VALID_RUN_FILTER_TYPES` const or a small `parseRunFilterOptions(...)` helper. Risk: the two commands can drift on error wording; consolidating removes the duplication. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.
- [ ] **KDI-036: option-gate / partial-pair / valid-type validation block duplicated between `listRunsCommand` and `showTaskCommand`** — `src/commands/tasks.ts:1431-1455` (KDI-036) is a near byte-for-byte copy of `src/commands/tasks.ts:444-462` (KDI-031). Extract a shared helper to remove ~25 lines of duplication. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.
- [ ] **KDI-031 docs typo: `ff_show_run_filtering` lifecycle header still says `— Planned`** — `specs/feature-flags.md:458` reads `### \`ff_show_run_filtering\` — Planned` but the registry row at line 60 is `InDev` and the section in `STATUS.md` is marked Done. Pre-existing from KDI-031; the KDI-036 PR makes the inconsistency more visible. Caught by `pi.backend-reviewer` on PR #32. Fix: flip the header to `— InDev`.
- [ ] **KDI-037: unused imports in `tests/dispatcherPresence.test.ts:2,8`** — `readFileSync` (from `node:fs`) and `createBoard` (from `../src/models/board`) are imported but never referenced. The linter does not catch them because the project does not enable `noUnusedLocals` for this file context. Drop the imports. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.
- [ ] **KDI-037: dead helpers `captureWarn` / `restoreWarn` in `tests/commands/tasks.test.ts:864-878`** — Defined in the KDI-037 describe block but never called; every test inlines its own `console.warn` capture via `try/finally`. Delete the helpers. Caught by `pi.backend-reviewer` on PR #32, APPROVE_WITH_NITS.

### Deferred non-blocking items (from KDI-038 review)

- [ ] **KDI-038: AC-13 — missing-judge-profile runtime block not enforced** — A goal-mode task created directly via the model (bypassing CLI) with `goal_judge_profile = null` is still dispatched, with the harness exit code standing in for the missing judge. CLI validation prevents this in practice. The BRD's defensive block-reason ("Goal-mode task missing required judge profile") is not enforced at the dispatcher level. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: NFR — `tasks.result` not capped at 64 KiB on requeue** — `src/dispatcher.ts:333-336` (`handleGoalContinue`) concatenates `task.result` with the new `[turn N] <error>` note without a cap. Long-running goal loops with verbose harnesses could grow `tasks.result` without bound. BRD NFR says to trim to 64 KiB. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: test gap — `KDI_GOAL_CONTEXT` env var not asserted** — `src/dispatcher.ts:582` sets `KDI_GOAL_CONTEXT = task.result ?? ""` for the harness, but the env-vars test in `tests/dispatcher.test.ts:1697-1719` does not assert it. A regression that drops the env var would not be caught. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: test gap — `task_runs.outcome === 'goal_continue'` not asserted on the requeue path** — AC-09 requires the active run to be finalized with `outcome = 'goal_continue'` and `status = 'released'` on a continue verdict. The requeue test asserts the event but not the run row's outcome. A regression that drops the outcome mapping would not be caught. Caught by `pi.backend-reviewer` on PR #32.
- [ ] **KDI-038: judge approximation (intentional v1)** — `isGoalSatisfied()` in `src/dispatcher.ts` treats `exit 0` as a satisfied goal. A `ponytail:` comment names the upgrade path (spawn `task.goal_judge_profile` with the same `KDI_GOAL_*` env vars, parse verdict from `KDI_GOAL_VERDICT_FILE`). Replace with real LLM-as-judge when the judge profile integration lands.

## Acceptance Criteria
- [x] `kdi create "backend: auth" --board myproj --assignee opencode` returns task ID
- [x] Task promoted to ready claimed by dispatcher within 10s
- [x] Harness runs in worktree branch `wt/<profile>/<task_id>`
- [x] Task result stored and visible via `show <task_id>`
- [x] Parent dependency blocks child until parent done
- [x] 100 tasks created + dispatched without SQLite contention
- [x] `kdi --version` returns semantic version
- [x] Adding new harness profile to `profiles.yaml` requires zero code changes

## Hermes Backlog Verification (2026-06-19)

- [x] `scripts/verify-hermes-backlog.sh` runs **89 / 90 PASS** against `main` (a4b2618) with every `FF_*` flag on, temp `HOME` + temp `KDI_DB`
- [x] Full per-item report at `specs/hermes-backlog-verification-2026-06-19.md`
- [x] Backlog updated with a `## Verification (2026-06-19)` section at `specs/hermes-kanban-backlog.md` listing 5 gaps
- [ ] **Gap: KDI-013 global `--board` flag** — real divergence from hermes; per-subcommand `--board`, `KDI_BOARD`, and `current` file all work, but `kdi --board demo …` errors with `unknown option '--board'`
- [ ] **Gap: `kdi boards create --switch`** — hermes parity; auto-switch-on-create not implemented
- [ ] **Gap: `kdi dispatch` is a long-running daemon, not a one-shot pass** — hermes defines `dispatch` as one-shot and `daemon` as long-running; kdi has only the daemon form (`src/dispatcher.ts:679-694`)
- [ ] **Gap: `kdi link` / `kdi unlink` CLI** — model exists in `src/models/dependency.ts`, no CLI command registered
- [ ] **Gap: `kdi specify --tenant <name>`** — rejected without `--all` or `<task_id>`; backlog implies it should sweep on its own
- [x] `bun test` (836 pass) and `tsc --noEmit` (clean) after adding the verification harness
