import { apiGet } from "$lib/server/handler";
import { taskEventsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => taskEventsJson(e.params.slug, Number(e.params.id), e.url.searchParams));