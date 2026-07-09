import type { PageServerLoad } from "./$types";
import {
  showBoardJson,
  dispatchStatusJson,
  dispatchFlags,
  readCurrentBoardJson,
  BridgeError,
} from "$lib/server/bridge";

export const load: PageServerLoad = async ({ url }) => {
  const slug = url.searchParams.get("board") ?? (await readCurrentBoardJson()) ?? "default";

  try {
    const [boardResult, status] = await Promise.all([
      showBoardJson(slug),
      dispatchStatusJson(slug),
    ]);
    return {
      board: boardResult.board,
      status,
      flags: dispatchFlags(),
    };
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { error: err.message, flags: dispatchFlags() };
    }
    throw err;
  }
};
