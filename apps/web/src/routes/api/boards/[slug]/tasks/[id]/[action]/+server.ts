// KDI-UI-006 single-task lifecycle action dispatcher.
//
// One dynamic route replaces twelve identical adapter files. The action is in
// the URL path; the body is the action fields. Unknown actions get 404.
// Static sibling routes (comments, events, runs, etc.) take precedence over
// this [action] param, so there is no collision.
//
// Routes import models ONLY through the bridge (AC-27).
import { apiPost } from "$lib/server/handler";
import { performTaskAction, SINGLE_LIFECYCLE_ACTIONS, BridgeError } from "$lib/server/bridge";
import type { LifecycleAction, LifecycleFields } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = apiPost((e, body: LifecycleFields) => {
  const action = e.params.action as LifecycleAction;
  if (!SINGLE_LIFECYCLE_ACTIONS.has(action))
    throw new BridgeError("invalid_action", 404, `Unknown action "${e.params.action}".`);
  return performTaskAction(e.params.slug, Number(e.params.id), action, body ?? {});
}, 200);
