import { apiGet } from "$lib/server/handler";
import { taskHandoffJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) =>
  taskHandoffJson(e.params.slug, Number(e.params.id)),
);
