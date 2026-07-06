import { apiGet } from "$lib/server/handler";
import { listProfilesJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = apiGet(() => listProfilesJson());
