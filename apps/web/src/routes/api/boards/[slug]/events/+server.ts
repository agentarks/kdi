import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gate, errorResponse, boardEventsJson } from "$lib/server/bridge";

export const GET: RequestHandler = async (event) => {
  const disabled = gate();
  if (disabled) return disabled;
  try {
    return json(await boardEventsJson(event.params.slug, event.url.searchParams));
  } catch (e) {
    return errorResponse(e);
  }
};