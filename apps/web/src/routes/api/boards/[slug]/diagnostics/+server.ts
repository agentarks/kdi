import { apiGet } from "$lib/server/handler";
import { diagnosticsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => diagnosticsJson(e.params.slug, e.url.searchParams));