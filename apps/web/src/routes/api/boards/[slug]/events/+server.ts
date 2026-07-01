import { apiGet } from "$lib/server/handler";
import { boardEventsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => boardEventsJson(e.params.slug, e.url.searchParams));