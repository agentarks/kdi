import type { PageServerLoad } from "./$types";
import { taskDetailJson, detailFlags, readCurrentBoardJson, BridgeError } from "$lib/server/bridge";
import { error } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ params, url }) => {
  const id = Number(params.id);
  const boardSlug = url.searchParams.get("board") ?? (await readCurrentBoardJson());
  if (!boardSlug) {
    throw error(400, "Board slug is required via ?board or a current board.");
  }
  try {
    const detail = await taskDetailJson(boardSlug, id);
    return { detail, flags: detailFlags(), boardSlug };
  } catch (err) {
    if (err instanceof BridgeError && (err.code === "task_not_found" || err.code === "board_not_found")) {
      throw error(404, err.message);
    }
    throw err;
  }
};
