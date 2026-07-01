import { apiGet } from "$lib/server/handler";
import { boardStatsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => boardStatsJson(e.params.slug));