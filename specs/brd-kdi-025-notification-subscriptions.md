# BRD-KDI-025: Notification Subscriptions

> **Backlog reference:** Hermes Kanban `kanban_notify_subs` table + `notify-subscribe` / `notify-list` / `notify-unsubscribe` CLI commands + gateway notifier watcher
> **Priority:** P5 (Advanced)
> **Status:** Spec

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Enable operators and agents to subscribe to task events and receive
notifications via external messaging platforms (Telegram, Slack, Discord,
webhooks, etc.). This closes the observability loop so that task completions,
blockages, and failures are delivered where the team is already working, rather
than requiring active polling of the CLI.

The notification system is designed around three concepts:

1. **Subscription** — a persistent row linking a task, a delivery target
   (platform + chat), and a notifier profile.
2. **Notifier profile** — a named configuration in the profiles system that
   defines transport-specific settings (API tokens, webhook URLs, endpoint
   configuration).
3. **Delivery flow** — a gateway-notifier process that tails `task_events`,
   matches events against active subscriptions, and dispatches payloads via the
   configured notifier profile.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can subscribe to notifications for a specific task on a
   given platform/chat so I am alerted when events occur (e.g. completed,
   blocked, crashed).
2. As an operator, I can list all subscriptions (global or per-task) so I know
   where notifications are being delivered.
3. As an operator, I can unsubscribe from a specific task on a given
   platform/chat/thread so I stop receiving notifications without affecting
   other subscriptions.
4. As a gateway operator, I can register a notifier profile so subscriptions
   can reference a pre-configured transport with its API credentials.
5. As a gateway operator, I want the notifier watcher to run inside the
   dispatcher/gateway process so subscriptions are delivered automatically
   without a separate daemon.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------

### Subscription Model

- A subscription is a row in `kanban_notify_subs` that binds:
  - **task_id** (required) — the task to watch.
  - **platform** (required) — the messaging platform identifier
    (`telegram`, `slack`, `discord`, `webhook`, etc.).
  - **chat_id** (required) — the recipient identifier within the platform
    (chat ID, channel ID, webhook URL, etc.).
  - **thread_id** (optional) — a thread or topic within the chat for
    platforms that support threading (e.g. Telegram forum topics, Slack
    thread timestamps).
  - **user_id** (optional) — a specific user mention within the chat
    (e.g. `@username`, Discord user ID).
  - **notifier_profile** (required) — the name of a notifier profile that
    provides transport configuration.
- A subscription is **unique** on the combination of
  `(task_id, platform, chat_id, thread_id)`. Duplicate subscriptions are
  rejected with a clear error.
- Subscriptions can be created or removed. There is no "edit subscription"
  command — operators unsubscribe and re-subscribe with corrected parameters.

### Notifier Profile Concept

- Notifier profiles are named configurations stored in
  `~/.config/kdi/notifiers.yaml`.
- Each profile defines:
  - `name` — unique profile identifier (referenced by subscriptions).
  - `transport` — one of `telegram`, `slack`, `discord`, `webhook`.
  - `config` — transport-specific key/value settings (e.g. `bot_token`,
    `webhook_url`, `channel`).
- A notifier profile is validated at subscription time. If the profile does
  not exist, the subscribe command fails with a clear error.
- The notifier profile is owned/delivered by the gateway — it defines
  *how* to send the notification, not *where* (that is the subscription's
  platform + chat_id).

### CLI Commands

#### `kdi notify-subscribe <task_id> --platform <name> --chat-id <id> [--thread-id <id>] [--user-id <id>] [--notifier-profile <name>]`

- Creates a new subscription for the given task.
- `--platform` is required: one of `telegram`, `slack`, `discord`, `webhook`
  (case-insensitive).
- `--chat-id` is required: platform-specific recipient identifier.
- `--notifier-profile` defaults to the platform name (e.g. `--platform telegram`
  resolves to `notifier-profile telegram`).
- `--thread-id` and `--user-id` are optional refinements.
- Rejects if the task does not exist or is archived.
- Rejects if the notifier profile is not found in `notifiers.yaml`.
- Rejects duplicate subscriptions with a message pointing to the existing
  subscription.
- On success, prints the subscription ID and emits a `subscribed` event on
  the task's event stream.

#### `kdi notify-list [<task_id>]`

- Without `<task_id>`, lists all active (non-unsubscribed) subscriptions
  across all tasks on the current board.
- With `<task_id>`, lists only subscriptions for that specific task.
- Output format (table):
  ```
  ID   Task  Platform  Chat ID       Thread ID   Profile   Subscribed At
  1    42    telegram   -1001234567   topic/42     telegram  2026-06-13 10:00:00
  ```
- Includes a `--archived` flag to include unsubscribed subscriptions.
- Supports `--json` for machine-readable output.

#### `kdi notify-unsubscribe <task_id> --platform <name> --chat-id <id> [--thread-id <id>]`

- Marks matching active subscriptions as unsubscribed (`unsubscribed_at` set
  to current timestamp).
- Matching is done on the combination of
  `(task_id, platform, chat_id, thread_id)`:
  - If `--thread-id` is provided, only subscriptions matching that thread are
    unsubscribed.
  - If `--thread-id` is omitted, all subscriptions for the
    `(task_id, platform, chat_id)` tuple are unsubscribed (including those
    with any thread_id or NULL thread_id).
- At least one active subscription must match; otherwise the command exits
  with an error.
- Prints the number of unsubscribed rows and emits an `unsubscribed` event
  on the task's event stream.

### Event-to-Notification Delivery Flow

The delivery flow runs inside the dispatcher/gateway process as a background
coroutine (the "notifier watcher"). It does not require a separate daemon.

1. **Polling loop**: On each dispatcher tick (every ~5s by default), the
   notifier watcher queries `task_events` for events with `id > last_seen_event_id`
   that occurred on tasks with at least one active subscription on the current
   board.
2. **Event matching**: For each new event, query `kanban_notify_subs` for
   active (`unsubscribed_at IS NULL`) subscriptions matching the event's
   `task_id`.
3. **Payload construction**: Build a notification payload from the event:
   - Event kind (e.g. `completed`, `blocked`, `crashed`)
   - Task title and ID
   - Event payload (truncated if > 4 KiB)
   - Board slug
   - A formatted message string suitable for the target platform.
4. **Delivery dispatch**: For each subscription, call the notifier profile's
   transport handler with the payload, `chat_id`, `thread_id`, and `user_id`.
5. **Delivery outcome**: The transport handler returns success/failure.
   Failures are logged but do not block the tick loop or affect the task.
6. **Cursor advancement**: Advance `last_seen_event_id` to the max processed
   event ID, even if some deliveries failed (to avoid replay loops).

The notifier watcher is enabled only when `ff_notify_subs` is `true`.

### Thread-Scoped Unsubscription

When `--thread-id` is provided to `notify-unsubscribe`, the command targets
only subscriptions whose `thread_id` matches the given value (exact string
match). This allows operators to unsubscribe from a specific thread within a
chat while keeping other subscriptions for the same task + chat intact.

Example scenarios:
- `kdi notify-unsubscribe 42 --platform telegram --chat-id -100123 --thread-id topic/5`
  unsubscribes only the subscription for thread `topic/5` on task 42.
- `kdi notify-unsubscribe 42 --platform telegram --chat-id -100123`
  unsubscribes **all** subscriptions for task 42 on that chat (all threads).

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time for subscribe/list/unsubscribe remains sub-100ms for
  typical board sizes.
- Notification delivery is best-effort within the gateway tick. Delivery
  failures are logged; they do not affect task lifecycle.
- Event payloads delivered as notifications are truncated at 4 KiB to avoid
  oversized messages on chat platforms.
- Subscription uniqueness constraint prevents accidental duplicate
  subscriptions and doubles as an idempotency mechanism.
- Notifier profiles are validated at subscription time (fast fail), not at
  delivery time.
- No breaking change to existing CLI output or task lifecycle.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_notify_subs` registered in `src/flags.ts`:
  ```ts
  export const FF_NOTIFY_SUBS = "FF_NOTIFY_SUBS";
  registerFlag(FF_NOTIFY_SUBS, false);
  ```
- Env var form: `FF_NOTIFY_SUBS=false`.
- Defaults to `false` in every environment.
- All three CLI commands (`notify-subscribe`, `notify-list`,
  `notify-unsubscribe`) are rejected when the flag is disabled.
- The notifier watcher in the dispatcher/gateway does not run when the flag is
  disabled.
- The `kanban_notify_subs` table schema migration always runs (like other
  schema-level changes) — the flag gates the CLI and watcher only.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------

### New Table: `kanban_notify_subs`

```sql
CREATE TABLE IF NOT EXISTS kanban_notify_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT,
  notifier_profile TEXT NOT NULL,
  subscribed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  unsubscribed_at INTEGER,
  UNIQUE (task_id, platform, chat_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_notify_subs_task ON kanban_notify_subs(task_id);
CREATE INDEX IF NOT EXISTS idx_notify_subs_active
  ON kanban_notify_subs(task_id, unsubscribed_at);
```

### Design Notes

- `unsubscribed_at` is used instead of hard-deleting rows. This provides an
  audit trail of subscription history and allows `notify-list --archived` to
  show past subscriptions.
- The `UNIQUE` constraint covers `(task_id, platform, chat_id, thread_id)`.
  Because `thread_id` can be NULL, SQLite's NULL semantics (NULL is not equal
  to any value, including itself) means that multiple subscriptions with
  `thread_id = NULL` for the same task+platform+chat_id are **allowed** by the
  unique constraint. The application layer must enforce that at most one active
  subscription with `thread_id IS NULL` exists per `(task_id, platform, chat_id)`.
  This is handled by the `subscribe` model function using a `WHERE thread_id IS NULL`
  check before insert.
- Index `idx_notify_subs_active` covers the notifier watcher's common query
  pattern: find active subscriptions for a task.
- No changes to existing tables.

-------------------------------------------------------------------------------
Notifier Profile Schema (~/.config/kdi/notifiers.yaml)
-------------------------------------------------------------------------------
```yaml
# ~/.config/kdi/notifiers.yaml
notifiers:
  telegram:
    transport: telegram
    config:
      bot_token: ${TELEGRAM_BOT_TOKEN}
  slack:
    transport: slack
    config:
      webhook_url: ${SLACK_WEBHOOK_URL}
  discord:
    transport: discord
    config:
      webhook_url: ${DISCORD_WEBHOOK_URL}
  my-webhook:
    transport: webhook
    config:
      url: https://hooks.example.com/kdi-events
      secret: ${WEBHOOK_SECRET}
```

- File is loaded at startup by the same `ensureProfiles`-style mechanism.
- Environment variable references (`${VAR_NAME}`) are resolved at load time.
- Notifier profiles are validated on load: all required `config` keys per
  transport must be present and non-empty.
- A built-in `log` notifier profile is always available (writes notifications
  to stderr in JSON format) for debugging without an external platform.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi notify-subscribe <task_id> --platform <name> --chat-id <id>
  [--thread-id <id>] [--user-id <id>] [--notifier-profile <name>]`
- `kdi notify-list [<task_id>] [--archived] [--json]`
- `kdi notify-unsubscribe <task_id> --platform <name> --chat-id <id>
  [--thread-id <id>]`

All commands require `ff_notify_subs` to be enabled. Without the flag, every
command exits with "Notification subscriptions feature is not enabled." and
a non-zero exit code.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------

### `subscribe(taskId, platform, chatId, options)`

1. Verify the task exists and is not archived.
2. Verify the notifier profile exists in `notifiers.yaml`.
3. If `thread_id` is NULL, check that no active subscription exists for
   `(task_id, platform, chat_id)` with `thread_id IS NULL`.
   - If one exists, reject with "A subscription for this task + platform +
     chat already exists (no thread). Use --thread-id to add a thread-scoped
     subscription."
4. If `thread_id` is NOT NULL, check that no active subscription exists with
   the exact same `(task_id, platform, chat_id, thread_id)`.
   - If one exists, reject with "A subscription for this task + platform +
     chat + thread already exists."
5. Insert new row into `kanban_notify_subs`.
6. Emit a `subscribed` event on the task with payload:
   ```json
   { "platform": "telegram", "chat_id": "-1001234567", "thread_id": null }
   ```

### `listSubscriptions(taskId?)`

1. If `taskId` is provided: query active subs for that task.
2. If `taskId` is omitted: query active subs on the current board (JOIN tasks
   ON tasks.board_id = current board id).
3. Optionally include unsubscribed subs when `--archived` is set.
4. Return rows ordered by `subscribed_at DESC`.

### `unsubscribe(taskId, platform, chatId, threadId?)`

1. If `threadId` is provided: update `unsubscribed_at` on all active
   subscriptions matching `(task_id, platform, chat_id, thread_id)`.
2. If `threadId` is omitted: update `unsubscribed_at` on all active
   subscriptions matching `(task_id, platform, chat_id)` regardless of
   `thread_id`.
3. If zero rows were updated, exit with error "No active subscription found
   for the given parameters."
4. Emit an `unsubscribed` event on the task with payload:
   ```json
   { "platform": "telegram", "chat_id": "-1001234567", "thread_id": null, "count": 2 }
   ```

-------------------------------------------------------------------------------
Event-to-Notification Delivery Flow (Detailed)
-------------------------------------------------------------------------------

### Notifier Watcher (inside dispatcher tick)

```
1. last_seen_event_id ← read the persisted cursor or 0
2. SELECT e.id, e.task_id, e.kind, e.payload, e.created_at
   FROM task_events e
   WHERE e.id > ?
   ORDER BY e.id ASC
3. For each event row:
   a. SELECT s.id, s.platform, s.chat_id, s.thread_id, s.user_id, s.notifier_profile
      FROM kanban_notify_subs s
      WHERE s.task_id = ? AND s.unsubscribed_at IS NULL
   b. If no subscriptions: skip to next event.
   c. Build notification message from event kind + task title + payload.
   d. For each subscription:
      i.   Look up notifier profile config from in-memory registry.
      ii.  Format message for target transport.
      iii. Send via transport handler.
      iv.  Log success/failure (no retry).
   e. last_seen_event_id = e.id
4. Persist last_seen_event_id for resume after restart.
```

### Transport Handlers

Each transport implements an async `send(profile, options)` function:
- `sendTelegram(profile, { chatId, threadId, text })` — calls
  `https://api.telegram.org/bot<token>/sendMessage`.
- `sendSlack(profile, { chatId, text })` — POSTs to Slack webhook URL with
  the chat_id as channel override.
- `sendDiscord(profile, { chatId, text })` — POSTs to Discord webhook URL.
- `sendWebhook(profile, { chatId, text })` — POSTs JSON payload to the
  configured URL, using `chat_id` as a header or body field.
- `sendLog(profile, { taskId, kind, text })` — writes to stderr in JSON format
  (always available for debugging).

All transport handlers are **best-effort**: failures are logged at `warn` level
and do not propagate errors to the tick loop.

### Message Format

A notification message is a plain-text summary (Markdown-lite for platforms
that support it):

```
🔔 [<board-slug>] Task #<task-id>: <title>
Status: <event-kind>
<event-payload-summary>
```

The first 4 KiB of the payload are included. Payloads exceeding 4 KiB are
truncated with `… (truncated)` appended.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- New event kind: `subscribed`.
- Payload shape:
  ```json
  { "platform": "telegram", "chat_id": "-1001234567", "thread_id": null }
  ```
- New event kind: `unsubscribed`.
- Payload shape:
  ```json
  { "platform": "telegram", "chat_id": "-1001234567", "thread_id": null, "count": 2 }
  ```

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 42 --platform telegram --chat-id -1001234567`
      creates a subscription, prints the subscription ID, and emits a
      `subscribed` event on task 42.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 42 --platform telegram --chat-id -1001234567`
      with an existing identical subscription rejects with "A subscription for
      this task + platform + chat already exists."
- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 42 --platform telegram --chat-id -1001234567 --thread-id topic/42`
      creates a thread-scoped subscription separate from the no-thread one.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 42 --platform unknown --chat-id x`
      rejects with "Unsupported platform. Valid platforms: telegram, slack,
      discord, webhook."
- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 42 --platform telegram --chat-id -1001234567 --notifier-profile nonexistent`
      rejects with "Notifier profile 'nonexistent' not found."
- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 99999 --platform telegram --chat-id -1001234567`
      rejects with "Task 99999 not found."
- [ ] `FF_NOTIFY_SUBS=true kdi notify-list` shows all active subscriptions
      on the current board (table format).
- [ ] `FF_NOTIFY_SUBS=true kdi notify-list 42` shows only subscriptions for
      task 42.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-list --archived` includes unsubscribed
      subscriptions.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-list --json` emits a JSON array.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-unsubscribe 42 --platform telegram --chat-id -1001234567 --thread-id topic/42`
      unsubscribes only the thread-scoped subscription, leaving others intact.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-unsubscribe 42 --platform telegram --chat-id -1001234567`
      without `--thread-id` unsubscribes ALL subscriptions for that task+chat.
- [ ] `FF_NOTIFY_SUBS=true kdi notify-unsubscribe 42 --platform telegram --chat-id -nonexistent`
      with no matching subscription exits with "No active subscription found."
- [ ] After unsubscription, `kdi notify-list` no longer shows the unsubscribed
      entries (unless `--archived` is used).
- [ ] When an event is emitted on a subscribed task, the notifier watcher
      delivers a notification via the configured transport.
- [ ] `log` notifier profile always available; subscribing with
      `--notifier-profile log` delivers notifications to stderr.
- [ ] `FF_NOTIFY_SUBS=false kdi notify-subscribe 42 --platform telegram --chat-id -1001234567`
      exits with "Notification subscriptions feature is not enabled."
- [ ] `FF_NOTIFY_SUBS=false kdi notify-list` exits with the same gating error.
- [ ] `FF_NOTIFY_SUBS=false kdi notify-unsubscribe 42 --platform telegram --chat-id -1001234567`
      exits with the same gating error.
- [ ] `FF_NOTIFY_SUBS=false` — the notifier watcher does not run; task events
      are delivered only to subscribers when the flag is re-enabled.
- [ ] Unit and CLI tests cover subscribe, list, unsubscribe, uniqueness
      enforcement, thread-scoped operations, notifier-profile validation,
      flag gating, and the notifier watcher loop.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** The notifier watcher runs inside the dispatcher tick loop. A slow
  or misconfigured transport (e.g. unreachable webhook) could stall the entire
  tick, delaying task claims and lifecycle transitions.
  **Mitigation:** Transport handlers use non-blocking HTTP with a 5-second
  timeout. Delivery errors are logged and swallowed — they never propagate to
  the tick loop. Polling cursor advancement happens regardless of delivery
  outcome.
- **Risk:** The `UNIQUE` constraint on `(task_id, platform, chat_id, thread_id)`
  allows multiple NULL-thread subscriptions due to SQLite's NULL != NULL
  semantics.
  **Mitigation:** The application layer explicitly checks for existing NULL-
  thread subscriptions before insert, as specified in the model behavior.
- **Risk:** Notifier profiles contain API tokens and secrets. Storing them in
  `~/.config/kdi/notifiers.yaml` with environment variable references may leak
  secrets if the file is world-readable.
  **Mitigation:** Document that `notifiers.yaml` must be `chmod 600`.
  Environment variable resolution keeps secrets out of the file itself.
- **Open question:** Should the notifier watcher run on a separate timer from
  the dispatcher tick (e.g., 10s vs 5s)?
  **Resolution:** For simplicity, run on the same tick interval. If operational
  data shows the watcher is too chatty or too slow, decouple the intervals in a
  follow-up.
- **Open question:** Should subscriptions support event-kind filtering
  (e.g. only `completed` and `crashed` events)?
  **Out of scope for KDI-025.** All events on a subscribed task are delivered.
  Event-kind filtering can be added as a future enhancement.
- **Open question:** What happens to subscriptions when the referenced task is
  archived or deleted?
  **Resolution:** Subscriptions remain in the database (as audit trail).
  The notifier watcher skips events for tasks that are archived.
  Unsubscription is manual, or a follow-up `gc` enhancement can clean up
  orphaned subscriptions.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/notifySub.ts` — new model file for subscription CRUD.
- `src/commands/notify.ts` — new command file for notify-subscribe/list/unsubscribe.
- `src/notifiers.ts` — new module: notifier profile registry, YAML loader,
  transport handlers, notifier watcher loop function.
- `src/flags.ts` — `FF_NOTIFY_SUBS` constant and registration.
- `src/db.ts` — `kanban_notify_subs` table schema + migration.
- `src/index.ts` — wire `notifySubCommand`, `notifyListCommand`,
  `notifyUnsubscribeCommand` into the CLI.
- `src/dispatcher.ts` — integrate notifier watcher into the tick loop
  (gated by `FF_NOTIFY_SUBS`).
- `specs/feature-flags.md` — register `ff_notify_subs`.
