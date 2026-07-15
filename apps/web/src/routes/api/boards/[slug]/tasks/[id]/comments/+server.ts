import { apiGet, apiPost } from "$lib/server/handler";
import { addCommentJson, BridgeError, taskCommentsJson } from "$lib/server/bridge";
import type { RequestHandler } from "./$types";

function taskId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0)
    throw new BridgeError("invalid_input", 400, "Task ID must be a positive integer.");
  return id;
}

export const GET: RequestHandler = apiGet((e) => taskCommentsJson(e.params.slug, taskId(e.params.id)));
export const POST: RequestHandler = apiPost((e, body: { text: string }) =>
  addCommentJson(e.params.slug, taskId(e.params.id), body),
);
