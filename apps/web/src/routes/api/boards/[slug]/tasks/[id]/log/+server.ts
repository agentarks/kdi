import { apiGet } from "$lib/server/handler";
import { taskLogJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) =>
  taskLogJson(e.params.slug, Number(e.params.id), e.url.searchParams),
);
