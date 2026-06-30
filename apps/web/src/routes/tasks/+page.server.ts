import { fail } from "@sveltejs/kit";
import { initDb } from "~/db";
import { isEnabled, FF_BULK_OPERATIONS, FF_SCHEDULED_STATUS } from "~/flags";
import type { Actions, PageServerLoad } from "./$types";
import { applyBulkAction, loadTaskList, resolveBoardSlug } from "$lib/server/taskActions";

export const load: PageServerLoad = async ({ url }) => {
  if (process.env.FF_SVELTEKIT_FRONTEND !== "true") {
    return { enabled: false };
  }
  initDb();
  const boardSlug = resolveBoardSlug(
    url.searchParams.get("board"),
    process.env.KDI_BOARD
  );
  const { board, tasks } = loadTaskList(boardSlug);
  const capabilities = {
    bulk: isEnabled(FF_BULK_OPERATIONS),
    schedule: isEnabled(FF_SCHEDULED_STATUS),
  };
  if (!board) {
    return {
      enabled: true,
      board: null,
      tasks: [],
      boardSlug,
      capabilities,
      error: "Board not found",
    };
  }
  return {
    enabled: true,
    board,
    tasks,
    boardSlug,
    capabilities,
  };
};

export const actions: Actions = {
  default: async ({ request, url }) => {
    if (process.env.FF_SVELTEKIT_FRONTEND !== "true") {
      return fail(403, { error: "SvelteKit UI is disabled." });
    }
    initDb();

    const formData = await request.formData();
    const action = String(formData.get("_action") ?? "");
    if (!action) {
      return fail(400, { error: "Missing _action field." });
    }

    const boardSlug = resolveBoardSlug(
      url.searchParams.get("board"),
      process.env.KDI_BOARD
    );

    const selected = formData
      .getAll("selected")
      .map((v) => Number(String(v)))
      .filter((n) => !Number.isNaN(n) && n > 0);

    if (selected.length === 0) {
      return fail(400, { error: "No tasks selected." });
    }

    const result = applyBulkAction(action, selected, formData);
    return { action, boardSlug, ...result };
  },
};
