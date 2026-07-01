import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, workflowsJson } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await workflowsJson(event.params.slug));
  } catch (e) {
    return errorResponse(e);
  }
};