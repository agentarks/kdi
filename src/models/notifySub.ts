import { getDb } from "../db";
import { showTask } from "./task";
import { addEvent } from "./taskEvent";
import { getNotifier } from "../notifiers";

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

export function subscribe(
  taskId: number,
  platform: string,
  chatId: string,
  options: SubscribeOptions = {}
): NotifySub {
  const db = getDb();

  const task = showTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  const normalizedPlatform = platform.toLowerCase().trim();
  if (!["telegram", "slack", "discord", "webhook"].includes(normalizedPlatform)) {
    throw new Error(
      `Unsupported platform. Valid platforms: telegram, slack, discord, webhook.`
    );
  }

  const notifierProfile = (options.notifierProfile ?? normalizedPlatform).trim();
  getNotifier(notifierProfile);

  const threadId = options.threadId?.trim() ?? null;
  const userId = options.userId?.trim() ?? null;

  const existingNullThread = db.query(
    `SELECT id FROM kanban_notify_subs
     WHERE task_id = ? AND platform = ? AND chat_id = ? AND thread_id IS NULL AND unsubscribed_at IS NULL`
  ).get(taskId, normalizedPlatform, chatId) as { id: number } | undefined;

  if (threadId === null) {
    if (existingNullThread) {
      throw new Error(
        `A subscription for this task + platform + chat already exists (no thread). Use --thread-id to add a thread-scoped subscription.`
      );
    }
  } else {
    const existingThread = db.query(
      `SELECT id FROM kanban_notify_subs
       WHERE task_id = ? AND platform = ? AND chat_id = ? AND thread_id = ? AND unsubscribed_at IS NULL`
    ).get(taskId, normalizedPlatform, chatId, threadId) as { id: number } | undefined;

    if (existingThread) {
      throw new Error(
        `A subscription for this task + platform + chat + thread already exists.`
      );
    }
  }

  const result = db.run(
    `INSERT INTO kanban_notify_subs (task_id, platform, chat_id, thread_id, user_id, notifier_profile)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [taskId, normalizedPlatform, chatId, threadId, userId, notifierProfile]
  );

  const sub = db.query(
    `SELECT id, task_id, platform, chat_id, thread_id, user_id, notifier_profile, subscribed_at, unsubscribed_at
     FROM kanban_notify_subs WHERE id = ?`
  ).get(Number(result.lastInsertRowid)) as NotifySub | undefined;

  if (!sub) {
    throw new Error("Subscription not found after insert");
  }

  addEvent(taskId, "subscribed", { platform: normalizedPlatform, chat_id: chatId, thread_id: threadId });
  return sub;
}

export function listSubscriptions(
  taskId?: number,
  includeArchived?: boolean,
  boardId?: number
): NotifySub[] {
  const db = getDb();

  if (taskId !== undefined) {
    const conditions = ["task_id = ?"];
    const params: (number | null)[] = [taskId];
    if (!includeArchived) {
      conditions.push("unsubscribed_at IS NULL");
    }
    return db.query(
      `SELECT id, task_id, platform, chat_id, thread_id, user_id, notifier_profile, subscribed_at, unsubscribed_at
       FROM kanban_notify_subs
       WHERE ${conditions.join(" AND ")}
       ORDER BY subscribed_at DESC`
    ).all(...params) as NotifySub[];
  }

  if (boardId === undefined) {
    throw new Error("A board id is required to list subscriptions without a task id.");
  }

  const conditions = ["t.board_id = ?"];
  const params: (number | null)[] = [boardId];
  if (!includeArchived) {
    conditions.push("s.unsubscribed_at IS NULL");
  }

  return db.query(
    `SELECT s.id, s.task_id, s.platform, s.chat_id, s.thread_id, s.user_id, s.notifier_profile, s.subscribed_at, s.unsubscribed_at
     FROM kanban_notify_subs s
     JOIN tasks t ON t.id = s.task_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.subscribed_at DESC`
  ).all(...params) as NotifySub[];
}

export function unsubscribe(
  taskId: number,
  platform: string,
  chatId: string,
  threadId?: string
): number {
  const db = getDb();
  const normalizedPlatform = platform.toLowerCase().trim();

  if (threadId !== undefined) {
    const result = db.run(
      `UPDATE kanban_notify_subs
       SET unsubscribed_at = unixepoch()
       WHERE task_id = ? AND platform = ? AND chat_id = ? AND thread_id = ? AND unsubscribed_at IS NULL`,
      [taskId, normalizedPlatform, chatId, threadId.trim()]
    );

    if (result.changes === 0) {
      throw new Error("No active subscription found for the given parameters.");
    }

    addEvent(taskId, "unsubscribed", {
      platform: normalizedPlatform,
      chat_id: chatId,
      thread_id: threadId.trim(),
      count: result.changes,
    });
    return result.changes;
  }

  const result = db.run(
    `UPDATE kanban_notify_subs
     SET unsubscribed_at = unixepoch()
     WHERE task_id = ? AND platform = ? AND chat_id = ? AND unsubscribed_at IS NULL`,
    [taskId, normalizedPlatform, chatId]
  );

  if (result.changes === 0) {
    throw new Error("No active subscription found for the given parameters.");
  }

  addEvent(taskId, "unsubscribed", {
    platform: normalizedPlatform,
    chat_id: chatId,
    thread_id: null,
    count: result.changes,
  });
  return result.changes;
}
