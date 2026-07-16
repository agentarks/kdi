// KDI-UI-013 Slice 3: workflow step action dispatcher.
//
// One static route serves both advance and jump (FR-18). The operation is in
// the JSON body (`{ action: "advance" | "jump", targetKey?, reason? }`) so the
// task-detail panel can post either from a single control cluster. Static
// `step` segment takes precedence over the sibling `[action]` param route, so
// there is no collision with the KDI-UI-006 lifecycle dispatcher.
//
// `apiPost` applies the master `FF_SVELTEKIT_FRONTEND` gate; the bridge helpers
// re-check `FF_WORKFLOW_TEMPLATES` (FR-24). Routes import models ONLY through
// the bridge (AC-27 / FR-29).
import { apiPost } from "$lib/server/handler";
import { advanceTaskStepJson, setTaskStepJson, BridgeError } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

interface StepBody {
  action?: string;
  targetKey?: string;
  reason?: string;
}

export const POST: RequestHandler = apiPost((e, body: StepBody) => {
  const id = Number(e.params.id);
  if (!Number.isInteger(id) || id <= 0)
    throw new BridgeError("invalid_input", 400, "Task ID must be a positive integer.");
  const action = body?.action;
  if (action === "advance") {
    return advanceTaskStepJson(e.params.slug, id, body.reason);
  }
  if (action === "jump") {
    if (typeof body.targetKey !== "string" || body.targetKey.trim() === "")
      throw new BridgeError("invalid_input", 400, "Step key cannot be empty.");
    return setTaskStepJson(e.params.slug, id, body.targetKey, body.reason);
  }
  throw new BridgeError("invalid_action", 400, `Unknown step action "${action ?? ""}". Use "advance" or "jump".`);
}, 200);