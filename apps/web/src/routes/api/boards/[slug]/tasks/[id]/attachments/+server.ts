import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, taskAttachmentsJson } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await taskAttachmentsJson(event.params.slug, Number(event.params.id)));
  } catch (e) {
    return errorResponse(e);
  }
};