# KDI-025 Notification Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement notification subscriptions (`kdi notify-subscribe`, `kdi notify-list`, `kdi notify-unsubscribe`) plus a dispatcher-integrated notifier watcher that delivers task events via configured notifier profiles.

**Architecture:** Add a feature-gated `kanban_notify_subs` table, a notifier profile registry loaded from `~/.config/kdi/notifiers.yaml`, subscription CRUD in `src/models/notifySub.ts`, CLI commands in `src/commands/notify.ts`, transport handlers and watcher in `src/notifiers.ts`, and watcher integration in `src/dispatcher.ts`.

**Tech Stack:** TypeScript, Bun, SQLite (`bun:sqlite`), Commander, YAML.

---

## File map

- `src/flags.ts` — add and register `FF_NOTIFY_SUBS`.
- `src/db.ts` — add `kanban_notify_subs` table schema + migration.
- `src/models/notifySub.ts` — new model: `subscribe`, `listSubscriptions`, `unsubscribe`.
- `src/notifiers.ts` — new module: profile registry, transport handlers, notifier watcher.
- `src/commands/notify.ts` — new command file for subscribe/list/unsubscribe.
- `src/index.ts` — wire the three notify commands.
- `src/dispatcher.ts` — call notifier watcher each tick when flag enabled.
- `tests/notifySub.test.ts` — model + CLI tests.
- `tests/notifiers.test.ts` — transport handler + watcher tests.
- `specs/feature-flags.md` — register `ff_notify_subs`.
- `STATUS.md` — mark KDI-025 done.

---

## Task 1: Feature flag and schema

**Files:**
- Modify: `src/flags.ts`
- Modify: `src/db.ts`
- Modify: `specs/feature-flags.md`

- [ ] **Step 1: Add the flag constant and registration**

  In `src/flags.ts`:
  ```ts
  export const FF_NOTIFY_SUBS = "FF_NOTIFY_SUBS";
  registerFlag(FF_NOTIFY_SUBS, false);
  ```

- [ ] **Step 2: Add schema migration**

  In `src/db.ts`:
  1. Add the table to `SCHEMA`:
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
     CREATE INDEX IF NOT EXISTS idx_notify_subs_active ON kanban_notify_subs(task_id, unsubscribed_at);
     ```
  2. Add an idempotent migration block at the end of `initDb` (after existing migrations) that creates the table/indexes if missing, gated only by `IF NOT EXISTS`.

- [ ] **Step 3: Register in `specs/feature-flags.md`**

  Add registry row and lifecycle notes for `ff_notify_subs`.

- [ ] **Step 4: Verify lint and schema tests**

  Run:
  ```bash
  bun run lint
  bun test ./tests/db.test.ts
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/flags.ts src/db.ts specs/feature-flags.md
  git commit -m "feat(kdi-025): register flag and kanban_notify_subs schema"
  ```

---

## Task 2: Notifier profile registry

**Files:**
- Create: `src/notifiers.ts` (partial — registry only)

- [ ] **Step 1: Write the failing registry test**

  Create `tests/notifiers.test.ts`:
  ```ts
  import { describe, expect, it, beforeEach, afterEach } from "bun:test";
  import { loadNotifiers, getNotifier, BUILTIN_LOG_NOTIFIER } from "../src/notifiers";
  // tests here
  ```

- [ ] **Step 2: Implement registry**

  In `src/notifiers.ts`:
  ```ts
  export interface NotifierProfile {
    name: string;
    transport: "telegram" | "slack" | "discord" | "webhook";
    config: Record<string, string>;
  }

  function defaultNotifiersPath(): string {
    return process.env.KDI_NOTIFIERS_PATH || join(homedir(), ".config/kdi/notifiers.yaml");
  }

  export const BUILTIN_LOG_NOTIFIER: NotifierProfile = {
    name: "log",
    transport: "log",
    config: {},
  };

  export function ensureNotifiers(path: string = defaultNotifiersPath()): void { ... }
  export function loadNotifiers(path: string = defaultNotifiersPath()): NotifierProfile[] { ... }
  export function getNotifier(name: string, path?: string): NotifierProfile { ... }
  ```

  Requirements:
  - `ensureNotifiers` writes a default `notifiers.yaml` (with `telegram`, `slack`, `discord`, `webhook` examples using `${VAR}` placeholders) only if file does not exist.
  - `loadNotifiers` parses YAML `notifiers:` object or array. Each profile must have `name`, `transport`, and `config`. Validate transport is one of `telegram`, `slack`, `discord`, `webhook`. Resolve `${ENV_VAR}` references in config values. Always include `BUILTIN_LOG_NOTIFIER`.
  - `getNotifier` throws `"Notifier profile '<name>' not found."` when missing.

- [ ] **Step 3: Run registry tests**

  Run:
  ```bash
  bun test ./tests/notifiers.test.ts
  ```
  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/notifiers.ts tests/notifiers.test.ts
  git commit -m "feat(kdi-025): notifier profile registry with log builtin"
  ```

---

## Task 3: Subscription CRUD model

**Files:**
- Create: `src/models/notifySub.ts`

- [ ] **Step 1: Write the failing model test**

  Create `tests/notifySub.test.ts`:
  ```ts
  import { describe, expect, it, beforeEach, afterEach } from "bun:test";
  import { subscribe, listSubscriptions, unsubscribe } from "../src/models/notifySub";
  import { createBoard } from "../src/models/board";
  import { createTask } from "../src/models/task";
  import { initDb } from "../src/db";
  import { rmSync } from "node:fs";

  describe("notify subscriptions", () => {
    const dbPath = `/tmp/kdi-notify-test-${Date.now()}.db`;
    beforeEach(() => { process.env.KDI_DB = dbPath; initDb(dbPath); });
    afterEach(() => { delete process.env.KDI_DB; try { rmSync(dbPath); } catch {} });

    it("subscribes to a task", () => {
      const board = createBoard("nb", "/tmp/nb");
      const task = createTask({ board_id: board.id, title: "t" });
      const sub = subscribe(task.id, "telegram", "-1001", { notifierProfile: "log" });
      expect(sub.platform).toBe("telegram");
    });
  });
  ```

- [ ] **Step 2: Implement subscription model**

  Create `src/models/notifySub.ts`:
  ```ts
  export interface NotifySub {
    id: number;
    task_id: number;
    platform: string;
    chat_id: string;
    thread_id: string | null;
    user_id: string | null;
    notifier_profile: string;
    subscribed_at: number;
    unsubscribed_at: number | null;
  }

  export interface SubscribeOptions {
    threadId?: string;
    userId?: string;
    notifierProfile?: string;
  }

  export function subscribe(taskId: number, platform: string, chatId: string, options: SubscribeOptions = {}): NotifySub { ... }
  export function listSubscriptions(taskId?: number, includeArchived?: boolean): NotifySub[] { ... }
  export function unsubscribe(taskId: number, platform: string, chatId: string, threadId?: string): number { ... }
  ```

  Requirements:
  - `subscribe`: lowercase platform; verify task exists and not archived; verify notifier profile exists via `getNotifier`; enforce uniqueness per BRD (handle NULL thread_id specially); emit `subscribed` event via `addEvent`.
  - `listSubscriptions`: if `taskId` provided, filter by task; otherwise join to tasks on current board (requires board id from `resolveBoard`? No — model should accept `boardId`). Actually, the model should accept `boardId?: number`. CLI will resolve board and pass board id.
  - `unsubscribe`: update `unsubscribed_at`; thread-scoped or all matching; error if zero rows; emit `unsubscribed` event with count.

- [ ] **Step 3: Run model tests**

  Run:
  ```bash
  bun test ./tests/notifySub.test.ts
  ```
  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add src/models/notifySub.ts tests/notifySub.test.ts
  git commit -m "feat(kdi-025): subscription CRUD model with events"
  ```

---

## Task 4: Notify CLI commands

**Files:**
- Create: `src/commands/notify.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing CLI tests**

  Add to `tests/notifySub.test.ts` or create `tests/commands/notify.test.ts`. Test:
  - subscribe creates sub and emits event.
  - duplicate rejection messages match BRD.
  - invalid platform rejection.
  - missing notifier profile rejection.
  - list active/archived/json.
  - unsubscribe thread-scoped and broad.
  - flag disabled error.

- [ ] **Step 2: Implement commands**

  Create `src/commands/notify.ts` with three commands:
  - `notifySubscribeCommand`
  - `notifyListCommand`
  - `notifyUnsubscribeCommand`

  All gates via `FF_NOTIFY_SUBS`. Board resolved via `resolveBoard`. Platform validation: `telegram`, `slack`, `discord`, `webhook` (case-insensitive). Default notifier profile to lowercased platform name if omitted. Output formats match BRD (table, `--json`, `--archived`).

- [ ] **Step 3: Wire into `src/index.ts`**

  Import and `program.addCommand` for all three.

- [ ] **Step 4: Run CLI tests**

  Run:
  ```bash
  bun test ./tests/notifySub.test.ts
  bun run lint
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/commands/notify.ts src/index.ts tests/notifySub.test.ts
  git commit -m "feat(kdi-025): notify-subscribe/list/unsubscribe CLI"
  ```

---

## Task 5: Transport handlers and notifier watcher

**Files:**
- Modify: `src/notifiers.ts`

- [ ] **Step 1: Implement transport handlers**

  Add to `src/notifiers.ts`:
  ```ts
  export interface NotificationPayload {
    boardSlug: string;
    taskId: number;
    title: string;
    eventKind: string;
    eventPayload: Record<string, any> | null;
    text: string;
  }

  export async function sendNotification(
    profile: NotifierProfile,
    sub: Pick<NotifySub, "chat_id" | "thread_id" | "user_id">,
    payload: NotificationPayload
  ): Promise<void> { ... }
  ```

  Implement:
  - `log` transport: write JSON to `process.stderr`.
  - `telegram`, `slack`, `discord`, `webhook`: best-effort async HTTP with 5s timeout. Swallow errors and log warn.

- [ ] **Step 2: Implement notifier watcher**

  Add to `src/notifiers.ts`:
  ```ts
  export async function runNotifierWatcher(boardSlug: string, lastSeenId: number): Promise<number> { ... }
  export function getLastSeenEventId(boardSlug: string): number { ... }
  export function setLastSeenEventId(boardSlug: string, id: number): void { ... }
  ```

  Cursor persistence: store in a simple JSON file under `~/.local/share/kdi/notifier-cursors/<boardSlug>.json`.

  Watcher logic:
  1. Load active subscriptions grouped by task id.
  2. Query `task_events` with `id > lastSeenId` for tasks that have active subscriptions on the current board.
  3. For each event, build payload, deliver to each subscription, advance cursor to `event.id`.

- [ ] **Step 3: Write watcher tests**

  In `tests/notifiers.test.ts`:
  - Mock transport and verify `log` output.
  - Verify cursor advances.
  - Verify archived task events are skipped (or subscriptions for archived tasks are skipped).
  - Verify no delivery when no subscriptions.

- [ ] **Step 4: Run watcher tests**

  Run:
  ```bash
  bun test ./tests/notifiers.test.ts
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/notifiers.ts tests/notifiers.test.ts
  git commit -m "feat(kdi-025): notifier transport handlers and watcher"
  ```

---

## Task 6: Dispatcher integration

**Files:**
- Modify: `src/dispatcher.ts`

- [ ] **Step 1: Import watcher**

  Add:
  ```ts
  import { FF_NOTIFY_SUBS } from "./flags";
  import { runNotifierWatcher, getLastSeenEventId, setLastSeenEventId } from "./notifiers";
  ```

- [ ] **Step 2: Add watcher call in tick loop**

  In the main `tick()` function, after processing ready tasks (or at the end), when `isEnabled(FF_NOTIFY_SUBS)`:
  ```ts
  const boardSlug = getBoardSlug(...); // obtain from current board context
  const lastSeen = getLastSeenEventId(boardSlug);
  const newLastSeen = await runNotifierWatcher(boardSlug, lastSeen);
  setLastSeenEventId(boardSlug, newLastSeen);
  ```

  The dispatcher tick already has a board context; pass the board slug from the tick invocation. If the tick is board-scoped, use that slug. If global, run watcher per board with active subscriptions.

- [ ] **Step 3: Add dispatcher integration test**

  In `tests/dispatcher.test.ts` or `tests/notifiers.test.ts`, verify that running a tick delivers a `completed` event notification to a `log` subscriber.

- [ ] **Step 4: Run dispatcher tests**

  Run:
  ```bash
  bun test ./tests/dispatcher.test.ts
  bun run lint
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/dispatcher.ts tests/dispatcher.test.ts
  git commit -m "feat(kdi-025): integrate notifier watcher into dispatcher tick"
  ```

---

## Task 7: Final verification and docs

**Files:**
- Modify: `STATUS.md`
- Modify: `specs/hermes-kanban-backlog.md`

- [ ] **Step 1: Run full verification**

  Run in the worktree:
  ```bash
  bun install
  bun run lint
  bun run test
  bun run build
  ```
  Expected: lint and build pass. Tests pass (run affected tests in isolation if full-suite flakes occur; document persistent flakes in STATUS.md Tech Debt).

- [ ] **Step 2: Update STATUS.md**

  Add a KDI-025 Done section mirroring other features, covering:
  - BRD, feature flag, schema, model, CLI commands, notifier registry, transport handlers, watcher, dispatcher integration, tests.

- [ ] **Step 3: Update backlog spec**

  In `specs/hermes-kanban-backlog.md`, mark KDI-025 as `[x]` and update the feature mapping table.

- [ ] **Step 4: Commit**

  ```bash
  git add STATUS.md specs/hermes-kanban-backlog.md
  git commit -m "docs(kdi-025): mark feature complete in STATUS and backlog"
  ```

---

## Acceptance criteria (final verification)

- [ ] `FF_NOTIFY_SUBS=true kdi notify-subscribe 42 --platform telegram --chat-id -1001234567` creates subscription and emits `subscribed` event.
- [ ] Duplicate subscription rejected with correct message.
- [ ] Thread-scoped subscription separate from no-thread subscription.
- [ ] Invalid platform and missing notifier profile rejected.
- [ ] `kdi notify-list`, `kdi notify-list 42`, `kdi notify-list --archived`, `kdi notify-list --json` all work.
- [ ] `kdi notify-unsubscribe` thread-scoped and broad modes work.
- [ ] Flag disabled rejects all three commands with `"Notification subscriptions feature is not enabled."`.
- [ ] Notifier watcher delivers events via `log` transport.
- [ ] Dispatcher tick runs watcher when flag enabled.
- [ ] `bun run lint`, `bun run test`, `bun run build` pass.
