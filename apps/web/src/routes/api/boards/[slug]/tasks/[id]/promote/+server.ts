// KDI-UI-006 single-task promote. Action is in the URL path; body is the action
// fields. Models stay behind performTaskAction (single choke point).
import { apiPost } from "$lib/server/handler";
import { performTaskAction } from "$lib/server/bridge";
import type { LifecycleFields } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = apiPost(
  (e, body: LifecycleFields) => performTaskAction(e.params.slug, Number(e.params.id), "promote", body ?? {}),
  200,
);
