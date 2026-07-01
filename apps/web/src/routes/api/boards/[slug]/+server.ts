import { apiGet } from "$lib/server/handler";
import { showBoardJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => showBoardJson(e.params.slug));