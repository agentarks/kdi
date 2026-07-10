import { apiGet } from "$lib/server/handler";
import { taskDetailJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => taskDetailJson(e.params.slug, Number(e.params.id)));
