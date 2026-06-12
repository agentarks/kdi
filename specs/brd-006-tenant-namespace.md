# KDI-006: Tenant Namespace

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow operators to partition tasks within a board into named namespaces
("tenants") so that multi-agent workflows can be filtered and reasoned about
by organizational boundary (team, subsystem, domain, etc.) without requiring
separate boards.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can tag a task with a tenant namespace when creating it.
2. As an operator, I can list only tasks belonging to a specific tenant.
3. As an operator, I can see a task's tenant namespace in task details.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- FR-01: Tasks store an optional `tenant TEXT` column.
- FR-02: `kdi create --tenant <name>` stores the tenant on the task.
- FR-03: `kdi list --tenant <name>` returns only tasks with that tenant.
- FR-04: `kdi show <task_id>` displays the tenant when present.
- FR-05: Tenant filtering composes with existing `--status` and `--assignee`
  filters.
- FR-06: Tenant namespace is gated by feature flag `FF_TENANT_NAMESPACE`.
  When disabled, `--tenant` on create/list is rejected with a clear error.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- Sub-100ms CLI response for filtered listings.
- SQLite index on `(board_id, tenant)` for efficient tenant-scoped queries.
- Backward compatible: existing tasks have `tenant = NULL`.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `FF_TENANT_NAMESPACE` — gates `--tenant` options on create and list.
- Registered in `specs/feature-flags.md`.
- Defaults to `false` in all environments.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] AC-01: `kdi create "backend task" --board myproj --tenant backend`
      stores tenant `backend` and returns a task ID.
- [ ] AC-02: `kdi list --board myproj --tenant backend` shows only tasks with
      tenant `backend`.
- [ ] AC-03: `kdi show <task_id>` includes `Tenant: backend` for tenant tasks.
- [ ] AC-04: `kdi list --board myproj --tenant backend --status ready` composes
      tenant and status filters.
- [ ] AC-05: With `FF_TENANT_NAMESPACE=false`, `kdi create --tenant backend`
      exits with an error.
- [ ] AC-06: Tasks created without `--tenant` have `tenant = NULL` and appear
      in `kdi list --board myproj` (no tenant filter).

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- Risk: Tenant column is nullable but callers may assume every task has one.
  Mitigation: Display and filters treat NULL as "no tenant"; list default
  remains unfiltered.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- None. Builds on existing task CRUD and feature-flag infrastructure.
