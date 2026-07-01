import { apiGet } from "$lib/server/handler";
import { assigneesJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => assigneesJson(e.params.slug));