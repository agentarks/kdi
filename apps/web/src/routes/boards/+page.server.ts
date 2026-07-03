// ponytail: kept `/boards` as the list route instead of a bare-board detail route.
// The original AC-04 described `/boards` resolving `readCurrentBoard()` and rendering
// the current board's detail, but a list is a more useful landing page and is required
// by AC-01/AC-02. The current board is highlighted with a "Current" badge in the list;
// detail is served by `/boards/[slug]`. See specs/sveltekit-ui/KDI-UI-002-board-management.md.
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
