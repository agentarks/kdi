// KDI-UI-010: board-scoped notification subscription list. Read-only table with
// a per-row unsubscribe action and an "Include unsubscribed" toggle. Board
// resolution mirrors KDI-UI-003: ?board= -> current board -> "default".
import { error, fail } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import {
  showBoardJson,
  subscriptionsJson,
  unsubscribeJson,
  readCurrentBoardJson,
  notifySubsFlags,
  isSvelteKitEnabled,
  BridgeError,
} from "$lib/server/bridge";

export const load: PageServerLoad = async ({ url }) => {
  if (!isSvelteKitEnabled()) throw error(404, "UI disabled");
  const flags = notifySubsFlags();
  const boardSlug = url.searchParams.get("board") ?? (await readCurrentBoardJson()) ?? "default";
  const includeArchived = url.searchParams.get("archived") === "1";

  if (!flags.notifySubs) {
    return { enabled: false, flags, boardSlug, includeArchived };
  }

  try {
    const { board } = await showBoardJson(boardSlug);
    const params = new URLSearchParams({ board: boardSlug });
    if (includeArchived) params.set("includeArchived", "true");
    const { subscriptions } = await subscriptionsJson(params);
    return { enabled: true, flags, board, boardSlug, includeArchived, subscriptions };
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { enabled: true, flags, boardSlug, includeArchived, error: err.message, subscriptions: [] };
    }
    throw err;
  }
};

export const actions: Actions = {
  unsubscribe: async ({ request, url }) => {
    if (!isSvelteKitEnabled() || !notifySubsFlags().notifySubs) {
      return fail(403, { error: "Notification subscriptions feature is not enabled." });
    }
    const data = await request.formData();
    const taskId = Number(data.get("task_id"));
    const platform = String(data.get("platform") ?? "");
    const chatId = String(data.get("chat_id") ?? "");
    const threadIdRaw = data.get("thread_id");
    const threadId = threadIdRaw !== null && String(threadIdRaw) !== "" ? String(threadIdRaw) : undefined;
    // Form action `?/unsubscribe` drops the page query string, so the board is
    // carried in a hidden form field (FR-17). Fall back to the URL param (for
    // direct API-style POSTs) then the current board.
    const boardField = data.get("board");
    const boardSlug = (boardField !== null && String(boardField) !== "" ? String(boardField) : url.searchParams.get("board")) ?? (await readCurrentBoardJson()) ?? "default";

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return fail(400, { error: "Invalid task id." });
    }
    try {
      const { unsubscribed } = await unsubscribeJson(boardSlug, taskId, platform, chatId, threadId);
      return { ok: true, unsubscribed };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
