import { apiGet } from "$lib/server/handler";
import { workflowsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => workflowsJson(e.params.slug));