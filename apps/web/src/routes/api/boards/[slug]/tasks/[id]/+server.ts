import { apiGet } from "$lib/server/handler";
import { showTaskJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => showTaskJson(e.params.slug, Number(e.params.id)));