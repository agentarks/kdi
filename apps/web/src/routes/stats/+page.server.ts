// KDI-UI-009 Slice 1: read-only /stats loader. Thin wrapper around the
// testable loadStatsPage resolver (see $lib/server/statsPage.ts). Route files
// must NOT import bun:sqlite or ~/models/*; everything goes through the bridge.
import type { PageServerLoad } from "./$types";
import { loadStatsPage } from "$lib/server/statsPage";

export const load: PageServerLoad = async ({ url }) => loadStatsPage(url);
