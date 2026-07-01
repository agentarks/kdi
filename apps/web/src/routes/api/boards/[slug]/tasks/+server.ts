import { apiGet, apiPost } from "$lib/server/handler";
import { listTasksJson, createTaskJson, type CreateTaskBody } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => listTasksJson(e.params.slug, e.url.searchParams));
export const POST: RequestHandler = apiPost((e, body: CreateTaskBody) => createTaskJson(e.params.slug, body));