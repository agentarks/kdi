# BRD-KDI-035: `kdi watch` Filters

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Let operators narrow the board-wide `kdi watch` event stream to only the tasks
and event kinds they care about. Without filters, `watch` streams every event
in the database; with filters, operators can follow a single assignee, tenant,
or event kind and tune the poll interval to their needs.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can follow events for tasks assigned to a specific
   profile with `kdi watch --assignee <profile>`.
2. As an operator, I can follow events for tasks in a specific tenant with
   `kdi watch --tenant <name>`.
3. As an operator, I can follow only selected event kinds with
   `kdi watch --kinds <kind1>,<kind2>`.
4. As an operator, I can change the poll interval with
   `kdi watch --interval <seconds>`.
5. As an operator, I can combine filters (e.g. assignee + kinds) to follow a
   specific agent's lifecycle events.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi watch` without options retains its current behavior: prints the 50 most
  recent events, then polls every 500ms for new events.
- `kdi watch --assignee <profile>` streams only events for tasks whose
  `tasks.assignee` equals `<profile>`.
- `kdi watch --tenant <name>` streams only events for tasks whose
  `tasks.tenant` equals `<name>`.
- `kdi watch --kinds <kind1>,<kind2>,...` streams only events whose
  `task_events.kind` is in the supplied list.
- `kdi watch --interval <seconds>` changes the polling sleep. Default is `0.5`.
  Accepts decimal values (e.g. `0.1`, `2`, `5.5`).
- Filters compose with logical AND. `--assignee opencode --kinds claimed,completed`
  shows only `claimed` and `completed` events for tasks assigned to `opencode`.
- Output format is unchanged: one line per event with
  `<task_id>\t<kind>\t<ISO8601 timestamp>`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for the initial 50-event query on boards
  with up to 10,000 events.
- No breaking change to unfiltered `kdi watch`.
- Filtered queries must use parameterized SQL; no string interpolation of user
  input.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_watch_filters` registered in `src/flags.ts`:
  ```ts
  export const FF_WATCH_FILTERS = "FF_WATCH_FILTERS";
  registerFlag(FF_WATCH_FILTERS, false);
  ```
- Env var form: `FF_WATCH_FILTERS=false`.
- Defaults to `false` in every environment.
- The new options (`--assignee`, `--tenant`, `--kinds`, `--interval`) are
  rejected when `ff_watch_filters` is disabled.
- `--tenant` additionally requires `ff_tenant_namespace` to be enabled,
  consistent with `create --tenant` and `list --tenant`.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing
`task_events` and `tasks` tables and uses the existing `idx_tasks_assignee` and
`idx_tasks_tenant` indexes. Optionally add an index on `task_events(kind)` if
profiling shows `kind`-only filters are a hotspot.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi watch` — unfiltered board-wide event stream (poll 0.5s, seed 50).
- `kdi watch --assignee <profile>` — filter by task assignee.
- `kdi watch --tenant <name>` — filter by task tenant (requires
  `FF_TENANT_NAMESPACE`).
- `kdi watch --kinds <kind1>,<kind2>` — filter by event kind(s).
- `kdi watch --interval <seconds>` — override poll interval.
- Options may be combined:
  `kdi watch --assignee opencode --kinds claimed,completed --interval 1`

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. Define a `WatchFilters` type:
   ```ts
   type WatchFilters = {
     assignee?: string;
     tenant?: string;
     kinds?: string[];
   };
   ```
2. Extend `getRecentEvents(limit, filters?)` and `getEventsAfter(sinceId, filters?)`
   in `src/models/taskEvent.ts` to accept an optional `WatchFilters` object.
3. Build the query dynamically:
   - When `assignee` or `tenant` is supplied, `JOIN task_events e ON tasks t`
     using `t.id = e.task_id`.
   - `assignee` filter: `t.assignee = ?`.
   - `tenant` filter: `t.tenant = ?`.
   - `kinds` filter: `e.kind IN (?, ?, ...)` with one placeholder per kind.
4. The `sinceId`/`id > ?` predicate is always present in `getEventsAfter`.
   The `ORDER BY e.id DESC LIMIT ?` predicate is always present in
   `getRecentEvents`.
5. Return the same `TaskEvent[]` shape as the unfiltered helpers.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
1. Parse options with Commander:
   - `--assignee <profile>`: store trimmed string.
   - `--tenant <name>`: store trimmed string.
   - `--kinds <list>`: split on `,`, trim whitespace, reject empty list.
   - `--interval <seconds>`: parse as float, reject non-numeric, zero, or
     negative values; reject values below `0.1` to prevent accidental busy
     loops.
2. If any new option is supplied and `FF_WATCH_FILTERS` is disabled, exit with
   `"Watch filters feature is not enabled."`
3. If `--tenant` is supplied and `FF_TENANT_NAMESPACE` is disabled, exit with
   `"Tenant namespace feature is not enabled."`
4. Reject empty `--assignee ""`, empty `--tenant ""`, and empty `--kinds ""`.
5. Convert interval seconds to milliseconds for the polling sleep.
6. Seed with `getRecentEvents(50, filters)` and stream with
   `getEventsAfter(maxId, filters)`.

-------------------------------------------------------------------------------
Filtering Behavior and Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| `kdi watch` (no options) | Streams all events exactly as before. |
| `--assignee opencode` on tasks with no assignee | No events emitted; stream stays quiet until a matching task changes. |
| `--tenant alpha` | Only events for tasks whose `tenant = 'alpha'`. |
| `--kinds created,completed` | Only events with `kind = 'created'` or `kind = 'completed'`. |
| `--kinds` with whitespace `created, completed` | Trimmed to `['created', 'completed']`. |
| `--kinds` empty string | Rejected: "Kinds cannot be empty." |
| `--interval 0` | Rejected: "Interval must be at least 0.1 seconds." |
| `--interval not-a-number` | Rejected: "Interval must be a positive number." |
| Combined filters | AND semantics; all supplied filters must match. |
| Unknown event kind | No error; simply returns no matching events. |
| Case sensitivity | Kinds are matched case-sensitively against `task_events.kind`. |
| Archived tasks | Events for archived tasks are still included if they match the filters (soft archive; task row still exists). |

-------------------------------------------------------------------------------
Test Plan
-------------------------------------------------------------------------------
### Unit tests (`tests/models/taskEvent.test.ts`)
- `getRecentEvents` returns unfiltered events when no filters are passed.
- `getRecentEvents` filters by assignee.
- `getRecentEvents` filters by tenant.
- `getRecentEvents` filters by kinds.
- `getRecentEvents` combines assignee + kinds filters.
- `getEventsAfter` returns only events after `sinceId` that match filters.
- Kinds with extra whitespace are trimmed (tested at model layer if parsing
  happens there, otherwise at CLI layer).

### CLI / integration tests (`tests/commands/tasks.test.ts` or new
### `tests/commands/watch.test.ts`)
- `FF_WATCH_FILTERS=true kdi watch --assignee <profile>` streams only matching
  events.
- `FF_WATCH_FILTERS=true kdi watch --tenant <name>` streams only matching
  events when `FF_TENANT_NAMESPACE=true`.
- `FF_WATCH_FILTERS=true kdi watch --kinds created,completed` streams only
  matching kinds.
- `FF_WATCH_FILTERS=true kdi watch --interval 0.1` polls at 100ms.
- `FF_WATCH_FILTERS=true` with combined filters applies AND semantics.
- `FF_WATCH_FILTERS=false kdi watch --assignee x` exits with the feature
  disabled error.
- `FF_WATCH_FILTERS=true` but `FF_TENANT_NAMESPACE=false kdi watch --tenant x`
  exits with the tenant namespace disabled error.
- Empty assignee, empty tenant, empty kinds, and invalid interval are rejected.

### Observability tests
- Unfiltered `kdi watch` output format is unchanged.
- Polling loop exits cleanly on `SIGINT` (existing behavior preserved).

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_WATCH_FILTERS=true kdi watch --assignee opencode` streams only events
      for tasks assigned to `opencode`.
- [ ] `FF_WATCH_FILTERS=true kdi watch --tenant alpha` streams only events for
      tasks in tenant `alpha` (requires `FF_TENANT_NAMESPACE=true`).
- [ ] `FF_WATCH_FILTERS=true kdi watch --kinds created,completed` streams only
      `created` and `completed` events.
- [ ] `FF_WATCH_FILTERS=true kdi watch --interval 1` polls once per second.
- [ ] Combined filters apply AND semantics.
- [ ] `kdi watch` without options behaves exactly as before.
- [ ] `FF_WATCH_FILTERS=false kdi watch --assignee x` exits with
      "Watch filters feature is not enabled."
- [ ] `FF_WATCH_FILTERS=true FF_TENANT_NAMESPACE=false kdi watch --tenant x`
      exits with "Tenant namespace feature is not enabled."
- [ ] Empty `--assignee`, empty `--tenant`, empty `--kinds`, and invalid
      `--interval` are rejected with clear errors.
- [ ] Unit and CLI tests cover filtering, combinations, flag gating, and edge
      cases.
- [ ] `bun run lint`, `bun run test`, and `bun run build` pass.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Dynamic `IN (...)` clauses for `--kinds` could complicate query
  caching. **Mitigation:** Use parameterized placeholders and keep the query
  builder small and test-covered.
- **Risk:** Very short `--interval` values could increase SQLite load. **Mitigation:**
  enforce a 0.1s floor and document the default.
- **Open question:** Should `kdi watch` accept a `--board` filter in addition to
  assignee/tenant? Out of scope for KDI-035; the current command is global by
  design.
- **Open question:** Should kinds be case-insensitive? This BRD specifies case-
  sensitive exact matching to align with how event kinds are emitted in the
  codebase (lowercase). If operators request case-insensitive matching, revisit
  in a follow-up.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/commands/tasks.ts` (`watchCommand`).
- `src/models/taskEvent.ts` (`getRecentEvents`, `getEventsAfter`).
- `src/models/task.ts` (indirectly, via `tasks` table columns).
- `src/flags.ts` (`FF_WATCH_FILTERS`, `FF_TENANT_NAMESPACE`).

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a new section under the feature list:

```markdown
## `kdi watch` Filters (KDI-035) — In Progress
- [ ] BRD drafted at `specs/brd-kdi-035-watch-filters.md`
- [ ] Feature flag `ff_watch_filters` / `FF_WATCH_FILTERS` registered in
      `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [ ] `kdi watch [--assignee <profile>] [--tenant <name>]
      [--kinds <kind1>,<kind2>] [--interval <seconds>]` implemented
- [ ] `--tenant` additionally gated by `FF_TENANT_NAMESPACE`
- [ ] `getRecentEvents` and `getEventsAfter` accept optional `WatchFilters`
- [ ] Unit/CLI tests cover filters, combinations, flag gating, and edge cases
- [ ] `bun run lint`, `bun run test`, `bun run build` pass
```

Also update the Task Events line in the Task Lifecycle section to mention the
new filter options:
```markdown
- [x] `kdi watch` — board-wide event stream (poll 0.5s) with optional
      `--assignee`, `--tenant`, `--kinds`, and `--interval` filters (KDI-035)
```
