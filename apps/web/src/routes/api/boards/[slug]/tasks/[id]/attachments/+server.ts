import { apiGet } from "$lib/server/handler";
import { taskAttachmentsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet((e) => taskAttachmentsJson(e.params.slug, Number(e.params.id)));