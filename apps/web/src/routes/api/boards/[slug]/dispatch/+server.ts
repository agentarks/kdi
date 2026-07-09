import { apiPost } from "$lib/server/handler";
import { dispatchOnceJson, type DispatchTrigger } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = apiPost((e, body: DispatchTrigger) => dispatchOnceJson(e.params.slug, body));
