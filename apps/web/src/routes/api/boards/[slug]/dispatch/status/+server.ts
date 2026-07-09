import { apiGet } from "$lib/server/handler";
import { dispatchStatusJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => dispatchStatusJson(e.params.slug));
