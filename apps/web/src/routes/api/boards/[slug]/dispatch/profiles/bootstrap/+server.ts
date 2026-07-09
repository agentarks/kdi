import { apiPost } from "$lib/server/handler";
import { bootstrapProfilesJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = apiPost((e, body: { force?: boolean }) =>
  bootstrapProfilesJson(e.params.slug, body.force === true),
);
