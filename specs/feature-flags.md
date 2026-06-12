# Feature Flags Registry

This document is the single source of truth for all `ff_*` feature flags in `kdi`.

## Conventions

- Every new feature is gated behind an `ff_*` flag registered here before implementation.
- CLI / server environment variable form: `FF_ENABLE_<FEATURE>=false`
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
| `ff_complete_metadata` | `FF_COMPLETE_METADATA` | CLI / complete | Planned | `false` | KDI-005 | Gate the complete --metadata payload path. |
| `ff_kanban_dispatch` | `FF_ENABLE_KANBAN_DISPATCH` | CLI / dispatcher | Planned | `false` | — | Background dispatcher loop that polls ready tasks and spawns harness profiles. |
| `ff_scheduled_status` | `FF_SCHEDULED_STATUS` | CLI / task lifecycle | InDev | `false` | KDI-002 | Scheduled status, schedule/unblock commands, and scheduled_at field. |
| `ff_review_status` | `FF_REVIEW_STATUS` | CLI / task lifecycle | InDev | `false` | KDI-002 | Review status and review command. |

## Lifecycle Notes

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
- **BRD:** KDI-002
- **Status transitions:**
  - `InDev` → `Active` when review command is safe to enable by default.
- **Activation criteria:**
  - `review` command transitions tasks to `review` status.
- **Rollback / deactivation:** Set `FF_REVIEW_STATUS=false` to disable review command.

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
