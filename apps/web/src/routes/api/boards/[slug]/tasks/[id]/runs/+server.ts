import { apiGet } from "$lib/server/handler";
import { taskRunsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => taskRunsJson(e.params.slug, Number(e.params.id), e.url.searchParams));