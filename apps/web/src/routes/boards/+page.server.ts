import { listBoardsUiJson, readCurrentBoardJson, boardUiFlags } from "$lib/server/bridge";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url }) => {
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const searchParams = new URLSearchParams();
  if (includeArchived) searchParams.set("includeArchived", "true");
  const [{ boards }, { currentSlug }] = await Promise.all([
    listBoardsUiJson(searchParams),
    readCurrentBoardJson(),
  ]);
  return { boards, includeArchived, currentSlug, flags: boardUiFlags() };
};
