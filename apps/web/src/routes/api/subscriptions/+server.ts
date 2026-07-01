import { apiGet } from "$lib/server/handler";
import { subscriptionsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => subscriptionsJson(e.url.searchParams));