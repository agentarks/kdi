import type { PageServerLoad } from "./$types";
import { showBoardJson, readCurrentBoardJson, activityFlags, BridgeError } from "$lib/server/bridge";

export const load: PageServerLoad = async ({ url }) => {
  const slug = url.searchParams.get("board") ?? (await readCurrentBoardJson());
  const flags = activityFlags();
  if (!slug) {
    return { error: "No board selected.", flags };
  }
  try {
    const { board } = await showBoardJson(slug, false);
    return { board, flags };
  } catch (err) {
    if (err instanceof BridgeError && err.code === "board_not_found") {
      return { error: err.message, flags };
    }
    throw err;
  }
};
