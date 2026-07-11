// KDI-UI-010: per-task notification subscriptions. Lists the task's
// subscriptions and hosts the subscribe form + per-row unsubscribe. Subscribe
// validates via the model (getNotifier runs inside subscribe()), so error text
// matches the CLI verbatim.
import { error, fail } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import {
  showTaskJson,
  subscriptionsJson,
  subscribeJson,
  unsubscribeJson,
  readCurrentBoardJson,
  notifySubsFlags,
  isSvelteKitEnabled,
  BridgeError,
} from "$lib/server/bridge";

const VALID_PLATFORMS = ["telegram", "slack", "discord", "webhook"] as const;

function getField(data: FormData, name: string): string {
  const v = data.get(name);
  return v === null ? "" : v.toString().trim();
}

// Board resolution chain shared by load + both actions (FR-17): ?board= ->
// current board -> "default". One helper so the action mutations resolve the
// same board the load did, before assertTaskOnBoard runs inside the bridge.
async function resolveBoardSlug(url: URL): Promise<string> {
  return url.searchParams.get("board") ?? (await readCurrentBoardJson()) ?? "default";
}

export const load: PageServerLoad = async ({ params, url }) => {
  if (!isSvelteKitEnabled()) throw error(404, "UI disabled");
  const flags = notifySubsFlags();
  const id = Number(params.id);
  const boardSlug = await resolveBoardSlug(url);
  const includeArchived = url.searchParams.get("archived") === "1";

  if (!flags.notifySubs) {
    return { enabled: false, flags, boardSlug, taskId: id, includeArchived };
  }

  let task;
  try {
    ({ task } = await showTaskJson(boardSlug, id));
  } catch (err) {
    if (err instanceof BridgeError && (err.code === "task_not_found" || err.code === "board_not_found")) {
      throw error(404, err.message);
    }
    throw err;
  }

  const paramsQs = new URLSearchParams();
  paramsQs.set("taskId", String(id));
  if (includeArchived) paramsQs.set("includeArchived", "true");
  const { subscriptions } = await subscriptionsJson(paramsQs);
  return { enabled: true, flags, boardSlug, taskId: id, task, subscriptions, includeArchived };
};

export const actions: Actions = {
  subscribe: async ({ request, params, url }) => {
    const taskId = Number(params.id);
    if (!isSvelteKitEnabled() || !notifySubsFlags().notifySubs) {
      return fail(403, { error: "Notification subscriptions feature is not enabled." });
    }
    const boardSlug = await resolveBoardSlug(url);
    const data = await request.formData();
    const platform = getField(data, "platform").toLowerCase();
    const chatId = getField(data, "chat_id");
    const threadId = getField(data, "thread_id");
    const userId = getField(data, "user_id");
    const notifierProfileRaw = getField(data, "notifier_profile");

    const values = { platform, chat_id: chatId, thread_id: threadId, user_id: userId, notifier_profile: notifierProfileRaw };

    if (!Number.isInteger(taskId) || taskId <= 0) return fail(400, { error: "Invalid task id.", values });
    if (!(VALID_PLATFORMS as readonly string[]).includes(platform)) {
      return fail(400, { error: `Unsupported platform. Valid platforms: ${VALID_PLATFORMS.join(", ")}.`, values });
    }
    if (chatId === "") return fail(400, { error: "Chat id is required.", values });

    try {
      // Empty notifier profile -> undefined so the model defaults to the platform.
      await subscribeJson(boardSlug, taskId, platform, chatId, {
        threadId: threadId || undefined,
        userId: userId || undefined,
        notifierProfile: notifierProfileRaw || undefined,
      });
      return { ok: true, subscribed: true };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : String(err), values });
    }
  },

  unsubscribe: async ({ request, params, url }) => {
    const taskId = Number(params.id);
    if (!isSvelteKitEnabled() || !notifySubsFlags().notifySubs) {
      return fail(403, { error: "Notification subscriptions feature is not enabled." });
    }
    const boardSlug = await resolveBoardSlug(url);
    const data = await request.formData();
    const platform = getField(data, "platform");
    const chatId = getField(data, "chat_id");
    const threadIdRaw = data.get("thread_id");
    const threadId = threadIdRaw !== null && String(threadIdRaw) !== "" ? String(threadIdRaw) : undefined;

    if (!Number.isInteger(taskId) || taskId <= 0) return fail(400, { error: "Invalid task id." });
    try {
      const { unsubscribed } = await unsubscribeJson(boardSlug, taskId, platform, chatId, threadId);
      return { ok: true, unsubscribed };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
