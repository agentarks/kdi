import { Command } from "commander";
import { subscribe, listSubscriptions, unsubscribe } from "../models/notifySub";
import { showBoard } from "../models/board";
import { resolveBoard } from "../resolveBoard";
import { isEnabled, FF_NOTIFY_SUBS } from "../flags";

const VALID_PLATFORMS = ["telegram", "slack", "discord", "webhook"];

function requireFlag(): void {
  if (!isEnabled(FF_NOTIFY_SUBS)) {
    console.error("Notification subscriptions feature is not enabled.");
    process.exit(1);
  }
}

function parseTaskId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid task id: ${value}`);
  }
  return id;
}

function validatePlatform(platform: string): string {
  const normalized = platform.toLowerCase().trim();
  if (!VALID_PLATFORMS.includes(normalized)) {
    throw new Error(
      `Unsupported platform. Valid platforms: ${VALID_PLATFORMS.join(", ")}.`
    );
  }
  return normalized;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export const notifySubscribeCommand = new Command("notify-subscribe")
  .description("Subscribe to notifications for a task")
  .argument("<task_id>", "Task id")
  .requiredOption("--platform <name>", "Messaging platform (telegram, slack, discord, webhook)")
  .requiredOption("--chat-id <id>", "Recipient identifier")
  .option("--thread-id <id>", "Thread or topic id")
  .option("--user-id <id>", "User mention")
  .option("--notifier-profile <name>", "Notifier profile that delivers the notification")
  .action((taskIdArg: string, options: {
    platform: string;
    chatId: string;
    threadId?: string;
    userId?: string;
    notifierProfile?: string;
  }) => {
    try {
      requireFlag();

      const taskId = parseTaskId(taskIdArg);
      const platform = validatePlatform(options.platform);
      const chatId = options.chatId.trim();
      const notifierProfile = (options.notifierProfile ?? platform).trim();

      const sub = subscribe(taskId, platform, chatId, {
        threadId: options.threadId,
        userId: options.userId,
        notifierProfile,
      });

      console.log(`Subscribed ${sub.id}`);
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });

export const notifyListCommand = new Command("notify-list")
  .description("List notification subscriptions")
  .argument("[task_id]", "Optional task id to filter by")
  .option("--board <slug>", "Board slug (resolved via chain)")
  .option("--archived", "Include unsubscribed subscriptions")
  .option("--json", "Output as JSON")
  .action((taskIdArg: string | undefined, options: {
    board?: string;
    archived?: boolean;
    json?: boolean;
  }) => {
    try {
      requireFlag();

      const taskId = taskIdArg !== undefined ? parseTaskId(taskIdArg) : undefined;
      let boardId: number | undefined;

      if (taskId === undefined) {
        const boardSlug = resolveBoard(options.board);
        const board = showBoard(boardSlug, false);
        if (!board) {
          throw new Error(`Board "${boardSlug}" not found or is archived.`);
        }
        boardId = board.id;
      }

      const subs = listSubscriptions(taskId, options.archived ?? false, boardId);

      if (options.json) {
        console.log(JSON.stringify(subs, null, 2));
        return;
      }

      if (subs.length === 0) {
        console.log("No subscriptions found.");
        return;
      }

      console.log(
        "ID".padEnd(5) +
          "Task".padEnd(6) +
          "Platform".padEnd(10) +
          "Chat ID".padEnd(15) +
          "Thread ID".padEnd(12) +
          "Profile".padEnd(12) +
          "Subscribed At"
      );
      for (const sub of subs) {
        console.log(
          String(sub.id).padEnd(5) +
            String(sub.task_id).padEnd(6) +
            sub.platform.padEnd(10) +
            sub.chat_id.padEnd(15) +
            (sub.thread_id ?? "").padEnd(12) +
            sub.notifier_profile.padEnd(12) +
            formatDate(sub.subscribed_at)
        );
      }
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });

export const notifyUnsubscribeCommand = new Command("notify-unsubscribe")
  .description("Unsubscribe from notifications for a task")
  .argument("<task_id>", "Task id")
  .requiredOption("--platform <name>", "Messaging platform")
  .requiredOption("--chat-id <id>", "Recipient identifier")
  .option("--thread-id <id>", "Thread or topic id")
  .action((taskIdArg: string, options: {
    platform: string;
    chatId: string;
    threadId?: string;
  }) => {
    try {
      requireFlag();

      const taskId = parseTaskId(taskIdArg);
      const platform = validatePlatform(options.platform);
      const chatId = options.chatId.trim();

      const count = unsubscribe(taskId, platform, chatId, options.threadId);
      console.log(`Unsubscribed ${count} subscription(s).`);
    } catch (err: any) {
      console.error(err.message || String(err));
      process.exit(1);
    }
  });
