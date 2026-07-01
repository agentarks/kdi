import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, showRunJson } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await showRunJson(event.params.slug, Number(event.params.id), Number(event.params.runId)));
  } catch (e) {
    return errorResponse(e);
  }
};