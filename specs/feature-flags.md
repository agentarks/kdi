# Feature Flags Registry

This document is the single source of truth for all `ff_*` feature flags in `kdi`.

## Conventions

- Every new feature is gated behind an `ff_*` flag registered here before implementation.
- CLI / server environment variable form: `FF_<FEATURE>=false` (upper snake case of the flag name, e.g. `FF_COMPLETE_METADATA=false`). The dispatcher flag `ff_kanban_dispatch` uses the explicit env var `FF_ENABLE_KANBAN_DISPATCH` for historical reasons.
- Browser environment variable form: not applicable (kdi is a Bun CLI binary)
- All flags default to `false` in every environment unless explicitly promoted.
- A flag is removed from code and this registry only after completing the deprecation window.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Planned
    Planned --> InDev : development starts
    InDev --> Active : shipped and enabled by default
    Active --> Deprecated : scheduled for removal
    Deprecated --> Removed : cleanup complete
    InDev --> Removed : cancelled
    Planned --> Removed : cancelled
```

## Registry

| Flag | Env Var | Scope | Status | Default | Since | Description |
|---|---|---|---|---|---|---|
| `ff_created_by` | `FF_CREATED_BY` | CLI / task metadata | InDev | `false` | KDI-007 | Tracks and displays the actor that created a task. |
| `ff_board_rm_delete` | `FF_BOARD_RM_DELETE` | CLI / board management | InDev | `false` | KDI-012c | Gates `boards rm --delete` permanent board deletion. |
| `ff_complete_metadata` | `FF_COMPLETE_METADATA` | CLI / complete | InDev | `false` | KDI-005 | Gates --metadata option only. Base --result / --summary always available. |
| `ff_kanban_dispatch` | `FF_ENABLE_KANBAN_DISPATCH` | CLI / dispatcher | Planned | `false` | — | Background dispatcher loop that polls ready tasks and spawns harness profiles. |
| `ff_scheduled_status` | `FF_SCHEDULED_STATUS` | CLI / task lifecycle | InDev | `false` | KDI-002 | Scheduled status, schedule/unblock commands, and scheduled_at field. |
| `ff_review_status` | `FF_REVIEW_STATUS` | CLI / task lifecycle | InDev | `false` | KDI-003 | Review status and review command. |
| `ff_priority_integer` | `FF_PRIORITY_INTEGER` | CLI / create | InDev | `false` | KDI-005 | Integer priority validation for create --priority (advisory — schema migration always runs). |
| `ff_tenant_namespace` | `FF_TENANT_NAMESPACE` | CLI / task lifecycle | InDev | `false` | KDI-006 | Tenant namespace on tasks; `create --tenant`; `list --tenant` filters by tenant. |
| `ff_skills_array` | `FF_SKILLS_ARRAY` | CLI / create, dispatcher | InDev | `false` | KDI-009 | Skills array on tasks; `create --skill`; dispatcher passes skills to harness via `{{skills}}` and `KDI_SKILLS`. |
| `ff_max_runtime` | `FF_MAX_RUNTIME` | CLI / create + dispatcher | InDev | `false` | KDI-008 | Per-task max runtime cap; dispatcher SIGTERMs/SIGKILLs worker when exceeded. |
| `ff_model_override` | `FF_MODEL_OVERRIDE` | CLI / create + dispatcher | InDev | `false` | KDI-010 | Per-task model override; `create --model`; dispatcher passes `{{model}}` and `KDI_MODEL` to harness. |
| `ff_max_retries` | `FF_MAX_RETRIES` | CLI / create + dispatcher | InDev | `false` | KDI-011 | Per-task max retries; auto-block after N consecutive spawn/execution failures. |
| `ff_board_metadata` | `FF_BOARD_METADATA` | CLI / board metadata | InDev | `false` | KDI-012 | Board name, icon, and color; `boards create --name/--icon/--color`, `boards edit`, and metadata display. |
| `ff_default_workdir` | `FF_DEFAULT_WORKDIR` | CLI / board management + create | InDev | `false` | KDI-015 | Board default task workspace; `boards set-default-workdir`; create inheritance and `--workspace`. |

## Lifecycle Notes

### `ff_created_by` — InDev

- **Owner:** kdi core team
- **BRD:** [BRD-KDI-007](brd-kdi-007-created-by.md)
- **Status transitions:**
  - `InDev` → `Active` when creator tracking is safe to enable by default.
- **Activation criteria:**
  - `create --created-by` stores and displays the creator.
  - `list --created-by` filters tasks by creator.
  - `show` displays the creator when the flag is enabled.
- **Rollback / deactivation:** Set `FF_CREATED_BY=false` to hide creator fields and reject creator options.
- **Deprecation plan:** N/A

### `ff_board_rm_delete` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-012c
- **Status transitions:**
  - `InDev` → `Active` when permanent board deletion is safe to enable by default.
- **Activation criteria:**
  - `boards rm <slug> --delete` removes the board row and recursively deletes the board data directory.
  - Without the flag, `--delete` is rejected with a clear error.
- **Rollback / deactivation:** Set `FF_BOARD_RM_DELETE=false` to reject `--delete` and keep soft-archive as the only removal path.
- **Deprecation plan:** N/A

### `ff_scheduled_status` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-002
- **Status transitions:**
  - `InDev` → `Active` when scheduling commands are safe to enable by default.
- **Activation criteria:**
  - `schedule` and `unblock` commands validate scheduled_at.
  - `create --initial-status scheduled` requires `--at`.
- **Rollback / deactivation:** Set `FF_SCHEDULED_STATUS=false` to disable scheduling commands.

### `ff_review_status` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-003
- **Status transitions:**
  - `InDev` → `Active` when review command is safe to enable by default.
- **Activation criteria:**
  - `review` command transitions tasks to `review` status.
- **Rollback / deactivation:** Set `FF_REVIEW_STATUS=false` to disable review command.

### `ff_complete_metadata` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-005
- **Status transitions:**
  - `Planned` → `InDev` when `--metadata` option is implemented.
- **Activation criteria:**
  - `complete --metadata <json>` stores metadata on completion.
  - Event payload correctly deserializes metadata.
- **Rollback / deactivation:** Set `FF_COMPLETE_METADATA=false` to hide/gate the `--metadata` option.
- **Deprecation plan:** N/A

### `ff_priority_integer` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-004
- **Status transitions:**
  - `Planned` → `InDev` when integer priority validation is implemented (done).
- **Schema note:** Integer priority is a schema-level change (migration) — this flag is advisory for feature rollout; the schema migration always runs.
- **Activation criteria:**
  - `create --priority` rejects non-integer values when flag is enabled.
  - CLI help documents priority as integer only.
- **Rollback / deactivation:** Set `FF_PRIORITY_INTEGER=false` (disables integer validation; basic number validation still applies).
- **Deprecation plan:** N/A

### `ff_tenant_namespace` — InDev

- **Owner:** kdi core team
- **BRD:** [BRD-KDI-006](brd-006-tenant-namespace.md)
- **Status transitions:**
  - `Planned` → `InDev` when tenant column and CLI options are implemented.
- **Schema note:** `tenant` is a schema-level TEXT column — this flag gates the CLI options; the schema migration always runs.
- **Activation criteria:**
  - `create --tenant <name>` stores tenant on the task.
  - `list --tenant <name>` filters tasks by tenant and composes with `--status` and `--assignee`.
  - `kdi show` displays the tenant when present.
- **Rollback / deactivation:** Set `FF_TENANT_NAMESPACE=false` to hide/gate the `--tenant` option.
- **Deprecation plan:** N/A

### `ff_skills_array` — InDev

- **Owner:** kdi core team
- **BRD:** [BRD-KDI-009](brd-kdi-009-skills-array.md)
- **Status transitions:**
  - `Planned` → `InDev` when skills array field and CLI option are implemented.
- **Schema note:** `skills` is a schema-level TEXT column (JSON array) — this flag gates the CLI option and dispatcher behavior; the schema migration always runs.
- **Activation criteria:**
  - `create --skill <skill>` can be repeated to build the task skills array.
  - `kdi show` displays skills as a comma-separated list.
  - Dispatcher substitutes `{{skills}}` in profile commands and sets `KDI_SKILLS` env var.
- **Rollback / deactivation:** Set `FF_SKILLS_ARRAY=false` to hide/gate the `--skill` option and dispatcher skill passing.
- **Deprecation plan:** N/A

### `ff_max_runtime` — InDev

- **Owner:** kdi core team
- **BRD:** [BRD-KDI-008](brd-kdi-008-max-runtime.md)
- **Status transitions:**
  - `Planned` → `InDev` when `max_runtime_seconds` column, `create --max-runtime`, and dispatcher enforcement are implemented.
- **Schema note:** `max_runtime_seconds` is a schema-level INTEGER column on `tasks` and `task_runs` — this flag gates the CLI option and dispatcher behavior; the schema migrations always run.
- **Activation criteria:**
  - `create --max-runtime <duration>` stores `max_runtime_seconds` on the task.
  - Dispatcher passes the cap as the harness timeout.
  - Timed-out runs are recorded with `outcome=timed_out` and the task is blocked.
- **Rollback / deactivation:** Set `FF_MAX_RUNTIME=false` to hide/gate the `--max-runtime` option.
- **Deprecation plan:** N/A

### `ff_model_override` — InDev

- **Owner:** kdi core team
- **BRD:** [BRD-KDI-010](brd-kdi-010-model-override.md)
- **Status transitions:**
  - `Planned` → `InDev` when `model_override` column, `create --model`, and dispatcher pass-through are implemented.
- **Schema note:** `model_override` is a schema-level TEXT column on `tasks` — this flag gates the CLI option and dispatcher behavior; the schema migration always runs.
- **Activation criteria:**
  - `create --model <model>` stores `model_override` on the task.
  - `kdi show` displays the model override when the flag is enabled.
  - Dispatcher substitutes `{{model}}` in profile commands and sets `KDI_MODEL` env var for the harness process.
- **Rollback / deactivation:** Set `FF_MODEL_OVERRIDE=false` to hide/gate the `--model` option and dispatcher model pass-through.
- **Deprecation plan:** N/A

### `ff_max_retries` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-011
- **Status transitions:**
  - `Planned` → `InDev` when `max_retries` and `consecutive_failures` columns, `create --max-retries`, and dispatcher circuit breaker are implemented.
- **Schema note:** `max_retries` and `consecutive_failures` are schema-level INTEGER columns on `tasks` — this flag gates the CLI option and dispatcher retry behavior; the schema migrations always run.
- **Activation criteria:**
  - `create --max-retries <n>` stores `max_retries` on the task.
  - Dispatcher requeues failed tasks up to `max_retries` consecutive failures, then blocks them.
  - Successful harness runs reset `consecutive_failures` to 0.
- **Rollback / deactivation:** Set `FF_MAX_RETRIES=false` to hide/gate the `--max-retries` option.
- **Deprecation plan:** N/A

### `ff_board_metadata` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-012
- **Status transitions:**
  - `Planned` → `InDev` when `boards` metadata columns and CLI options are implemented.
- **Schema note:** `name`, `icon`, and `color` are schema-level TEXT columns on `boards` — this flag gates the CLI options and display; the schema migrations always run.
- **Activation criteria:**
  - `boards create --name/--icon/--color` stores metadata on the board.
  - `boards edit` updates board metadata.
  - `boards show` and `boards list` display metadata when set.
- **Rollback / deactivation:** Set `FF_BOARD_METADATA=false` to hide/gate the `--name`, `--icon`, `--color`, and `boards edit` options.
- **Deprecation plan:** N/A

### `ff_default_workdir` — InDev

- **Owner:** kdi core team
- **BRD:** KDI-015
- **Status transitions:**
  - `Planned` → `InDev` when board default workdir storage and create inheritance are implemented.
- **Schema note:** `default_workdir` is a schema-level TEXT column on `boards`; task `workspace` is persisted so inherited/explicit workspaces can be used by the dispatcher. This flag gates the CLI command, `create --workspace`, and default inheritance.
- **Activation criteria:**
  - `boards set-default-workdir <slug> <path>` stores and displays the default workdir.
  - `boards set-default-workdir <slug>` clears the default workdir.
  - `create` inherits the board default when `--workspace` is omitted.
  - `create --workspace <path>` overrides the board default.
- **Rollback / deactivation:** Set `FF_DEFAULT_WORKDIR=false` to reject the command and prevent create from inheriting board defaults.
- **Deprecation plan:** N/A

### `ff_kanban_dispatch` — Planned

- **Owner:** kdi core team
- **BRD:** [BRD-KD-001](brd-kdi.md)
- **Status transitions:**
  - `Planned` → `InDev` when dispatcher module and first harness profile integration begin.
  - `InDev` → `Active` when dispatcher is safe to enable by default in production.
- **Activation criteria:**
  - Dispatcher claims ready tasks via CAS-style `ready → running` transition.
  - Harness profiles resolve from `~/.config/kdi/profiles.yaml`.
  - Worktree creation and command template substitution are covered by tests.
- **Rollback / deactivation:** Set `FF_ENABLE_KANBAN_DISPATCH=false` to stop the dispatcher loop while keeping board and task management commands available.
- **Deprecation plan:** N/A
