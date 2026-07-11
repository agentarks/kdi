// KDI-UI-006 single-task lifecycle action dispatcher.
// POST { action, fields } → { result }. Routes import models ONLY through the
// bridge; this file holds no bun:sqlite or ~/models/* import.
import { apiPost } from "$lib/server/handler";
import { performTaskAction } from "$lib/server/bridge";
import type { LifecycleAction, LifecycleFields } from "$lib/types";
import type { RequestHandler } from "./$types";

interface ActionBody {
  action: LifecycleAction;
  fields?: LifecycleFields;
}

export const POST: RequestHandler = apiPost(
  (e, body: ActionBody) =>
    performTaskAction(e.params.slug, Number(e.params.id), body.action, body.fields ?? {}),
  200,
);
