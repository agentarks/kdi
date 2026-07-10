import { apiGet } from "$lib/server/handler";
import { taskDependenciesJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) =>
  taskDependenciesJson(e.params.slug, Number(e.params.id)),
);
