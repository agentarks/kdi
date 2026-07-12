// KDI-UI-006 bulk lifecycle action dispatcher.
// POST { action, taskIds, fields } → { results, summary }. Models stay behind
// the bridge; this route only parses and forwards.
import { apiPost } from "$lib/server/handler";
import { performBulkAction, BridgeError } from "$lib/server/bridge";
import type { LifecycleAction, LifecycleFields } from "$lib/types";
import type { RequestHandler } from "./$types";

interface BulkBody {
  action: LifecycleAction;
  taskIds: number[];
  fields?: LifecycleFields;
}

export const POST: RequestHandler = apiPost(
  (e, body: BulkBody) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw new BridgeError("invalid_input", 400, "Body must be an object.");
    if (typeof body.action !== "string")
      throw new BridgeError("invalid_input", 400, "action is required.");
    return performBulkAction(e.params.slug, body.action, body.taskIds ?? [], body.fields ?? {});
  },
  200,
);
