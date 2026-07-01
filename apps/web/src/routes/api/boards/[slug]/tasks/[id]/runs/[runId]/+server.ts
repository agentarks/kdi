import { apiGet } from "$lib/server/handler";
import { showRunJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => showRunJson(e.params.slug, Number(e.params.id), Number(e.params.runId)));